import { Emitter, type Unsubscribe } from './emitter.js'
import type { Link, LinkEvents, PeerId, TransportCaps } from './transport.js'

/**
 * Lien en mémoire, sans réseau. Les deux extrémités sont créées ensemble par
 * `pair()`. Sert au transport local (pass-and-play) et de base au simulateur.
 *
 * La livraison est différée par `queueMicrotask` : un lien qui rappellerait son
 * pair de façon synchrone masquerait les bugs de réentrance qui, eux, se
 * manifesteraient sur un vrai transport.
 */
export class MemoryLink implements Link {
  readonly #events = new Emitter<LinkEvents>()
  #peer: MemoryLink | undefined
  #closed = false

  private constructor(
    /**
     * Pair qui détient ce bout de lien.
     *
     * Distinct de `peerId`, qui désigne l'autre extrémité. Un lien qui ne
     * connaîtrait que son distant ne permettrait pas de dire à qui une remise
     * est destinée : le simulateur ne pourrait alors pas couper un joueur
     * précis.
     */
    readonly ownerId: PeerId,
    readonly peerId: PeerId,
    readonly caps: TransportCaps,
    /** Point d'insertion du simulateur : latence, gigue, perte. */
    private readonly deliver: (to: MemoryLink, payload: Uint8Array) => void,
  ) {}

  static pair(
    aId: PeerId,
    bId: PeerId,
    caps: TransportCaps,
    deliver: (to: MemoryLink, payload: Uint8Array) => void = (to, payload) => {
      queueMicrotask(() => to.accept(payload))
    },
  ): [MemoryLink, MemoryLink] {
    const a = new MemoryLink(aId, bId, caps, deliver)
    const b = new MemoryLink(bId, aId, caps, deliver)
    a.#peer = b
    b.#peer = a
    return [a, b]
  }

  get closed(): boolean {
    return this.#closed
  }

  send(payload: Uint8Array): void {
    if (this.#closed) return
    const peer = this.#peer
    if (!peer || peer.closed) return
    // Copie : l'appelant peut réutiliser son buffer d'écriture juste après.
    this.deliver(peer, payload.slice())
  }

  /** Remise d'un message à ce bout du lien. Appelé par le transport. */
  accept(payload: Uint8Array): void {
    if (this.#closed) return
    this.#events.emit('message', payload)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    this.#events.emit('close', { reason })
    const peer = this.#peer
    this.#peer = undefined
    peer?.close(reason)
  }

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }
}
