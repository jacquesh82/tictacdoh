import { FrameKind, MAX_PLAYERS, Reader, Writer, array, str, struct, u8, varuint } from '@ttd/wire'
import { Channel, type ChannelOptions, type SendPriority } from './channel.js'
import { Emitter, type Unsubscribe } from './emitter.js'
import { Rng, seedFrom } from './rng.js'
import type { Link, PeerId, Seat, TransportCaps } from './transport.js'

export interface Peer {
  readonly id: PeerId
  readonly seat: Seat
  readonly name: string
  /** Aller-retour mesuré. `undefined` tant qu'aucun ping n'a abouti, ou si le
   *  pair n'est pas relié directement (cas d'un rayon vers un autre rayon). */
  rttMs: number | undefined
}

export interface SessionEvents extends Record<string, unknown> {
  'peer-joined': Peer
  'peer-left': { peer: Peer; reason: string }
  'host-changed': { host: PeerId; previous: PeerId }
  /** Trame applicative, déjà réassemblée et désencapsulée du routage. */
  frame: { from: PeerId; payload: Uint8Array }
}

export interface SessionOptions {
  readonly sessionId: string
  readonly selfId: PeerId
  readonly selfName: string

  /**
   * Ce pair est-il le centre physique de l'étoile ?
   *
   * Imposé par le transport : celui qui advertise en BLE/Nearby, le serveur en
   * WebSocket. Ne se déplace pas en cours de session — contrairement à l'hôte.
   */
  readonly isHub: boolean

  readonly now?: () => number
  readonly channelOptions?: ChannelOptions
  readonly pingIntervalMs?: number
}

interface LinkState {
  /** Identifiant du lien, propre au transport. */
  readonly linkId: PeerId
  readonly channel: Channel
  readonly unsubscribes: Unsubscribe[]
  /**
   * Identité annoncée par le pair d'en face, une fois son `Hello` reçu.
   *
   * Distincte de `linkId` : un transport nomme un lien à sa façon — une place
   * pour le relay, un identifiant d'appareil pour le Bluetooth — et surtout,
   * en BLE, un pair ne sait pas sous quel identifiant les autres le voient.
   * L'identité de session doit donc être déclarée, jamais déduite du lien.
   */
  remoteId: PeerId | undefined
  lastPingSentMs: number | undefined
  pingNonce: number
}

/** Siège fictif désignant « tous les pairs sauf l'émetteur ». */
export const BROADCAST_SEAT = 0xff

/**
 * Le roster porte aussi les allers-retours mesurés.
 *
 * Seul le hub est relié à tout le monde : un rayon ne mesure que son lien vers
 * le centre. Si l'autorité passe à un rayon, il ne saurait rien de la latence
 * des autres joueurs et sous-dimensionnerait le délai d'input — les inputs
 * relayés arriveraient après que le tick soit figé, et le jeu paraîtrait ne
 * pas répondre. Le hub publie donc ce qu'il est le seul à savoir.
 */
const rosterCodec = array(struct({ id: str, seat: u8, name: str, rttMs: varuint }))

/** Présentation envoyée dès l'ouverture d'un lien. */
const helloCodec = struct({ id: str, name: str })

/** Intervalle de republication du roster, pour rafraîchir les RTT. */
const ROSTER_REFRESH_MS = 3000

/**
 * Appartenance à une partie : qui est là, qui occupe quel siège, qui fait
 * autorité, et comment les octets circulent entre eux.
 *
 * Sépare trois choses que l'on confond souvent :
 *
 * - le **hub** est le centre physique de l'étoile. Le transport l'impose (le
 *   pair qui advertise en BLE, le serveur en WebSocket) et il ne bouge pas.
 * - l'**hôte** est l'autorité de séquencement. Il tourne à chaque mini-jeu
 *   pour que personne ne garde l'avantage de latence.
 * - le **roster** est la liste des joueurs de la partie, qui n'a rien à voir
 *   avec la liste des liens ouverts. En étoile, un rayon n'a qu'un seul lien
 *   — celui du hub — mais joue avec trois autres personnes.
 *
 * Cette dernière distinction n'est pas cosmétique : sans roster partagé, deux
 * pairs calculeraient des ordres de rotation différents et l'autorité se
 * dédoublerait au premier changement de manche.
 */
export class Session {
  readonly sessionId: string
  readonly selfId: PeerId
  readonly selfName: string
  readonly isHub: boolean

  readonly #events = new Emitter<SessionEvents>()
  /** Liens ouverts. En étoile, un rayon n'en a qu'un. */
  readonly #links = new Map<PeerId, LinkState>()
  /** Joueurs de la partie, soi-même compris. Le hub en est l'autorité. */
  readonly #roster = new Map<PeerId, Peer>()

  /**
   * Horloge de mesure, distincte du temps de `pump`.
   *
   * Deux bases de temps coexistaient et se soustrayaient l'une à l'autre :
   * `Date.now()` par défaut d'un côté, le `performance.now()` passé à `pump` de
   * l'autre. Le résultat était un aller-retour de plusieurs milliards de
   * millisecondes, et un délai d'input aberrant qui rendait le jeu injouable
   * sans rien signaler.
   *
   * La séparation est désormais par rôle, et stricte : le temps de `pump`
   * **cadence** (balayage de ping, republication du roster, écoulement des
   * files) ; cette horloge-ci **mesure** (durée d'un aller-retour). Les deux ne
   * se rencontrent jamais dans une même soustraction — un aller-retour se
   * mesure d'ailleurs à la réception du pong, qui survient hors de `pump`.
   */
  readonly #measure: () => number
  readonly #channelOptions: ChannelOptions
  readonly #pingIntervalMs: number

  /**
   * Nombre de passations effectuées, et non identifiant d'hôte courant.
   *
   * Deux tentatives plus naïves échouent ici. Mémoriser un identifiant oblige
   * chaque pair à choisir qui commence, et le constructeur ne peut désigner
   * que soi-même : les quatre se croient hôtes. Mémoriser une position dans
   * l'ordre ne suffit pas non plus, parce que l'ordre change à chaque arrivée
   * pendant le lobby et que « préserver » un hôte fait diverger les pairs qui
   * n'ont pas vu les mêmes états intermédiaires.
   *
   * Un compteur rend l'autorité fonction du seul couple (roster, manches
   * jouées) : deux pairs d'accord sur ces deux données sont nécessairement
   * d'accord sur l'hôte, sans échanger un octet.
   */
  #rotations = 0
  #hostOrder: PeerId[]
  #lastPingSweepMs = 0
  #lastRosterPublishMs = 0

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId
    this.selfId = options.selfId
    this.selfName = options.selfName
    this.isHub = options.isHub
    this.#measure =
      options.now ??
      (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())
    this.#channelOptions = options.channelOptions ?? {}
    this.#pingIntervalMs = options.pingIntervalMs ?? 2000

    this.#roster.set(options.selfId, {
      id: options.selfId,
      seat: 0,
      name: options.selfName,
      rttMs: undefined,
    })
    // Seul en session : on est hôte. Le mode solo et le pass-and-play suivent
    // donc exactement le même chemin de code que le cas réseau.
    this.#hostOrder = [options.selfId]
  }

  get host(): PeerId {
    if (this.#hostOrder.length === 0) return this.selfId
    return this.#hostOrder[this.#rotations % this.#hostOrder.length] ?? this.selfId
  }

  get isHost(): boolean {
    return this.host === this.selfId
  }

  get selfSeat(): Seat {
    return this.#roster.get(this.selfId)?.seat ?? 0
  }

  /** Joueurs de la partie, hors soi-même. */
  get peers(): Peer[] {
    return [...this.#roster.values()].filter((peer) => peer.id !== this.selfId)
  }

  /** Joueurs de la partie, soi-même compris, triés par siège. */
  get roster(): Peer[] {
    return [...this.#roster.values()].sort((a, b) => a.seat - b.seat)
  }

  get playerCount(): number {
    return this.#roster.size
  }

  /** Ordre de passation courant, pour affichage dans le lobby. */
  get hostOrder(): readonly PeerId[] {
    return this.#hostOrder
  }

  /**
   * Capacités du lien courant. `undefined` en session solo, où il n'y a aucun
   * lien. C'est la source d'où le netcode déduit sa cadence et sa redondance.
   */
  get linkCaps(): TransportCaps | undefined {
    return this.#links.values().next().value?.channel.link.caps
  }

  on<K extends keyof SessionEvents>(event: K, fn: (payload: SessionEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }

  #allocateSeat(): Seat {
    const taken = new Set([...this.#roster.values()].map((peer) => peer.seat))
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      if (!taken.has(seat)) return seat
    }
    throw new RangeError(`session pleine (${MAX_PLAYERS} joueurs)`)
  }

  /**
   * Attache un lien établi.
   *
   * Côté hub, cela fait entrer un joueur dans la partie et déclenche la
   * publication du roster. Côté rayon, cela ne fait qu'ouvrir le lien vers le
   * hub : la composition réelle de la partie arrivera par le roster.
   */
  addPeer(link: Link, peerName = ''): void {
    if (this.#links.has(link.peerId)) throw new Error(`lien déjà ouvert: ${link.peerId}`)

    // Le hub refuse tout de suite au-delà de la capacité. Compter les liens et
    // non les entrées du roster est ce qui permet de le savoir dès maintenant :
    // le roster, lui, attend les présentations et arriverait trop tard pour
    // éviter d'ouvrir une connexion qu'on va fermer.
    if (this.isHub && this.#links.size >= MAX_PLAYERS - 1) {
      throw new RangeError(`session pleine (${MAX_PLAYERS} joueurs)`)
    }

    const channel = new Channel(link, this.#channelOptions)
    const state: LinkState = {
      linkId: link.peerId,
      channel,
      unsubscribes: [],
      remoteId: undefined,
      lastPingSentMs: undefined,
      pingNonce: 0,
    }
    state.unsubscribes.push(channel.on('message', (payload) => this.#onMessage(state, payload)))
    state.unsubscribes.push(link.on('close', ({ reason }) => this.#onLinkClosed(state, reason)))
    this.#links.set(link.peerId, state)
    void peerName

    // On se présente. L'entrée au roster attend la présentation d'en face :
    // seul le pair distant sait comment il s'appelle, et le nom que le
    // transport lui donne n'a pas de valeur d'identité.
    const w = new Writer(64)
    w.u8(FrameKind.Hello)
    helloCodec.write(w, { id: this.selfId, name: this.selfName })
    // En temps réel, et non en volumineux : la file volumineuse passe après le
    // temps réel, si bien qu'une présentation en `bulk` arriverait *après* les
    // premières trames de jeu. Celles-ci seraient alors rejetées, faute de
    // savoir qui les envoie. Rien n'ayant encore été mis en file sur ce canal,
    // la présentation part nécessairement en premier.
    channel.send(w.finish(), 'realtime')
  }

  #onHello(state: LinkState, payload: Uint8Array): void {
    const r = new Reader(payload)
    r.u8()
    const hello = helloCodec.read(r)
    if (hello.id === this.selfId) {
      throw new Error(`collision d'identité : « ${hello.id} » est déjà le nôtre`)
    }
    state.remoteId = hello.id
    if (!this.isHub || this.#roster.has(hello.id)) return

    if (this.#roster.size >= MAX_PLAYERS) {
      state.channel.link.close('session pleine')
      return
    }
    const peer: Peer = {
      id: hello.id,
      seat: this.#allocateSeat(),
      name: hello.name,
      rttMs: undefined,
    }
    this.#roster.set(peer.id, peer)
    this.#recomputeHostOrder()
    this.#events.emit('peer-joined', peer)
    this.#publishRoster()
  }

  /** Lien menant à un joueur, retrouvé par son identité annoncée. */
  #linkTo(peerId: PeerId): LinkState | undefined {
    for (const state of this.#links.values()) {
      if (state.remoteId === peerId) return state
    }
    return undefined
  }

  /** Le hub diffuse la composition de la partie. Lui seul en fait autorité. */
  #publishRoster(): void {
    if (!this.isHub) return
    const w = new Writer(64)
    w.u8(FrameKind.Welcome)
    rosterCodec.write(
      w,
      this.roster.map((peer) => ({
        id: peer.id,
        seat: peer.seat,
        name: peer.name,
        rttMs: Math.min(60_000, Math.round(peer.rttMs ?? 0)),
      })),
    )
    const payload = w.finish()
    for (const state of this.#links.values()) state.channel.send(payload.slice(), 'bulk')
  }

  /** Un rayon adopte la composition publiée par le hub. */
  #applyRoster(payload: Uint8Array): void {
    if (this.isHub) return
    const r = new Reader(payload)
    r.u8()
    const entries = rosterCodec.read(r)

    const incoming = new Map(entries.map((entry) => [entry.id, entry]))

    // Un roster qui ne nous contient pas a été publié avant que notre `Hello`
    // n'atteigne le hub : c'est la course normale à l'arrivée. L'appliquer
    // nous retirerait de notre propre partie, nous ferions retomber notre
    // siège à 0 — déjà pris par le hub — et deux joueurs partageraient un
    // siège sans que rien ne le signale. On l'ignore : le hub republie juste
    // après nous avoir ajouté.
    if (!incoming.has(this.selfId)) return

    for (const [id, peer] of [...this.#roster]) {
      if (!incoming.has(id)) {
        this.#roster.delete(id)
        this.#events.emit('peer-left', { peer, reason: 'quitté la partie' })
      }
    }
    for (const entry of entries) {
      const rttMs = entry.rttMs > 0 ? entry.rttMs : undefined
      const existing = this.#roster.get(entry.id)
      if (existing) {
        this.#roster.set(entry.id, { ...existing, seat: entry.seat, name: entry.name, rttMs })
        continue
      }
      const peer: Peer = { id: entry.id, seat: entry.seat, name: entry.name, rttMs }
      this.#roster.set(entry.id, peer)
      this.#events.emit('peer-joined', peer)
    }
    this.#recomputeHostOrder()
  }

  /**
   * Ordre de passation, déterministe.
   *
   * Dérivé de l'identifiant de session et du roster trié : tous les pairs
   * calculent le même ordre sans se le transmettre, et il ne dépend pas de
   * l'ordre d'arrivée — sinon l'hôte initial resterait systématiquement
   * premier, ce qui viderait la rotation de son sens.
   */
  #recomputeHostOrder(): void {
    const previous = this.host
    const ids = [...this.#roster.keys()].sort()
    this.#hostOrder = new Rng(seedFrom(this.sessionId)).shuffle(ids)
    this.#announceHostChange(previous)
  }

  #announceHostChange(previous: PeerId): void {
    const host = this.host
    if (host === previous) return
    this.#events.emit('host-changed', { host, previous })
  }

  /**
   * Passe l'autorité au pair suivant. Appelé entre deux mini-jeux.
   *
   * Ne transfère aucun état : chaque pair simule déjà la partie complète, le
   * nouvel hôte n'a qu'à reprendre le séquencement au tick suivant. C'est ce
   * qui rend la rotation praticable même sur un lien BLE.
   */
  rotateHost(): PeerId {
    if (this.#hostOrder.length <= 1) return this.host
    const previous = this.host
    this.#rotations++
    this.#announceHostChange(previous)
    return this.host
  }

  /**
   * Nombre de passations effectuées. Partagé dans la trame `HostHandoff` pour
   * qu'un joueur arrivé en cours de session se cale sur la bonne autorité.
   */
  get rotations(): number {
    return this.#rotations
  }

  /** Aligne le compteur sur celui de l'hôte, à l'arrivée en cours de partie. */
  syncRotations(count: number): void {
    if (!Number.isInteger(count) || count < 0) return
    const previous = this.host
    this.#rotations = count
    this.#announceHostChange(previous)
  }

  #onLinkClosed(state: LinkState, reason: string): void {
    if (!this.#links.delete(state.linkId)) return
    for (const off of state.unsubscribes) off()

    const peer = state.remoteId ? this.#roster.get(state.remoteId) : undefined
    if (peer && this.isHub) {
      // `#recomputeHostOrder` retire le partant de l'ordre et, s'il était
      // l'autorité, la fait passer au suivant. Aucun état n'est transféré : la
      // simulation est déjà répliquée chez tout le monde.
      this.#roster.delete(peer.id)
      this.#recomputeHostOrder()
      this.#events.emit('peer-left', { peer, reason })
      this.#publishRoster()
      return
    }

    // Un rayon qui perd le hub perd la partie : plus aucun chemin vers les
    // autres joueurs. On se replie en session solo plutôt que de faire croire
    // que la partie continue.
    if (!this.isHub) {
      const previous = this.host
      for (const id of [...this.#roster.keys()]) {
        if (id === this.selfId) continue
        const lost = this.#roster.get(id)!
        this.#roster.delete(id)
        this.#events.emit('peer-left', { peer: lost, reason })
      }
      this.#hostOrder = [this.selfId]
      this.#announceHostChange(previous)
    }
  }

  #onMessage(state: LinkState, payload: Uint8Array): void {
    const kind = payload[0]! & 0x1f

    switch (kind) {
      case FrameKind.Ping: {
        const nonce = new Reader(payload.subarray(1)).varuint()
        const w = new Writer(8)
        w.u8(FrameKind.Pong)
        w.varuint(nonce)
        state.channel.send(w.finish())
        return
      }
      case FrameKind.Pong: {
        const nonce = new Reader(payload.subarray(1)).varuint()
        if (nonce === state.pingNonce && state.lastPingSentMs !== undefined) {
          const peer = state.remoteId ? this.#roster.get(state.remoteId) : undefined
          if (peer) peer.rttMs = Math.max(0, this.#measure() - state.lastPingSentMs)
          state.lastPingSentMs = undefined
        }
        return
      }
      case FrameKind.Hello:
        this.#onHello(state, payload)
        return
      case FrameKind.Welcome:
        this.#applyRoster(payload)
        return
      case FrameKind.Route:
        this.#onRoute(state, payload)
        return
      default:
        if (state.remoteId) this.#events.emit('frame', { from: state.remoteId, payload })
    }
  }

  /**
   * Réacheminement par le hub.
   *
   * Quand l'hôte n'est pas le hub, il ne voit pas tous les pairs : ses trames
   * transitent par le hub. C'est le mécanisme qui permet à l'autorité de
   * tourner sans redémonter l'étoile physique.
   *
   * L'enveloppe porte le siège d'origine, et le hub la réémet telle quelle
   * plutôt que d'en extraire le contenu. Sans cela, le destinataire croirait
   * que le hub est l'émetteur : les inputs de trois joueurs seraient tous
   * attribués au siège du hub dès que l'autorité quitte le centre de l'étoile.
   */
  #onRoute(state: LinkState, payload: Uint8Array): void {
    if (payload.length < 4) return
    const destSeat = payload[1]!
    const srcSeat = payload[2]!
    const inner = payload.subarray(3)
    const origin = this.#peerAtSeat(srcSeat) ?? state.remoteId
    if (!origin) return

    // Rayon : la trame vient forcément du hub, on la déballe.
    if (!this.isHub) {
      this.#events.emit('frame', { from: origin, payload: inner.slice() })
      return
    }

    if (destSeat === BROADCAST_SEAT) {
      for (const other of this.#links.values()) {
        if (other.linkId !== state.linkId) other.channel.send(payload.slice())
      }
      this.#events.emit('frame', { from: origin, payload: inner.slice() })
      return
    }

    if (destSeat === this.selfSeat) {
      this.#events.emit('frame', { from: origin, payload: inner.slice() })
      return
    }

    const target = this.#peerAtSeat(destSeat)
    if (target) this.#linkTo(target)?.channel.send(payload.slice())
  }

  #peerAtSeat(seat: Seat): PeerId | undefined {
    for (const peer of this.#roster.values()) {
      if (peer.seat === seat) return peer.id
    }
    return undefined
  }

  /** Envoie une trame à un joueur, directement ou via le hub. */
  sendTo(peerId: PeerId, payload: Uint8Array, priority?: SendPriority): void {
    const direct = this.#linkTo(peerId)
    if (direct) {
      direct.channel.send(payload, priority)
      return
    }
    const seat = this.#roster.get(peerId)?.seat
    const hub = this.#hubLink()
    if (seat === undefined || !hub) return
    hub.channel.send(this.#encapsulate(seat, payload), priority)
  }

  /** Diffuse une trame à tous les autres joueurs. */
  broadcast(payload: Uint8Array, priority?: SendPriority): void {
    if (this.isHub) {
      for (const state of this.#links.values()) state.channel.send(payload.slice(), priority)
      return
    }
    const hub = this.#hubLink()
    if (!hub) return
    hub.channel.send(this.#encapsulate(BROADCAST_SEAT, payload), priority)
  }

  #encapsulate(destSeat: Seat, payload: Uint8Array): Uint8Array {
    const w = new Writer(payload.length + 3)
    w.u8(FrameKind.Route)
    w.u8(destSeat)
    // Siège d'origine : un octet qui ne se paie que sur le chemin relayé, et
    // sans lequel le destinataire ne peut pas savoir qui lui parle.
    w.u8(this.selfSeat)
    w.raw(payload)
    return w.finish()
  }

  /**
   * Le hub, vu d'ici. Quand on n'est pas soi-même le hub, il n'y a par
   * construction qu'un seul lien : celui qui mène au centre de l'étoile.
   */
  #hubLink(): LinkState | undefined {
    return this.#links.values().next().value
  }

  /**
   * Fait avancer la session : mesure les allers-retours et écoule les files.
   * Piloté par la boucle de l'application, jamais par un timer interne, pour
   * que les tests restent déterministes.
   */
  pump(nowMs: number): void {
    if (nowMs - this.#lastPingSweepMs >= this.#pingIntervalMs) {
      this.#lastPingSweepMs = nowMs
      for (const state of this.#links.values()) {
        // Un ping sans réponse n'est pas réémis : on garde la dernière mesure
        // connue plutôt que d'empiler des nonces en vol sur un lien lent.
        if (state.lastPingSentMs !== undefined) continue
        state.pingNonce = (state.pingNonce + 1) % 0x1_0000
        // Horodaté avec l'horloge de mesure, jamais avec le temps de pump :
        // c'est de cette valeur qu'on soustraira à la réception du pong.
        state.lastPingSentMs = this.#measure()
        const w = new Writer(8)
        w.u8(FrameKind.Ping)
        w.varuint(state.pingNonce)
        state.channel.send(w.finish())
      }
    }
    // Le hub republie régulièrement : les RTT bougent, et c'est la seule
    // source dont disposent les rayons pour dimensionner le délai d'input.
    if (this.isHub && nowMs - this.#lastRosterPublishMs >= ROSTER_REFRESH_MS) {
      this.#lastRosterPublishMs = nowMs
      this.#publishRoster()
    }

    for (const state of this.#links.values()) state.channel.pump(nowMs)
  }

  /**
   * Identité du hub, c'est-à-dire du créateur de la salle.
   *
   * À ne pas confondre avec `host` : le hub possède la salle et ne change
   * jamais, l'hôte n'est que l'autorité de séquencement et tourne à chaque
   * manche pour l'équité. Le lobby appartient au premier, la partie au second.
   */
  get hubId(): PeerId | undefined {
    if (this.isHub) return this.selfId
    return this.#links.values().next().value?.remoteId
  }

  /** Aller-retour vers le hub. `0` si on est le hub, ou avant mesure. */
  get hubRttMs(): number {
    if (this.isHub) return 0
    const hubId = this.#links.keys().next().value
    if (hubId === undefined) return 0
    return this.#roster.get(hubId)?.rttMs ?? 0
  }

  /** Pire aller-retour observé. Dimensionne le délai d'input équitable. */
  worstRttMs(): number {
    let worst = 0
    for (const peer of this.#roster.values()) {
      if (peer.rttMs !== undefined && peer.rttMs > worst) worst = peer.rttMs
    }
    return worst
  }

  close(reason = 'session closed'): void {
    for (const state of [...this.#links.values()]) state.channel.link.close(reason)
    this.#links.clear()
    this.#events.removeAll()
  }
}
