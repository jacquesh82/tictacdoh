import { FLAG_FRAGMENT, Reader, Writer } from '@ttd/wire'
import { Emitter, type Unsubscribe } from './emitter.js'
import { type Link, TransportError } from './transport.js'

/**
 * Priorité d'envoi.
 *
 * `realtime` : inputs et lots de ticks. Périssables — un input en retard ne
 * sert à rien, on préfère jeter l'ancien que retarder le neuf.
 * `bulk` : keyframes, métadonnées de lobby. Volumineux mais non urgents, et
 * jamais jetés.
 */
export type SendPriority = 'realtime' | 'bulk'

export interface ChannelEvents extends Record<string, unknown> {
  message: Uint8Array
  /** Émis quand la file temps réel déborde et qu'un message est sacrifié. */
  dropped: { priority: SendPriority; bytes: number }
}

export interface ChannelOptions {
  /**
   * Part du débit du lien qu'on s'autorise à consommer, entre 0 et 1.
   *
   * Sur BLE le débit annoncé est un plafond théorique atteint dans de bonnes
   * conditions ; viser 70 % laisse de quoi absorber une dégradation sans que
   * la file explose.
   */
  utilization?: number

  /** Profondeur de la file temps réel, en messages. */
  realtimeQueueDepth?: number

  /** Plafond des fragments en attente de réassemblage, en octets. */
  reassemblyBudgetBytes?: number
}

interface Queued {
  payload: Uint8Array
  priority: SendPriority
}

interface Reassembly {
  readonly total: number
  readonly head: number
  readonly parts: (Uint8Array | undefined)[]
  /**
   * Fragments distincts reçus. Compté explicitement plutôt que déduit du
   * tableau : `new Array(n)` produit un tableau creux, et `some`/`every`
   * sautent les trous — un fragment manquant passerait alors pour reçu.
   */
  received: number
  bytes: number
}

const FRAG_HEADER_MAX = 1 + 5 + 1 + 1 // tête + msgId varuint + index + total

/**
 * Découpe, met en file et lisse les envois sur un lien.
 *
 * Deux responsabilités que les transports n'assurent pas eux-mêmes :
 *
 * 1. **Fragmentation.** Un keyframe dépasse les ~180 octets d'un lien BLE.
 * 2. **Budget.** Sans lissage, une rafale sature la file du système d'exploi-
 *    tation et la latence part en vrille — sur BLE elle ne redescend jamais
 *    pendant la partie.
 *
 * Suppose un lien fiable et ordonné. C'est le cas des cinq transports du
 * socle (les canaux WebRTC sont configurés ainsi, les notifications GATT et
 * les WebSockets le sont par construction). Un lien sans cette garantie doit
 * annoncer `reliable: false` : la fragmentation y est alors refusée plutôt
 * que de réassembler silencieusement des fragments manquants.
 */
export class Channel {
  readonly #link: Link
  readonly #events = new Emitter<ChannelEvents>()
  readonly #realtime: Queued[] = []
  readonly #bulk: Queued[] = []
  readonly #pending = new Map<number, Reassembly>()

  readonly #utilization: number
  readonly #realtimeQueueDepth: number
  readonly #reassemblyBudgetBytes: number

  #tokens: number
  #lastPumpMs: number | undefined
  #nextMsgId = 0
  #pendingBytes = 0

  constructor(link: Link, options: ChannelOptions = {}) {
    this.#link = link
    this.#utilization = options.utilization ?? 0.7
    this.#realtimeQueueDepth = options.realtimeQueueDepth ?? 8
    this.#reassemblyBudgetBytes = options.reassemblyBudgetBytes ?? 64 * 1024
    // Un seau initialement plein : le premier envoi ne doit pas attendre.
    this.#tokens = this.#budgetPerSec()
    link.on('message', (payload) => this.#receive(payload))
  }

  get link(): Link {
    return this.#link
  }

  on<K extends keyof ChannelEvents>(
    event: K,
    fn: (payload: ChannelEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, fn)
  }

  #budgetPerSec(): number {
    return this.#link.caps.throughputBytesPerSec * this.#utilization
  }

  /** Met un message en file. L'envoi réel a lieu au prochain `pump`. */
  send(payload: Uint8Array, priority: SendPriority = 'realtime'): void {
    if (this.#link.closed) return
    if (payload.length === 0) throw new TransportError('message vide', this.#link.caps.kind)

    const queue = priority === 'realtime' ? this.#realtime : this.#bulk
    queue.push({ payload, priority })

    if (priority === 'realtime' && queue.length > this.#realtimeQueueDepth) {
      // On jette le plus ancien, pas le plus récent : un input périmé n'a
      // aucune valeur, et la redondance du protocole couvre déjà le trou.
      const victim = queue.shift()
      if (victim) this.#events.emit('dropped', { priority, bytes: victim.payload.length })
    }
  }

  /**
   * Écoule la file dans la limite du budget accumulé depuis le dernier appel.
   * Piloté par la boucle de la session — jamais par un timer interne, pour que
   * les tests restent déterministes.
   *
   * @returns octets réellement émis.
   */
  pump(nowMs: number): number {
    if (this.#link.closed) return 0

    if (this.#lastPumpMs !== undefined) {
      const elapsedSec = Math.max(0, nowMs - this.#lastPumpMs) / 1000
      this.#tokens = Math.min(this.#budgetPerSec(), this.#tokens + elapsedSec * this.#budgetPerSec())
    }
    this.#lastPumpMs = nowMs

    let sent = 0
    // Le temps réel passe avant le volumineux : un keyframe en cours d'envoi
    // ne doit pas retarder les inputs du tick courant.
    for (const queue of [this.#realtime, this.#bulk]) {
      while (queue.length > 0) {
        const next = queue[0]!
        const cost = next.payload.length
        if (cost > this.#tokens) break
        queue.shift()
        this.#tokens -= cost
        sent += this.#transmit(next.payload)
      }
    }
    return sent
  }

  #transmit(payload: Uint8Array): number {
    const mtu = this.#link.caps.maxPayloadBytes
    if (payload.length <= mtu) {
      this.#link.send(payload)
      return payload.length
    }

    if (!this.#link.caps.reliable) {
      throw new TransportError(
        `message de ${payload.length} o à fragmenter sur un lien non fiable (MTU ${mtu})`,
        this.#link.caps.kind,
      )
    }

    const head = payload[0]!
    const body = payload.subarray(1)
    const chunkSize = mtu - FRAG_HEADER_MAX
    if (chunkSize <= 0) {
      throw new TransportError(`MTU de ${mtu} o trop petite pour fragmenter`, this.#link.caps.kind)
    }

    const total = Math.ceil(body.length / chunkSize)
    if (total > 255) {
      throw new TransportError(
        `message de ${payload.length} o : ${total} fragments, maximum 255`,
        this.#link.caps.kind,
      )
    }

    const msgId = this.#nextMsgId
    this.#nextMsgId = (this.#nextMsgId + 1) % 0x1_0000
    let bytes = 0
    for (let i = 0; i < total; i++) {
      const w = new Writer(mtu)
      w.u8(head | FLAG_FRAGMENT)
      w.varuint(msgId)
      w.u8(i)
      w.u8(total)
      w.raw(body.subarray(i * chunkSize, (i + 1) * chunkSize))
      const fragment = w.finish()
      this.#link.send(fragment)
      bytes += fragment.length
    }
    return bytes
  }

  #receive(payload: Uint8Array): void {
    if (payload.length === 0) return
    const head = payload[0]!
    if ((head & FLAG_FRAGMENT) === 0) {
      this.#events.emit('message', payload)
      return
    }

    const r = new Reader(payload)
    r.u8()
    const msgId = r.varuint()
    const index = r.u8()
    const total = r.u8()
    const chunk = r.raw(r.remaining).slice()

    if (total === 0 || index >= total) return

    let entry = this.#pending.get(msgId)
    if (!entry) {
      entry = {
        total,
        head: head & ~FLAG_FRAGMENT,
        parts: new Array<Uint8Array | undefined>(total).fill(undefined),
        received: 0,
        bytes: 0,
      }
      this.#pending.set(msgId, entry)
    }
    if (entry.total !== total) return

    if (entry.parts[index] === undefined) {
      entry.parts[index] = chunk
      entry.received++
      entry.bytes += chunk.length
      this.#pendingBytes += chunk.length
    }

    // Un pair qui n'envoie que des premiers fragments ferait grossir la mémoire
    // indéfiniment. Au-delà du budget, on repart de zéro plutôt que d'accumuler.
    if (this.#pendingBytes > this.#reassemblyBudgetBytes) {
      this.#pending.clear()
      this.#pendingBytes = 0
      return
    }

    if (entry.received < entry.total) return

    const w = new Writer(entry.bytes + 1)
    w.u8(entry.head)
    for (const part of entry.parts) {
      if (part) w.raw(part)
    }
    this.#pending.delete(msgId)
    this.#pendingBytes -= entry.bytes
    this.#events.emit('message', w.finish())
  }

  /** Nombre de messages encore en attente d'envoi. */
  get queued(): number {
    return this.#realtime.length + this.#bulk.length
  }
}
