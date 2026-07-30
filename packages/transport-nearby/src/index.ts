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
import { fromBase64, toBase64 } from '@ttd/transport-ble'
import type { NearbyPlugin, NearbyPluginListener } from './plugin.js'

export * from './plugin.js'

/**
 * Capacités du Wi-Fi Direct.
 *
 * Sans commune mesure avec le BLE : plusieurs centaines de kilo-octets par
 * seconde et de gros paquets. C'est ce qui permet à un même mini-jeu d'y
 * tourner à pleine cadence réseau alors qu'il descend à 15 Hz en Bluetooth,
 * sans une ligne de code différente.
 */
export const NEARBY_CAPS: TransportCaps = {
  kind: 'nearby',
  maxPayloadBytes: 32 * 1024,
  throughputBytesPerSec: 512 * 1024,
  rttHintMs: 25,
  maxPeers: 4,
  canAdvertise: true,
  canDiscover: true,
  reliable: true,
  ordered: true,
  requiresInternet: false,
}

/** Préfixe du nom d'endpoint, suivi du code court. */
const NAME_PREFIX = 'ttd-'

export function endpointNameFor(code: string, hostName: string): string {
  // Le code voyage en clair dans le nom : c'est le seul champ lisible pendant
  // la découverte Nearby, donc le seul filtre disponible avant connexion.
  return `${NAME_PREFIX}${code}-${hostName.slice(0, 16)}`
}

export function codeFromEndpointName(name: string): string | undefined {
  if (!name.startsWith(NAME_PREFIX)) return undefined
  const rest = name.slice(NAME_PREFIX.length)
  const code = rest.split('-', 1)[0]
  return code && /^[0-9]{4,9}$/.test(code) ? code : undefined
}

class NearbyLink implements Link {
  readonly #events = new Emitter<LinkEvents>()
  #closed = false

  constructor(
    readonly peerId: PeerId,
    readonly caps: TransportCaps,
    private readonly plugin: NearbyPlugin,
    private readonly onClosed: (link: NearbyLink) => void,
  ) {}

  get closed(): boolean {
    return this.#closed
  }

  send(payload: Uint8Array): void {
    if (this.#closed) return
    void this.plugin
      .send({ endpointId: this.peerId, data: toBase64(payload) })
      .catch((error: Error) => this.close(`envoi impossible: ${error.message}`))
  }

  accept(payload: Uint8Array): void {
    if (this.#closed) return
    this.#events.emit('message', payload)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    void this.plugin.disconnect({ endpointId: this.peerId }).catch(() => undefined)
    this.#events.emit('close', { reason })
    this.onClosed(this)
  }

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }
}

export interface NearbyTransportOptions {
  readonly plugin: NearbyPlugin
  readonly serviceId: string
}

/**
 * Transport « à proximité » : Wi-Fi Direct sur Android, Multipeer sur iOS.
 *
 * **Ne relie que des appareils de même famille.** Nearby Connections et
 * MultipeerConnectivity n'ont aucun protocole commun, et rien dans le socle ne
 * peut y remédier. C'est précisément pourquoi le BLE existe ici : il est lent,
 * mais il est le seul à traverser la frontière iOS/Android hors ligne.
 *
 * Quand il fonctionne, il est de loin le meilleur choix hors-ligne — d'où sa
 * place devant WebRTC et le relay dans l'ordre de préférence des tickets.
 */
export class NearbyTransport implements Transport {
  readonly caps = NEARBY_CAPS

  readonly #plugin: NearbyPlugin
  readonly #serviceId: string
  readonly #incoming = new Set<(link: Link) => void>()
  readonly #links = new Map<PeerId, NearbyLink>()
  readonly #listeners: NearbyPluginListener[] = []
  readonly #found = new Map<string, DiscoveredSession>()
  readonly #waiters = new Set<(session: DiscoveredSession) => void>()
  readonly #pendingConnects = new Map<string, (link: Link) => void>()

  #advertising = false
  #ready: Promise<void> | undefined

  constructor(options: NearbyTransportOptions) {
    this.#plugin = options.plugin
    this.#serviceId = options.serviceId
  }

  onIncoming(fn: (link: Link) => void): Unsubscribe {
    this.#incoming.add(fn)
    return () => void this.#incoming.delete(fn)
  }

  async #ensureListeners(): Promise<void> {
    if (this.#ready) return this.#ready
    this.#ready = (async () => {
      this.#listeners.push(
        await this.#plugin.addListener('endpointFound', (event) => {
          const code = codeFromEndpointName(event.endpointName)
          if (code === undefined) return
          const session: DiscoveredSession = {
            advert: {
              sessionId: '',
              code,
              hostName: event.endpointName.slice(NAME_PREFIX.length + code.length + 1),
              playerCount: 0,
              maxPlayers: 4,
            },
            kind: 'nearby',
            address: event.endpointId,
          }
          this.#found.set(event.endpointId, session)
          for (const waiter of this.#waiters) waiter(session)
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('endpointLost', (event) => {
          this.#found.delete(event.endpointId)
        }),
      )

      // Les deux piles exigent une acceptation de part et d'autre. Le code
      // court a déjà filtré : on accepte sans redemander à l'utilisateur.
      this.#listeners.push(
        await this.#plugin.addListener('connectionRequested', (event) => {
          void this.#plugin.acceptConnection({ endpointId: event.endpointId }).catch(() => undefined)
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('connected', (event) => {
          const link = new NearbyLink(event.endpointId, NEARBY_CAPS, this.#plugin, (closed) => {
            this.#links.delete(closed.peerId)
          })
          this.#links.set(event.endpointId, link)

          const waiting = this.#pendingConnects.get(event.endpointId)
          if (waiting) {
            this.#pendingConnects.delete(event.endpointId)
            waiting(link)
            return
          }
          for (const fn of this.#incoming) fn(link)
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('disconnected', (event) => {
          this.#links.get(event.endpointId)?.close(event.reason ?? 'déconnecté')
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('received', (event) => {
          this.#links.get(event.endpointId)?.accept(fromBase64(event.data))
        }),
      )
    })()
    return this.#ready
  }

  async advertise(advert: SessionAdvert): Promise<void> {
    const availability = await this.#plugin.isAvailable()
    if (!availability.available) {
      throw new TransportError(availability.reason ?? 'Wi-Fi Direct indisponible', 'nearby')
    }
    await this.#ensureListeners()
    this.#advertising = true
    await this.#plugin.startAdvertising({
      serviceId: this.#serviceId,
      endpointName: endpointNameFor(advert.code, advert.hostName),
    })
  }

  async stopAdvertising(): Promise<void> {
    this.#advertising = false
    await this.#plugin.stopAdvertising()
  }

  async *discover(signal?: AbortSignal): AsyncIterable<DiscoveredSession> {
    await this.#ensureListeners()
    await this.#plugin.startDiscovery({ serviceId: this.#serviceId })
    try {
      for (const session of this.#found.values()) yield session
      while (!signal?.aborted) {
        const next = await new Promise<DiscoveredSession | undefined>((resolve) => {
          const waiter = (session: DiscoveredSession) => {
            this.#waiters.delete(waiter)
            resolve(session)
          }
          this.#waiters.add(waiter)
          signal?.addEventListener(
            'abort',
            () => {
              this.#waiters.delete(waiter)
              resolve(undefined)
            },
            { once: true },
          )
        })
        if (!next) return
        yield next
      }
    } finally {
      await this.#plugin.stopDiscovery()
    }
  }

  /** Cherche l'hôte portant ce code, en lisant le nom d'endpoint. */
  async findByCode(code: string, timeoutMs = 10_000): Promise<DiscoveredSession> {
    await this.#ensureListeners()
    await this.#plugin.startDiscovery({ serviceId: this.#serviceId })
    try {
      const found = await new Promise<DiscoveredSession | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(waiter)
          resolve(undefined)
        }, timeoutMs)
        const waiter = (session: DiscoveredSession) => {
          if (session.advert.code !== code) return
          this.#waiters.delete(waiter)
          clearTimeout(timer)
          resolve(session)
        }
        this.#waiters.add(waiter)
        for (const session of this.#found.values()) waiter(session)
      })
      if (!found) throw new TransportError(`aucune partie « ${code} » à proximité`, 'nearby')
      return found
    } finally {
      await this.#plugin.stopDiscovery()
    }
  }

  connect(target: DiscoveredSession, timeoutMs = 15_000): Promise<Link> {
    return this.#ensureListeners().then(
      () =>
        new Promise<Link>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#pendingConnects.delete(target.address)
            reject(new TransportError('délai dépassé pour la connexion à proximité', 'nearby'))
          }, timeoutMs)

          this.#pendingConnects.set(target.address, (link) => {
            clearTimeout(timer)
            resolve(link)
          })

          void this.#plugin
            .requestConnection({
              endpointId: target.address,
              endpointName: endpointNameFor(target.advert.code, 'invite'),
            })
            .catch((error: Error) => {
              clearTimeout(timer)
              this.#pendingConnects.delete(target.address)
              reject(new TransportError(error.message, 'nearby'))
            })
        }),
    )
  }

  async close(): Promise<void> {
    for (const link of [...this.#links.values()]) link.close('transport fermé')
    this.#links.clear()
    this.#incoming.clear()
    this.#found.clear()
    this.#waiters.clear()
    this.#pendingConnects.clear()
    if (this.#advertising) await this.stopAdvertising().catch(() => undefined)
    for (const listener of this.#listeners) await listener.remove().catch(() => undefined)
    this.#listeners.length = 0
    this.#ready = undefined
  }
}
