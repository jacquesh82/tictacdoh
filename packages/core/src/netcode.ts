import {
  FrameKind,
  INPUT_REDUNDANCY_BLE,
  INPUT_REDUNDANCY_DEFAULT,
  MAX_INPUT_REDUNDANCY,
  MAX_PLAYERS,
  Reader,
  Writer,
  inputFrameCodec,
  tickBatchCodec,
} from '@ttd/wire'
import { Emitter, type Unsubscribe } from './emitter.js'
import type { Session } from './session.js'
import type { PeerId, Seat, TransportCaps } from './transport.js'

/** Inputs de tous les joueurs pour un tick, indexés par siège. */
export type TickInputs = (Uint8Array | undefined)[]

export interface NetcodeEvents extends Record<string, unknown> {
  /** Un tick est confirmé et prêt à être simulé, à l'identique chez tous. */
  tick: { tick: number; inputs: TickInputs }
  /** Un pair a divergé : il lui faut un keyframe. */
  'keyframe-request': { to: PeerId }
  /** Un keyframe est arrivé : l'état local doit être remplacé. */
  keyframe: { tick: number; state: Uint8Array }
  desync: { peer: PeerId; tick: number }
  /** Le réglage de manche a changé (délai d'input, rotation). */
  config: { inputDelayTicks: number; rotations: number }
  /**
   * L'hôte a lancé une manche. Émis chez tout le monde, l'hôte compris, pour
   * que les deux chemins — décider et subir — passent par le même code.
   */
  'match-start': { seed: number; gameId: string; atTick: number; rotations: number }
}

export interface NetcodeOptions {
  readonly session: Session
  /** Octets d'input par joueur et par tick. Vient du mini-jeu. */
  readonly inputBytes: number
  /**
   * Capacités du lien. Détermine la cadence réseau et la redondance : c'est ce
   * qui permet au même mini-jeu de tourner sur BLE et sur WebRTC sans une
   * ligne de code spécifique.
   */
  readonly caps?: TransportCaps
  /** Cadence de simulation, en hertz. Indépendante de la cadence réseau. */
  readonly tickRate?: number
  /** Cadence réseau. Déduite de `caps` si absente. */
  readonly netRate?: number
  readonly hashIntervalTicks?: number

  /**
   * Format d'input du mini-jeu désigné par `gameId`.
   *
   * Appelé au lancement d'une manche, avant que le premier tick ne parte.
   *
   * Sans cela, `inputBytes` et `tickRate` étaient figés à la construction — or
   * le netcode doit exister *avant* la manche pour recevoir l'ordre de départ,
   * c'est-à-dire à un moment où un pair qui rejoint ignore encore à quoi on va
   * jouer. Le premier mini-jeu à ne pas tenir sur un octet aurait fait échouer
   * chaque envoi d'input sur une erreur de longueur.
   *
   * Rend `undefined` si l'identifiant est inconnu : les réglages en cours sont
   * alors conservés, et c'est au contrôle d'empreinte de signaler que les pairs
   * ne simulent pas la même chose.
   */
  readonly gameParams?: (gameId: string) => { inputBytes: number; tickRate: number } | undefined
}

/**
 * Cadence réseau tenable sur un lien donné.
 *
 * Le budget BLE ne laisse pas passer 30 Hz (voir les tests de budget de
 * `@ttd/wire`). Plutôt que d'imposer la même cadence partout, on la déduit du
 * débit : la simulation reste à 30 Hz et chaque envoi porte plusieurs ticks.
 */
export function netRateFor(caps: TransportCaps): number {
  if (caps.throughputBytesPerSec < 4000) return 15
  if (caps.throughputBytesPerSec < 32_000) return 20
  return 30
}

/** Espacement minimal entre deux demandes de resynchronisation. */
const RESYNC_INTERVAL_MS = 2000

/** Redondance tenable sur un lien donné. */
export function redundancyFor(caps: TransportCaps): number {
  return caps.throughputBytesPerSec < 4000 ? INPUT_REDUNDANCY_BLE : INPUT_REDUNDANCY_DEFAULT
}

/**
 * Séquencement des inputs par l'hôte.
 *
 * L'hôte fait autorité sur *l'ordre des inputs*, pas sur la diffusion de
 * l'état. Chaque pair simule localement les mêmes inputs dans le même ordre,
 * et obtient donc le même état. Trois conséquences, toutes voulues :
 *
 * - **Le budget tient sur BLE.** On transmet des inputs, jamais des états.
 *   Des instantanés ne passeraient pas dans les ~1500 o/s d'un lien Bluetooth.
 * - **La rotation d'hôte ne coûte rien.** L'état est déjà répliqué partout :
 *   le nouvel hôte reprend le séquencement, sans transfert.
 * - **L'hôte n'a aucun avantage de simulation.** Il ne décide que de l'ordre,
 *   et le délai d'input lui est appliqué comme aux autres.
 *
 * En contrepartie, les mini-jeux doivent être déterministes : virgule fixe,
 * `Rng` seedé, ni `Math.random` ni `Date.now`.
 */
export class Netcode {
  readonly #events = new Emitter<NetcodeEvents>()
  readonly #session: Session
  #inputBytes: number
  #tickRate: number
  readonly #netRate: number
  readonly #redundancy: number
  readonly #hashIntervalTicks: number

  #inputCodec: ReturnType<typeof inputFrameCodec>
  #batchCodec: ReturnType<typeof tickBatchCodec>

  /** Inputs locaux explicitement soumis, par tick. */
  readonly #localInputs = new Map<number, Uint8Array>()
  /** Inputs reçus des joueurs, par tick puis par siège. Vue de l'hôte. */
  readonly #collected = new Map<number, Map<Seat, Uint8Array>>()
  /** Dernier input connu par siège, et jusqu'à quel tick le prolonger. */
  readonly #lastKnown = new Map<Seat, { input: Uint8Array; untilTick: number }>()
  /** Ticks confirmés reçus de l'hôte, en attente de simulation. */
  readonly #confirmed = new Map<number, TickInputs>()
  readonly #hashes = new Map<number, number>()
  readonly #unsubscribes: Unsubscribe[] = []

  #latestInput: Uint8Array
  #currentTick = 0
  #simulatedTick = -1
  #lastSequencedTick = -1
  #inputDelayTicks = 3
  #lastNetSendMs = Number.NEGATIVE_INFINITY
  #lastResyncMs = Number.NEGATIVE_INFINITY
  #resyncPending = false
  #running = false
  readonly #gameParams: NetcodeOptions['gameParams']

  constructor(options: NetcodeOptions) {
    this.#session = options.session
    this.#inputBytes = options.inputBytes
    this.#tickRate = options.tickRate ?? 30

    const caps = options.caps ?? options.session.linkCaps
    this.#netRate = options.netRate ?? (caps ? netRateFor(caps) : 15)
    this.#redundancy = caps ? redundancyFor(caps) : INPUT_REDUNDANCY_BLE
    this.#hashIntervalTicks = options.hashIntervalTicks ?? 30
    this.#gameParams = options.gameParams

    this.#inputCodec = inputFrameCodec(options.inputBytes)
    this.#batchCodec = tickBatchCodec(options.inputBytes)
    this.#latestInput = new Uint8Array(options.inputBytes)

    this.#unsubscribes.push(
      options.session.on('frame', ({ from, payload }) => this.#onFrame(from, payload)),
    )
  }

  on<K extends keyof NetcodeEvents>(event: K, fn: (payload: NetcodeEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }

  get currentTick(): number {
    return this.#currentTick
  }

  get simulatedTick(): number {
    return this.#simulatedTick
  }

  get inputDelayTicks(): number {
    return this.#inputDelayTicks
  }

  get netRate(): number {
    return this.#netRate
  }

  /**
   * Ticks de simulation couverts par un envoi réseau.
   *
   * Vaut 2 sur BLE (30 Hz simulés, 15 Hz réseau). Sans ce découplage, réduire
   * la cadence réseau ralentirait le jeu lui-même au lieu de simplement
   * espacer les paquets.
   */
  get ticksPerSend(): number {
    return Math.max(1, Math.round(this.#tickRate / this.#netRate))
  }

  /**
   * Délai d'input, en ticks. Appliqué à **tout le monde, l'hôte compris**.
   *
   * Doit couvrir l'aller simple vers l'hôte *plus* l'espacement des envois :
   * un input qui arrive après que l'hôte a figé son tick est perdu, et le jeu
   * paraît ne pas répondre. La marge d'un tick absorbe la gigue.
   *
   * Calculé par l'hôte seul, puis diffusé : lui seul mesure l'aller-retour de
   * tous les joueurs, alors qu'un rayon ne voit que le hub. Sans cette
   * diffusion, chacun jouerait avec sa propre avance et l'équité tomberait.
   */
  computeInputDelay(): number {
    // Les RTT du roster sont ceux mesurés par le hub, donc à un saut. Si
    // l'autorité est un rayon, les inputs des autres joueurs font deux sauts
    // pour l'atteindre : hub compris. Oublier ce second saut fait arriver les
    // inputs relayés après que le tick soit figé — le jeu semble alors ignorer
    // les commandes de tout le monde sauf celles du hub.
    const relayMs = this.#session.isHub ? 0 : this.#session.hubRttMs
    const oneWayMs = (this.#session.worstRttMs() + relayMs) / 2
    const oneWayTicks = Math.ceil((oneWayMs / 1000) * this.#tickRate)
    return Math.max(3, Math.min(20, this.ticksPerSend + oneWayTicks + 1))
  }

  start(atTick = 0): void {
    this.#currentTick = atTick
    this.#simulatedTick = atTick - 1
    this.#lastSequencedTick = atTick - 1
    this.#running = true
    this.#lastNetSendMs = Number.NEGATIVE_INFINITY
    this.#resyncPending = false
    this.#localInputs.clear()
    this.#collected.clear()
    this.#lastKnown.clear()
    this.#confirmed.clear()
    this.#hashes.clear()
    this.#latestInput = new Uint8Array(this.#inputBytes)
    if (this.#session.isHost) {
      this.#inputDelayTicks = this.computeInputDelay()
      this.#publishConfig()
    }
  }

  stop(): void {
    this.#running = false
  }

  /**
   * Lance une manche pour toute la table. Réservé au créateur de la salle.
   *
   * Au créateur, et non à l'autorité de séquencement : celle-ci tourne à chaque
   * manche pour l'équité, si bien que le bouton « Lancer » aurait sauté d'un
   * joueur à l'autre sans raison lisible. Le lobby appartient à qui a ouvert la
   * salle, la partie à qui séquence — deux rôles distincts.
   *
   * Sans cet ordre unique, chaque joueur devait appuyer de son côté : les pairs
   * partaient à des instants différents et un retardataire attendait un tick
   * déjà figé. La graine voyage avec l'ordre — c'est elle qui garantit que les
   * obstacles tombent aux mêmes endroits chez tout le monde.
   */
  startMatch(options: { seed: number; gameId: string; atTick?: number }): void {
    if (!this.#session.isHub) {
      throw new Error('seul le créateur de la salle lance une manche')
    }
    const atTick = options.atTick ?? 0
    // Le compteur de rotations voyage avec l'ordre : c'est lui qui désigne
    // l'autorité de la manche. L'envoyer évite que deux pairs se croient hôtes
    // après une passation manquée, et permet à un retardataire de se caler.
    const rotations = this.#session.rotations

    const w = new Writer(64)
    w.u8(FrameKind.MatchStart)
    w.u32(options.seed >>> 0)
    w.varuint(atTick)
    w.varuint(rotations)
    w.str(options.gameId)
    this.#session.broadcast(w.finish(), 'bulk')

    this.#begin(options.seed >>> 0, options.gameId, atTick, rotations)
  }

  #onMatchStart(from: PeerId, payload: Uint8Array): void {
    // Seul le créateur de la salle peut lancer : accepter d'un autre pair
    // permettrait à n'importe qui de redémarrer la partie des autres.
    if (from !== this.#session.hubId) return
    const r = new Reader(payload)
    r.u8()
    const seed = r.u32()
    const atTick = r.varuint()
    const rotations = r.varuint()
    const gameId = r.str()
    this.#begin(seed, gameId, atTick, rotations)
  }

  /** Chemin commun à celui qui décide et à ceux qui suivent. */
  #begin(seed: number, gameId: string, atTick: number, rotations: number): void {
    this.#adoptGame(gameId)
    this.#session.syncRotations(rotations)
    this.start(atTick)
    this.#events.emit('match-start', { seed, gameId, atTick, rotations })
  }

  /**
   * Adopte le format d'input du jeu annoncé.
   *
   * Fait avant `start` : les tampons d'input sont dimensionnés ici, et les
   * redimensionner en cours de manche perdrait les inputs déjà enregistrés.
   */
  #adoptGame(gameId: string): void {
    const params = this.#gameParams?.(gameId)
    if (!params || params.inputBytes === this.#inputBytes) {
      if (params) this.#tickRate = params.tickRate
      return
    }
    this.#inputBytes = params.inputBytes
    this.#tickRate = params.tickRate
    this.#inputCodec = inputFrameCodec(params.inputBytes)
    this.#batchCodec = tickBatchCodec(params.inputBytes)
    this.#latestInput = new Uint8Array(params.inputBytes)
  }

  /** Réglage de manche, diffusé par l'hôte pour que tous jouent à l'identique. */
  #publishConfig(): void {
    const w = new Writer(12)
    w.u8(FrameKind.HostHandoff)
    w.varuint(this.#inputDelayTicks)
    w.varuint(this.#session.rotations)
    this.#session.broadcast(w.finish(), 'bulk')
  }

  /**
   * Enregistre l'input local pour un tick futur.
   *
   * Le décalage est ce qui rend la partie équitable : tout le monde joue avec
   * la même avance, personne ne voit son action appliquée plus tôt.
   */
  submitInput(input: Uint8Array): number {
    if (input.length !== this.#inputBytes) {
      throw new RangeError(`input de ${input.length} o, attendu ${this.#inputBytes}`)
    }
    this.#latestInput = input.slice()
    const target = this.#currentTick + this.#inputDelayTicks
    this.#localInputs.set(target, this.#latestInput)
    if (this.#session.isHost) this.#record(target, this.#session.selfSeat, this.#latestInput)
    return target
  }

  #record(tick: number, seat: Seat, input: Uint8Array): void {
    let bySeat = this.#collected.get(tick)
    if (!bySeat) {
      bySeat = new Map()
      this.#collected.set(tick, bySeat)
    }
    bySeat.set(seat, input)
    // Un input vaut aussi pour les ticks suivants où le joueur n'a rien
    // renvoyé : une touche maintenue reste enfoncée. Borné, pour qu'un joueur
    // déconnecté ne coure pas indéfiniment dans la même direction.
    this.#lastKnown.set(seat, { input, untilTick: tick + this.ticksPerSend + this.#redundancy })
  }

  #onFrame(from: PeerId, payload: Uint8Array): void {
    const kind = payload[0]! & 0x1f

    // Avant le lancement, un pair n'écoute que le réglage de manche et l'ordre
    // de départ. Traiter les trames de jeu plus tôt faisait réclamer des
    // resynchronisations pour une manche pas encore commencée, que `start()`
    // jetait aussitôt — le pair repartait de zéro sans jamais rattraper.
    if (!this.#running && kind !== FrameKind.HostHandoff && kind !== FrameKind.MatchStart) {
      return
    }

    switch (kind) {
      case FrameKind.Input:
        this.#onInput(from, payload)
        return
      case FrameKind.TickBatch:
        this.#onTickBatch(payload)
        return
      case FrameKind.StateHash:
        this.#onStateHash(from, payload)
        return
      case FrameKind.HostHandoff:
        this.#onConfig(from, payload)
        return
      case FrameKind.Resync:
        this.#onResync(from)
        return
      case FrameKind.MatchStart:
        this.#onMatchStart(from, payload)
        return
      case FrameKind.Keyframe:
        this.applyKeyframe(payload)
        return
      default:
        return
    }
  }

  #onConfig(from: PeerId, payload: Uint8Array): void {
    if (from !== this.#session.host) return
    const r = new Reader(payload)
    r.u8()
    this.#inputDelayTicks = r.varuint()
    const rotations = r.varuint()
    this.#session.syncRotations(rotations)
    this.#events.emit('config', { inputDelayTicks: this.#inputDelayTicks, rotations })
  }

  #onInput(from: PeerId, payload: Uint8Array): void {
    if (!this.#session.isHost) return
    const seat = this.#session.roster.find((peer) => peer.id === from)?.seat
    if (seat === undefined) return

    const r = new Reader(payload)
    r.u8()
    const value = this.#inputCodec.read(r)
    const count = value.inputs.length / this.#inputBytes
    for (let i = 0; i < count; i++) {
      const tick = value.firstTick + i
      // Un input pour un tick déjà figé arrive trop tard : le rejouer
      // réécrirait le passé et désynchroniserait les pairs qui l'ont simulé.
      if (tick <= this.#lastSequencedTick) continue
      this.#record(tick, seat, value.inputs.slice(i * this.#inputBytes, (i + 1) * this.#inputBytes))
    }
  }

  #onTickBatch(payload: Uint8Array): void {
    const r = new Reader(payload)
    r.u8()
    const value = this.#batchCodec.read(r)

    const seats: Seat[] = []
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      if (value.seatMask & (1 << seat)) seats.push(seat)
    }
    const perTick = seats.length * this.#inputBytes
    if (perTick === 0) return
    const count = value.inputs.length / perTick

    // Un lot qui commence après le tick attendu signale un trou que rien ne
    // comblera : l'hôte ne réémet pas le passé. C'est le cas d'un joueur qui
    // rejoint une manche en cours. Seul un état complet peut le rattraper.
    if (value.firstTick > this.#simulatedTick + 1) this.#requestResync()

    for (let i = 0; i < count; i++) {
      const tick = value.firstTick + i
      if (this.#confirmed.has(tick) || tick <= this.#simulatedTick) continue
      const inputs: TickInputs = new Array<Uint8Array | undefined>(MAX_PLAYERS).fill(undefined)
      seats.forEach((seat, slot) => {
        const at = i * perTick + slot * this.#inputBytes
        inputs[seat] = value.inputs.slice(at, at + this.#inputBytes)
      })
      this.#confirmed.set(tick, inputs)
    }
  }

  #onStateHash(from: PeerId, payload: Uint8Array): void {
    if (!this.#session.isHost) return
    const r = new Reader(payload)
    r.u8()
    const tick = r.varuint()
    const hash = r.u32()
    const mine = this.#hashes.get(tick)
    if (mine === undefined || mine === hash) return
    // Une divergence ne se rattrape pas en continuant : les états ont bifurqué.
    this.#events.emit('desync', { peer: from, tick })
    this.#events.emit('keyframe-request', { to: from })
  }

  /**
   * Réclame un état complet à l'hôte.
   *
   * Espacé dans le temps : un keyframe est volumineux, et sur un lien BLE
   * plusieurs demandes rapprochées satureraient la file au moment précis où le
   * pair a besoin de rattraper son retard.
   */
  #requestResync(): void {
    if (this.#session.isHost) return
    // Une demande déjà en vol suffit. Sur BLE, un keyframe met près d'une
    // seconde à traverser ; en redemander pendant ce temps ferait arriver
    // plusieurs états successifs, chacun ramenant le pair en arrière — il
    // n'avancerait jamais de plus de deux ticks entre deux reculs.
    const now = this.#lastNetSendMs
    // Un état perdu en route ne doit pas condamner le pair : au-delà de deux
    // intervalles sans réponse, on redemande.
    if (this.#resyncPending && now - this.#lastResyncMs < RESYNC_INTERVAL_MS * 2) return
    if (now - this.#lastResyncMs < RESYNC_INTERVAL_MS) return
    this.#lastResyncMs = now
    this.#resyncPending = true

    const w = new Writer(8)
    w.u8(FrameKind.Resync)
    w.varuint(Math.max(0, this.#simulatedTick + 1))
    this.#session.sendTo(this.#session.host, w.finish(), 'bulk')
  }

  #onResync(from: PeerId): void {
    if (!this.#session.isHost) return
    this.#events.emit('keyframe-request', { to: from })
  }

  /** Empreinte de l'état local après simulation d'un tick. */
  recordStateHash(tick: number, hash: number): void {
    this.#hashes.set(tick, hash >>> 0)
    for (const key of this.#hashes.keys()) {
      if (key < tick - 300) this.#hashes.delete(key)
    }
    if (this.#session.isHost || tick % this.#hashIntervalTicks !== 0) return

    const w = new Writer(12)
    w.u8(FrameKind.StateHash)
    w.varuint(tick)
    w.u32(hash >>> 0)
    this.#session.sendTo(this.#session.host, w.finish(), 'bulk')
  }

  /** Fait avancer le réseau. À appeler à la cadence de simulation. */
  pump(nowMs: number): void {
    if (!this.#running) return

    if (nowMs - this.#lastNetSendMs >= 1000 / this.#netRate) {
      this.#lastNetSendMs = nowMs
      if (this.#session.isHost) {
        // Les RTT arrivent par le roster, après le démarrage : le délai calculé
        // à `start()` est une estimation, il faut le réviser une fois les
        // mesures connues.
        this.refreshConfig()
        this.#sequence()
      } else {
        this.#sendLocalInputs()
      }
    }
    this.#drainConfirmed()
  }

  /** Input à appliquer pour un siège à un tick, avec prolongation bornée. */
  #inputFor(tick: number, seat: Seat): Uint8Array {
    const explicit = this.#collected.get(tick)?.get(seat)
    if (explicit) return explicit
    const held = this.#lastKnown.get(seat)
    if (held && tick <= held.untilTick) return held.input
    return new Uint8Array(this.#inputBytes)
  }

  /** L'hôte fige l'ordre des inputs et le diffuse. */
  #sequence(): void {
    const first = this.#lastSequencedTick + 1
    const count = this.ticksPerSend
    const occupied = this.#session.roster.map((peer) => peer.seat).sort((a, b) => a - b)
    if (occupied.length === 0) return

    let seatMask = 0
    for (const seat of occupied) seatMask |= 1 << seat

    const inputs = new Uint8Array(count * occupied.length * this.#inputBytes)
    for (let i = 0; i < count; i++) {
      const tick = first + i
      occupied.forEach((seat, slot) => {
        const at = (i * occupied.length + slot) * this.#inputBytes
        inputs.set(this.#inputFor(tick, seat), at)
      })
    }

    const w = new Writer(48)
    w.u8(FrameKind.TickBatch)
    this.#batchCodec.write(w, { firstTick: first, seatMask, inputs })
    this.#session.broadcast(w.finish(), 'realtime')

    // L'hôte applique le lot qu'il vient de figer, comme tout le monde.
    for (let i = 0; i < count; i++) {
      const tick = first + i
      const confirmed: TickInputs = new Array<Uint8Array | undefined>(MAX_PLAYERS).fill(undefined)
      occupied.forEach((seat, slot) => {
        const at = (i * occupied.length + slot) * this.#inputBytes
        confirmed[seat] = inputs.slice(at, at + this.#inputBytes)
      })
      this.#confirmed.set(tick, confirmed)
      this.#collected.delete(tick)
    }
    this.#lastSequencedTick = first + count - 1
  }

  /**
   * Un client envoie ses inputs pour les ticks à venir, avec redondance.
   *
   * On réémet d'avance plutôt que d'accuser réception : sur un lien lent, un
   * aller-retour d'accusé coûte plus cher que quelques octets, et un input
   * arrivé en retard ne sert plus à rien.
   */
  #sendLocalInputs(): void {
    const first = this.#currentTick + this.#inputDelayTicks
    const count = Math.min(MAX_INPUT_REDUNDANCY, Math.max(this.#redundancy, this.ticksPerSend))

    const inputs = new Uint8Array(count * this.#inputBytes)
    for (let i = 0; i < count; i++) {
      const explicit = this.#localInputs.get(first + i)
      inputs.set(explicit ?? this.#latestInput, i * this.#inputBytes)
    }

    const w = new Writer(16)
    w.u8(FrameKind.Input)
    this.#inputCodec.write(w, { firstTick: first, inputs })
    this.#session.sendTo(this.#session.host, w.finish(), 'realtime')
  }

  /** Émet les ticks confirmés dans l'ordre, sans trou. */
  #drainConfirmed(): void {
    while (this.#confirmed.has(this.#simulatedTick + 1)) {
      const tick = this.#simulatedTick + 1
      const inputs = this.#confirmed.get(tick)!
      this.#confirmed.delete(tick)
      this.#simulatedTick = tick
      this.#currentTick = Math.max(this.#currentTick, tick)
      this.#events.emit('tick', { tick, inputs })
      this.#localInputs.delete(tick)
    }
  }

  /** L'hôte réévalue le délai et le rediffuse s'il a bougé. */
  refreshConfig(): void {
    if (!this.#session.isHost) return
    const next = this.computeInputDelay()
    if (Math.abs(next - this.#inputDelayTicks) < 1) return
    this.#inputDelayTicks = next
    this.#publishConfig()
    this.#events.emit('config', {
      inputDelayTicks: next,
      rotations: this.#session.rotations,
    })
  }

  /** Diffuse un état complet. Réservé à l'hôte. */
  sendKeyframe(to: PeerId, tick: number, state: Uint8Array): void {
    const w = new Writer(state.length + 8)
    w.u8(FrameKind.Keyframe)
    w.varuint(tick)
    w.raw(state)
    this.#session.sendTo(to, w.finish(), 'bulk')
  }

  /** Traite un keyframe reçu. */
  applyKeyframe(payload: Uint8Array): void {
    if (this.#session.isHost) return
    const r = new Reader(payload)
    r.u8()
    const tick = r.varuint()
    const state = r.raw(r.remaining).slice()
    this.#resyncPending = false
    this.#simulatedTick = tick
    this.#currentTick = tick
    // On ne jette que le passé : les lots déjà reçus pour les ticks suivants
    // restent valables et évitent de rouvrir un trou juste après avoir comblé
    // le précédent.
    for (const key of [...this.#confirmed.keys()]) {
      if (key <= tick) this.#confirmed.delete(key)
    }
    this.#events.emit('keyframe', { tick, state })
  }

  dispose(): void {
    for (const off of this.#unsubscribes) off()
    this.#events.removeAll()
  }
}
