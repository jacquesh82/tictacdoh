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

/**
 * Capacités du chemin relayé.
 *
 * `canDiscover` vaut `true`, mais la découverte est **limitée au réseau de
 * l'appelant**. Énumérer toutes les salles du relay transformerait le code
 * court en formalité et publierait qui joue ; ne montrer que celles du même
 * réseau donne une proximité réelle sans rien exposer au-delà du Wi-Fi local.
 */
export const WS_CAPS: TransportCaps = {
  kind: 'ws',
  maxPayloadBytes: 64 * 1024,
  throughputBytesPerSec: 128 * 1024,
  rttHintMs: 90,
  maxPeers: 4,
  canAdvertise: true,
  canDiscover: true,
  reliable: true,
  ordered: true,
  requiresInternet: true,
}

const HOST_SLOT = 0

interface ServerJoined {
  t: 'joined'
  slot: number
  hostName: string
  roomName: string
  sessionId: string
}

/** Salle annoncée par le relay dans la liste de proximité. */
export interface RoomSummary {
  readonly code: string
  readonly roomName: string
  readonly hostName: string
  readonly playerCount: number
  readonly maxPlayers: number
}

interface ServerPeerJoined {
  t: 'peer-joined'
  slot: number
  name: string
}

type ServerMessage =
  | { t: 'hosting'; code: string }
  | ServerJoined
  | ServerPeerJoined
  | { t: 'peer-left'; slot: number }
  | { t: 'signal'; from: number; data: unknown }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'closed'; reason: string }
  | { t: 'error'; reason: string; retryAfterMs?: number }

/** Un lien vers un pair, taillé dans la connexion partagée au relay. */
class WsLink implements Link {
  readonly #events = new Emitter<LinkEvents>()
  #closed = false

  constructor(
    readonly peerId: PeerId,
    readonly caps: TransportCaps,
    private readonly write: (payload: Uint8Array) => void,
    private readonly onClose: (link: WsLink) => void,
  ) {}

  get closed(): boolean {
    return this.#closed
  }

  send(payload: Uint8Array): void {
    if (this.#closed) return
    this.write(payload)
  }

  /** Remise d'un message à ce lien. Appelé par le transport. */
  accept(payload: Uint8Array): void {
    if (this.#closed) return
    this.#events.emit('message', payload)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    this.#events.emit('close', { reason })
    this.onClose(this)
  }

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }
}

export interface WsTransportOptions {
  readonly url: string
  readonly selfName: string
  /** Fabrique de WebSocket, pour les tests et les coquilles natives. */
  readonly socketFactory?: (url: string) => WebSocket
}

export interface JoinedRoom {
  readonly link: Link
  readonly hostName: string
  readonly roomName: string
  readonly sessionId: string
  readonly slot: number
}

/**
 * Transport par relay.
 *
 * Une seule connexion WebSocket, démultiplexée en autant de liens que de
 * pairs. C'est ce qui permet de garder la topologie en étoile du BLE : l'hôte
 * reste le centre, le relay n'est qu'un fil, et le socle au-dessus ne voit
 * aucune différence.
 */
export class WsTransport implements Transport {
  readonly caps = WS_CAPS

  readonly #url: string
  readonly #selfName: string
  readonly #factory: (url: string) => WebSocket
  readonly #incoming = new Set<(link: Link) => void>()
  readonly #links = new Map<number, WsLink>()
  readonly #signalListeners = new Set<(from: number, data: unknown) => void>()
  /** Nom affichable par identifiant de pair. L'identifiant, lui, est la place. */
  readonly #names = new Map<PeerId, string>()

  #socket: WebSocket | undefined
  #isHost = false
  #slot = HOST_SLOT

  constructor(options: WsTransportOptions) {
    this.#url = options.url
    this.#selfName = options.selfName
    this.#factory =
      options.socketFactory ??
      ((url) => {
        if (typeof WebSocket === 'undefined') {
          throw new TransportError('WebSocket absent de cet environnement', 'ws')
        }
        return new WebSocket(url)
      })
  }

  onIncoming(fn: (link: Link) => void): Unsubscribe {
    this.#incoming.add(fn)
    return () => void this.#incoming.delete(fn)
  }

  async #connect(): Promise<WebSocket> {
    if (this.#socket && this.#socket.readyState === this.#socket.OPEN) return this.#socket
    const socket = this.#factory(this.#url)
    socket.binaryType = 'arraybuffer'
    this.#socket = socket

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        socket.removeEventListener('open', onOpen)
        reject(new TransportError(`relay injoignable: ${this.#url}`, 'ws'))
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })

    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => this.#onSocketClosed())
    return socket
  }

  #send(message: unknown): void {
    this.#socket?.send(JSON.stringify(message))
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      this.#onControl(JSON.parse(event.data) as ServerMessage)
      return
    }
    const frame = new Uint8Array(event.data as ArrayBuffer)
    if (this.#isHost) {
      // Vers l'hôte, le premier octet désigne l'expéditeur.
      const slot = frame[0] ?? 0
      this.#links.get(slot)?.accept(frame.subarray(1).slice())
      return
    }
    this.#links.get(HOST_SLOT)?.accept(frame.slice())
  }

  #onControl(message: ServerMessage): void {
    switch (message.t) {
      case 'peer-joined': {
        const link = this.#makeLink(message.slot, message.name)
        for (const fn of this.#incoming) fn(link)
        return
      }
      case 'peer-left':
        this.#links.get(message.slot)?.close('parti')
        return
      case 'signal':
        for (const fn of this.#signalListeners) fn(message.from, message.data)
        return
      case 'closed':
        this.#onSocketClosed()
        return
      default:
        return
    }
  }

  /**
   * Voie de mise en relation, utilisée par WebRTC.
   *
   * Le transport relayé sert ici de tremplin vers un transport qui s'en
   * passera : une fois le pair à pair établi, plus rien ne transite par le
   * serveur. C'est le seul moyen pratique d'amorcer WebRTC, dont l'échange
   * d'offres suppose déjà un canal.
   */
  signal(to: number, data: unknown): void {
    this.#send({ t: 'signal', to, data })
  }

  onSignal(fn: (from: number, data: unknown) => void): Unsubscribe {
    this.#signalListeners.add(fn)
    return () => void this.#signalListeners.delete(fn)
  }

  /**
   * Identifiant d'un pair : sa place, jamais son nom.
   *
   * Deux transports doivent pouvoir désigner la même personne pour que l'hôte
   * reconnaisse un invité arrivé par le relay puis par le pair à pair. Un nom
   * ne le permet pas — deux joueurs peuvent s'appeler pareil, et WebRTC ne le
   * connaît pas. La place, elle, est attribuée une fois par le relay et vaut
   * pour les deux chemins.
   */
  static peerIdForSlot(slot: number): PeerId {
    return `slot-${slot}`
  }

  /** Nom affichable d'un pair, si le relay l'a communiqué. */
  peerName(peerId: PeerId): string | undefined {
    return this.#names.get(peerId)
  }

  #makeLink(slot: number, name: string): WsLink {
    const peerId = WsTransport.peerIdForSlot(slot)
    this.#names.set(peerId, name)
    const link = new WsLink(
      peerId,
      WS_CAPS,
      (payload) => {
        // L'hôte préfixe la destination ; un invité n'a qu'un interlocuteur et
        // envoie donc ses trames nues. Un octet économisé sur le chemin le
        // plus fréquent.
        if (this.#isHost) {
          const out = new Uint8Array(payload.length + 1)
          out[0] = slot
          out.set(payload, 1)
          this.#socket?.send(out)
        } else {
          this.#socket?.send(payload)
        }
      },
      () => void this.#links.delete(slot),
    )
    this.#links.set(slot, link)
    return link
  }

  #onSocketClosed(): void {
    for (const link of [...this.#links.values()]) link.close('relay déconnecté')
    this.#links.clear()
  }

  /** Ouvre une salle sur le relay et devient joignable par son code. */
  async advertise(advert: SessionAdvert): Promise<void> {
    await this.#connect()
    this.#isHost = true
    this.#slot = HOST_SLOT

    const accepted = new Promise<void>((resolve, reject) => {
      const socket = this.#socket!
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as ServerMessage
        if (message.t === 'hosting') {
          socket.removeEventListener('message', onMessage)
          resolve()
        } else if (message.t === 'error') {
          socket.removeEventListener('message', onMessage)
          reject(new TransportError(message.reason, 'ws'))
        }
      }
      socket.addEventListener('message', onMessage)
    })

    this.#send({
      t: 'host',
      sessionId: advert.sessionId,
      code: advert.code,
      name: advert.hostName,
      roomName: advert.roomName ?? '',
    })
    await accepted
  }

  stopAdvertising(): Promise<void> {
    this.#send({ t: 'bye' })
    return Promise.resolve()
  }

  /**
   * Ferme la salle et congédie les invités. Réservé au créateur.
   *
   * Se distingue d'un simple départ : la salle disparaît immédiatement de la
   * liste au lieu d'attendre son expiration, et les invités sont prévenus
   * plutôt que de rester devant un écran figé.
   */
  closeRoom(): Promise<void> {
    this.#send({ t: 'close' })
    return this.close()
  }

  /**
   * Rejoint par le code court.
   *
   * Le relay résout le code sans jamais énumérer les salles : c'est ce qui
   * donne au code sa valeur de secret, et ce qui rend le comptage des échecs
   * côté serveur indispensable.
   */
  async joinByCode(code: string): Promise<JoinedRoom> {
    await this.#connect()
    this.#isHost = false

    const joined = new Promise<ServerJoined>((resolve, reject) => {
      const socket = this.#socket!
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as ServerMessage
        if (message.t === 'joined') {
          socket.removeEventListener('message', onMessage)
          resolve(message)
        } else if (message.t === 'error') {
          socket.removeEventListener('message', onMessage)
          const suffix =
            message.retryAfterMs === undefined
              ? ''
              : ` (réessayer dans ${Math.ceil(message.retryAfterMs / 1000)} s)`
          reject(new TransportError(message.reason + suffix, 'ws'))
        }
      }
      socket.addEventListener('message', onMessage)
    })

    this.#send({ t: 'join', code, name: this.#selfName })
    const result = await joined
    this.#slot = result.slot

    const link = this.#makeLink(HOST_SLOT, result.hostName)
    return {
      link,
      hostName: result.hostName,
      roomName: result.roomName,
      sessionId: result.sessionId,
      slot: result.slot,
    }
  }

  get slot(): number {
    return this.#slot
  }

  /**
   * Salles ouvertes sur le même réseau.
   *
   * Le relay ne remonte que celles-là : les énumérer toutes publierait qui
   * joue partout dans le monde et rendrait le code court inutile.
   */
  async listRooms(timeoutMs = 4000): Promise<RoomSummary[]> {
    await this.#connect()
    const answer = new Promise<RoomSummary[]>((resolve) => {
      const socket = this.#socket!
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage)
        resolve([])
      }, timeoutMs)
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as ServerMessage
        if (message.t !== 'rooms') return
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
        resolve(message.rooms)
      }
      socket.addEventListener('message', onMessage)
    })
    this.#send({ t: 'list' })
    return answer
  }

  async *discover(signal?: AbortSignal): AsyncIterable<DiscoveredSession> {
    for (const room of await this.listRooms()) {
      if (signal?.aborted) return
      yield {
        advert: {
          sessionId: '',
          code: room.code,
          hostName: room.hostName,
          roomName: room.roomName,
          playerCount: room.playerCount,
          maxPlayers: room.maxPlayers,
        },
        kind: 'ws',
        address: room.code,
      }
    }
  }

  async connect(target: DiscoveredSession): Promise<Link> {
    const { link } = await this.joinByCode(target.advert.code)
    return link
  }

  close(): Promise<void> {
    this.#socket?.close()
    this.#socket = undefined
    this.#onSocketClosed()
    return Promise.resolve()
  }
}
