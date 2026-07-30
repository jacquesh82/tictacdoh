import {
  type DiscoveredSession,
  Emitter,
  type Link,
  type LinkEvents,
  type PeerId,
  type SessionAdvert,
  type Transport,
  TransportError,
  type TransportCaps,
  type Unsubscribe,
} from '@ttd/core'
import type {
  DataChannelLike,
  PeerConnectionFactory,
  PeerConnectionLike,
  SignalChannel,
  SignalPayload,
} from './types.js'

export * from './types.js'

/**
 * Capacités du pair à pair.
 *
 * `requiresInternet` est à `false` : sur un même réseau local, WebRTC établit
 * la connexion sans jamais sortir. Mais `canDiscover` reste `false` — la mise
 * en relation initiale demande, elle, un canal préalable.
 */
export const WEBRTC_CAPS: TransportCaps = {
  kind: 'webrtc',
  maxPayloadBytes: 16 * 1024,
  throughputBytesPerSec: 1024 * 1024,
  rttHintMs: 15,
  maxPeers: 4,
  canAdvertise: false,
  canDiscover: false,
  reliable: true,
  ordered: true,
  requiresInternet: false,
}

const CHANNEL_LABEL = 'ttd'
const HOST_SLOT = 0

/** Convention partagée avec le transport relayé : un pair est sa place. */
export function peerIdForSlot(slot: number): string {
  return `slot-${slot}`
}

/** Serveurs STUN publics. Aucun TURN : voir la réserve dans `WebRtcTransport`. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

class RtcLink implements Link {
  readonly #events = new Emitter<LinkEvents>()
  #closed = false

  constructor(
    readonly peerId: PeerId,
    readonly caps: TransportCaps,
    private readonly channel: DataChannelLike,
    private readonly connection: PeerConnectionLike,
  ) {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => {
      if (this.#closed) return
      const data = event.data
      if (data instanceof ArrayBuffer) {
        this.#events.emit('message', new Uint8Array(data))
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView
        this.#events.emit('message', new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
      }
    }
    channel.onclose = () => this.close('canal fermé')
    channel.onerror = () => this.close('erreur de canal')
  }

  get closed(): boolean {
    return this.#closed
  }

  send(payload: Uint8Array): void {
    if (this.#closed || this.channel.readyState !== 'open') return
    this.channel.send(payload)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.channel.close()
      this.connection.close()
    } catch {
      // La fermeture d'un canal déjà mort n'a pas à faire échouer la partie.
    }
    this.#events.emit('close', { reason })
  }

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }
}

export interface WebRtcTransportOptions {
  readonly signal: SignalChannel
  /** Place occupée sur le relay. 0 pour l'hôte. */
  readonly selfSlot: number
  readonly isHost: boolean
  readonly iceServers?: readonly unknown[]
  /** Fabrique de connexion, injectable pour les tests. */
  readonly connectionFactory?: PeerConnectionFactory
}

interface Pending {
  readonly connection: PeerConnectionLike
  /** Candidats reçus avant la description distante, à rejouer ensuite. */
  readonly earlyCandidates: unknown[]
  remoteReady: boolean
  resolve?: (link: Link) => void
  reject?: (error: Error) => void
}

/**
 * Transport pair à pair.
 *
 * Le relay met en relation puis s'efface : une fois le canal ouvert, plus
 * aucun octet de jeu ne passe par le serveur. Sur un même réseau local, la
 * connexion ne sort même pas du Wi-Fi.
 *
 * La topologie reste l'étoile du reste du socle : chaque invité n'établit un
 * canal qu'avec l'hôte, jamais entre invités. Un maillage complet diviserait
 * la latence par deux mais multiplierait les connexions par trois, pour un
 * gain sans rapport avec des mini-jeux d'une minute.
 *
 * Réserve : sans serveur TURN, une paire d'appareils derrière deux NAT
 * symétriques ne parviendra pas à s'appairer. Le repli est alors le transport
 * relayé, qui reste disponible — c'est la raison pour laquelle le socle ne
 * mise jamais sur un seul transport.
 */
export class WebRtcTransport implements Transport {
  readonly caps = WEBRTC_CAPS

  readonly #signal: SignalChannel
  readonly #isHost: boolean
  readonly #iceServers: readonly unknown[]
  readonly #factory: PeerConnectionFactory
  readonly #incoming = new Set<(link: Link) => void>()
  readonly #pending = new Map<number, Pending>()
  readonly #links = new Map<number, Link>()
  readonly #unsubscribe: Unsubscribe

  constructor(options: WebRtcTransportOptions) {
    this.#signal = options.signal
    this.#isHost = options.isHost
    this.#iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS
    this.#factory =
      options.connectionFactory ??
      (() => {
        // Résolu sur `globalThis` plutôt que par le type global du DOM : le
        // socle ne dépend d'aucune API de navigateur au niveau des types, ce
        // qui lui permet d'être compilé tel quel pour une coquille native où
        // WebRTC est fourni par un module tiers.
        const Ctor = (globalThis as { RTCPeerConnection?: new (config: unknown) => unknown })
          .RTCPeerConnection
        if (!Ctor) {
          throw new TransportError('WebRTC absent de cet environnement', 'webrtc')
        }
        return new Ctor({ iceServers: this.#iceServers }) as PeerConnectionLike
      })
    void options.selfSlot

    this.#unsubscribe = options.signal.onSignal((from, data) => {
      void this.#onSignal(from, data as SignalPayload)
    })
  }

  onIncoming(fn: (link: Link) => void): Unsubscribe {
    this.#incoming.add(fn)
    return () => void this.#incoming.delete(fn)
  }

  #newConnection(slot: number): Pending {
    const connection = this.#factory()
    const pending: Pending = { connection, earlyCandidates: [], remoteReady: false }
    this.#pending.set(slot, pending)

    connection.onicecandidate = (event) => {
      if (!event.candidate) return
      this.#signal.signal(slot, { kind: 'ice', candidate: event.candidate })
    }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState !== 'failed') return
      // Échec d'appairage : presque toujours deux NAT symétriques sans TURN.
      // On le dit clairement, l'appelant retombera sur le relay.
      pending.reject?.(
        new TransportError(
          'appairage pair à pair impossible (NAT restrictif, pas de TURN) — repli sur le relay',
          'webrtc',
        ),
      )
      this.#pending.delete(slot)
    }
    return pending
  }

  #adopt(slot: number, pending: Pending, channel: DataChannelLike, peerId: PeerId): Link {
    const link = new RtcLink(peerId, WEBRTC_CAPS, channel, pending.connection)
    this.#links.set(slot, link)
    this.#pending.delete(slot)
    return link
  }

  /**
   * Établit le canal vers l'hôte. Appelé par un invité.
   *
   * L'invité émet l'offre : lui seul sait quand il souhaite rejoindre, et
   * l'hôte n'a pas à deviner combien de correspondants l'attendent.
   */
  connectToHost(hostName: string, timeoutMs = 15_000): Promise<Link> {
    if (this.#isHost) {
      return Promise.reject(new TransportError('l’hôte n’initie pas la connexion', 'webrtc'))
    }
    const pending = this.#newConnection(HOST_SLOT)
    const channel = pending.connection.createDataChannel(CHANNEL_LABEL, {
      // Ordonné et fiable : c'est l'hypothèse de la couche Channel, qui
      // refuse de fragmenter sur un lien qui ne la tient pas.
      ordered: true,
    })

    return new Promise<Link>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.connection.close()
        this.#pending.delete(HOST_SLOT)
        reject(new TransportError('délai dépassé pour l’appairage pair à pair', 'webrtc'))
      }, timeoutMs)

      pending.resolve = (link) => {
        clearTimeout(timer)
        resolve(link)
      }
      pending.reject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      // Même convention d'identifiant que le transport relayé : c'est ce qui
      // permet à l'hôte de reconnaître un invité déjà connu par le relay, et
      // donc de remplacer son lien au lieu d'ajouter un second joueur.
      void hostName
      channel.onopen = () =>
        pending.resolve?.(this.#adopt(HOST_SLOT, pending, channel, peerIdForSlot(HOST_SLOT)))

      void (async () => {
        try {
          const offer = await pending.connection.createOffer()
          await pending.connection.setLocalDescription(offer)
          this.#signal.signal(HOST_SLOT, { kind: 'offer', sdp: offer.sdp ?? '' })
        } catch (error) {
          pending.reject?.(error as Error)
        }
      })()
    })
  }

  async #onSignal(from: number, payload: SignalPayload): Promise<void> {
    if (payload.kind === 'offer') {
      if (!this.#isHost) return
      const pending = this.#newConnection(from)
      pending.connection.ondatachannel = (event) => {
        const link = this.#adopt(from, pending, event.channel, peerIdForSlot(from))
        const announce = () => {
          for (const fn of this.#incoming) fn(link)
        }
        if (event.channel.readyState === 'open') announce()
        else event.channel.onopen = announce
      }

      await pending.connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      pending.remoteReady = true
      await this.#flushCandidates(pending)
      const answer = await pending.connection.createAnswer()
      await pending.connection.setLocalDescription(answer)
      this.#signal.signal(from, { kind: 'answer', sdp: answer.sdp ?? '' })
      return
    }

    const pending = this.#pending.get(from)
    if (!pending) return

    if (payload.kind === 'answer') {
      await pending.connection.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      pending.remoteReady = true
      await this.#flushCandidates(pending)
      return
    }

    // Un candidat peut arriver avant la description distante : l'ajouter tout
    // de suite lèverait. On le met de côté et on le rejoue après coup.
    if (!pending.remoteReady) {
      pending.earlyCandidates.push(payload.candidate)
      return
    }
    await pending.connection.addIceCandidate(payload.candidate)
  }

  async #flushCandidates(pending: Pending): Promise<void> {
    const queued = pending.earlyCandidates.splice(0)
    for (const candidate of queued) {
      try {
        await pending.connection.addIceCandidate(candidate)
      } catch {
        // Un candidat périmé n'invalide pas les autres.
      }
    }
  }

  advertise(_advert: SessionAdvert): Promise<void> {
    return Promise.reject(
      new TransportError('WebRTC ne s’annonce pas : la mise en relation passe par le relay', 'webrtc'),
    )
  }

  stopAdvertising(): Promise<void> {
    return Promise.resolve()
  }

  // eslint-disable-next-line require-yield -- pas de découverte en WebRTC
  async *discover(): AsyncIterable<DiscoveredSession> {
    // La découverte appartient au relay ou au QR, jamais à WebRTC lui-même.
  }

  connect(target: DiscoveredSession): Promise<Link> {
    return this.connectToHost(target.advert.hostName)
  }

  close(): Promise<void> {
    this.#unsubscribe()
    for (const link of [...this.#links.values()]) link.close('transport fermé')
    this.#links.clear()
    for (const pending of this.#pending.values()) pending.connection.close()
    this.#pending.clear()
    this.#incoming.clear()
    return Promise.resolve()
  }
}
