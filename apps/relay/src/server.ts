import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  type ClientMessage,
  HOST_SLOT,
  type RoomSummary,
  type ServerMessage,
  type Slot,
  networkKey,
  readSlot,
  withSlot,
} from './protocol.js'

export interface RelayOptions {
  readonly port?: number
  /** Places invitées par salle. Une de moins que le nombre de joueurs. */
  readonly maxGuests?: number
  /** Durée de vie d'une salle inactive. */
  readonly roomTtlMs?: number
  /** Tentatives de connexion ratées tolérées par adresse et par fenêtre. */
  readonly maxFailedJoins?: number
  readonly rateWindowMs?: number
  readonly now?: () => number
}

interface Guest {
  readonly slot: Slot
  readonly socket: WebSocket
  readonly name: string
}

interface Room {
  readonly code: string
  readonly sessionId: string
  readonly hostName: string
  readonly roomName: string
  /** Réseau d'où l'hôte se connecte. Détermine qui verra cette salle. */
  readonly network: string
  readonly host: WebSocket
  readonly guests: Map<Slot, Guest>
  lastSeenMs: number
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

/**
 * Serveur de rendez-vous.
 *
 * Ne joue pas : il n'est ni hub ni hôte au sens du socle, seulement un fil.
 * L'hôte reste le centre de l'étoile — il ouvre une connexion, chaque invité
 * la sienne, et le relay multiplexe. Ce choix garde un seul modèle de
 * topologie pour tous les transports : ce qui marche en BLE marche ici sans
 * code différent.
 *
 * Il ne désérialise jamais une trame de jeu. Cela le rend indifférent aux
 * évolutions du protocole, et lui interdit d'être un point de fuite.
 */
export class RelayServer {
  readonly #wss: WebSocketServer
  readonly #http: Server
  readonly #rooms = new Map<string, Room>()
  readonly #roomOf = new WeakMap<WebSocket, { room: Room; slot: Slot }>()
  readonly #failures = new Map<string, { count: number; resetAtMs: number }>()

  readonly #maxGuests: number
  readonly #roomTtlMs: number
  readonly #maxFailedJoins: number
  readonly #rateWindowMs: number
  readonly #now: () => number
  #sweeper: NodeJS.Timeout | undefined

  constructor(options: RelayOptions = {}) {
    this.#maxGuests = options.maxGuests ?? 3
    this.#roomTtlMs = options.roomTtlMs ?? 30 * 60_000
    this.#maxFailedJoins = options.maxFailedJoins ?? 20
    this.#rateWindowMs = options.rateWindowMs ?? 60_000
    this.#now = options.now ?? (() => Date.now())

    this.#http = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`tictacdoh relay — ${this.#rooms.size} salle(s)\n`)
    })
    this.#wss = new WebSocketServer({ server: this.#http })
    this.#wss.on('connection', (socket, request) => {
      // `x-forwarded-for` d'abord : derrière un reverse proxy, l'adresse de la
      // socket est celle du proxy, et toutes les salles se retrouveraient sur
      // le même « réseau ».
      const forwarded = String(request.headers['x-forwarded-for'] ?? '')
        .split(',')[0]
        ?.trim()
      const address = forwarded || request.socket.remoteAddress || 'inconnu'
      socket.on('message', (data, isBinary) => {
        if (isBinary) this.#onData(socket, new Uint8Array(data as Buffer))
        else this.#onControl(socket, address, String(data))
      })
      socket.on('close', () => this.#onClose(socket))
      socket.on('error', () => socket.close())
    })

    this.#sweeper = setInterval(() => this.#sweep(), 60_000)
    this.#sweeper.unref?.()
  }

  listen(port = 8787): Promise<number> {
    return new Promise((resolve) => {
      this.#http.listen(port, () => {
        const address = this.#http.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  get roomCount(): number {
    return this.#rooms.size
  }

  /**
   * Un code court se force par essais répétés : six chiffres ne font qu'un
   * million de possibilités. On compte les échecs par adresse, et on refuse
   * au-delà du seuil — sans quoi la « sécurité » du code n'en serait pas une.
   */
  #rateLimited(address: string): number | undefined {
    const now = this.#now()
    const entry = this.#failures.get(address)
    if (!entry || now > entry.resetAtMs) return undefined
    if (entry.count < this.#maxFailedJoins) return undefined
    return entry.resetAtMs - now
  }

  #recordFailure(address: string): void {
    const now = this.#now()
    const entry = this.#failures.get(address)
    if (!entry || now > entry.resetAtMs) {
      this.#failures.set(address, { count: 1, resetAtMs: now + this.#rateWindowMs })
      return
    }
    entry.count++
  }

  #onControl(socket: WebSocket, address: string, raw: string): void {
    let message: ClientMessage
    try {
      message = JSON.parse(raw) as ClientMessage
    } catch {
      send(socket, { t: 'error', reason: 'message de contrôle illisible' })
      return
    }

    switch (message.t) {
      case 'host':
        this.#onHost(socket, address, message)
        return
      case 'join':
        this.#onJoin(socket, address, message)
        return
      case 'list':
        this.#onList(socket, address)
        return
      case 'signal':
        this.#onSignal(socket, message)
        return
      case 'close':
        this.#onCloseRoom(socket)
        return
      case 'bye':
        socket.close()
        return
      default:
        send(socket, { t: 'error', reason: 'message de contrôle inconnu' })
    }
  }

  /**
   * Salles visibles depuis ce réseau.
   *
   * Volontairement pas *toutes* les salles : le relay est mondial, les
   * énumérer publierait qui joue et rendrait le code court inutile. Ne
   * remonter que le même réseau donne une proximité qui a du sens sans rien
   * exposer au-delà.
   */
  #onList(socket: WebSocket, address: string): void {
    const network = networkKey(address)
    const rooms: RoomSummary[] = []
    for (const room of this.#rooms.values()) {
      if (room.network !== network) continue
      rooms.push({
        code: room.code,
        roomName: room.roomName,
        hostName: room.hostName,
        playerCount: room.guests.size + 1,
        maxPlayers: this.#maxGuests + 1,
      })
    }
    send(socket, { t: 'rooms', rooms })
  }

  #onHost(socket: WebSocket, address: string, message: Extract<ClientMessage, { t: 'host' }>): void {
    if (!/^[0-9]{4,9}$/.test(message.code)) {
      send(socket, { t: 'error', reason: 'code invalide' })
      return
    }
    if (this.#rooms.has(message.code)) {
      // Deux salles sous le même code rendraient la résolution ambiguë : on
      // refuse plutôt que de choisir arbitrairement.
      send(socket, { t: 'error', reason: 'code déjà utilisé, en tirer un autre' })
      return
    }

    const room: Room = {
      code: message.code,
      sessionId: message.sessionId,
      hostName: message.name,
      roomName: message.roomName || `Partie de ${message.name}`,
      network: networkKey(address),
      host: socket,
      guests: new Map(),
      lastSeenMs: this.#now(),
    }
    this.#rooms.set(room.code, room)
    this.#roomOf.set(socket, { room, slot: HOST_SLOT })
    send(socket, { t: 'hosting', code: room.code })
  }

  #onJoin(socket: WebSocket, address: string, message: Extract<ClientMessage, { t: 'join' }>): void {
    const retryAfterMs = this.#rateLimited(address)
    if (retryAfterMs !== undefined) {
      send(socket, { t: 'error', reason: 'trop de tentatives', retryAfterMs })
      return
    }

    const room = this.#rooms.get(message.code)
    if (!room) {
      this.#recordFailure(address)
      send(socket, { t: 'error', reason: 'aucune partie sous ce code' })
      return
    }
    if (room.guests.size >= this.#maxGuests) {
      send(socket, { t: 'error', reason: 'partie complète' })
      return
    }

    let slot = 1
    while (room.guests.has(slot)) slot++

    const guest: Guest = { slot, socket, name: message.name }
    room.guests.set(slot, guest)
    room.lastSeenMs = this.#now()
    this.#roomOf.set(socket, { room, slot })

    send(socket, {
      t: 'joined',
      slot,
      hostName: room.hostName,
      roomName: room.roomName,
      sessionId: room.sessionId,
    })
    send(room.host, { t: 'peer-joined', slot, name: message.name })
  }

  /**
   * Achemine une mise en relation WebRTC entre deux membres d'une salle.
   *
   * `data` n'est jamais lu : le relay ignore ce qu'est une offre SDP. Il
   * vérifie seulement que les deux parties sont dans la même salle — sans quoi
   * il servirait de tremplin pour envoyer n'importe quoi à n'importe qui.
   */
  #onSignal(socket: WebSocket, message: Extract<ClientMessage, { t: 'signal' }>): void {
    const entry = this.#roomOf.get(socket)
    if (!entry) return
    entry.room.lastSeenMs = this.#now()

    const target =
      message.to === HOST_SLOT ? entry.room.host : entry.room.guests.get(message.to)?.socket
    if (!target) return
    // Un invité ne peut parler qu'à l'hôte : la topologie en étoile vaut aussi
    // pour la mise en relation.
    if (entry.slot !== HOST_SLOT && message.to !== HOST_SLOT) return

    send(target, { t: 'signal', from: entry.slot, data: message.data })
  }

  /**
   * Fermeture volontaire d'une salle par son créateur.
   *
   * Seul l'hôte peut le faire : un invité qui fermerait la partie des autres
   * serait un moyen de nuisance évident. Les invités sont prévenus avant d'être
   * déconnectés, sinon leur écran resterait figé sur une salle qui n'existe
   * plus.
   */
  #onCloseRoom(socket: WebSocket): void {
    const entry = this.#roomOf.get(socket)
    if (!entry || entry.slot !== HOST_SLOT) {
      send(socket, { t: 'error', reason: 'seul le créateur ferme la salle' })
      return
    }
    for (const guest of entry.room.guests.values()) {
      send(guest.socket, { t: 'closed', reason: 'la salle a été fermée' })
      guest.socket.close()
    }
    this.#rooms.delete(entry.room.code)
    this.#roomOf.delete(socket)
    send(socket, { t: 'closed', reason: 'salle fermée' })
  }

  #onData(socket: WebSocket, frame: Uint8Array): void {
    const entry = this.#roomOf.get(socket)
    if (!entry) return
    entry.room.lastSeenMs = this.#now()

    if (entry.slot === HOST_SLOT) {
      // L'hôte adresse une place précise : le premier octet la désigne.
      const { slot, payload } = readSlot(frame)
      const guest = entry.room.guests.get(slot)
      if (guest && guest.socket.readyState === guest.socket.OPEN) {
        guest.socket.send(payload)
      }
      return
    }

    // Un invité n'a qu'un interlocuteur : ses trames partent nues, et c'est le
    // relay qui rappelle à l'hôte de qui elles viennent.
    if (entry.room.host.readyState === entry.room.host.OPEN) {
      entry.room.host.send(withSlot(entry.slot, frame))
    }
  }

  #onClose(socket: WebSocket): void {
    const entry = this.#roomOf.get(socket)
    if (!entry) return
    this.#roomOf.delete(socket)

    if (entry.slot === HOST_SLOT) {
      // L'hôte parti, la salle n'a plus de centre : les invités ne peuvent
      // plus se joindre entre eux. On ferme franchement plutôt que de laisser
      // des joueurs dans une partie qui n'existe plus.
      for (const guest of entry.room.guests.values()) guest.socket.close()
      this.#rooms.delete(entry.room.code)
      return
    }

    entry.room.guests.delete(entry.slot)
    send(entry.room.host, { t: 'peer-left', slot: entry.slot })
  }

  #sweep(): void {
    const now = this.#now()
    for (const [code, room] of this.#rooms) {
      if (now - room.lastSeenMs <= this.#roomTtlMs) continue
      room.host.close()
      for (const guest of room.guests.values()) guest.socket.close()
      this.#rooms.delete(code)
    }
    for (const [address, entry] of this.#failures) {
      if (now > entry.resetAtMs) this.#failures.delete(address)
    }
  }

  async close(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper)
    for (const room of this.#rooms.values()) {
      room.host.close()
      for (const guest of room.guests.values()) guest.socket.close()
    }
    this.#rooms.clear()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.#http.close(() => resolve()))
  }
}
