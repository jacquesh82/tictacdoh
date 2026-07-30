import {
  BLE_LINK_BYTES_PER_SEC,
  BLE_SAFE_PAYLOAD_BYTES,
} from '@ttd/wire'
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
import { fingerprintBytes } from '@ttd/join'
import {
  type BleMeshPlugin,
  type BlePluginListener,
  fromBase64,
  toBase64,
  toHex,
} from './plugin.js'

export * from './plugin.js'

/**
 * En-tête ATT d'une notification. La charge utile disponible vaut donc
 * `mtu - 3`, et non `mtu`.
 */
const ATT_HEADER_BYTES = 3

/** MTU par défaut du BLE avant négociation. */
const DEFAULT_ATT_MTU = 23

/**
 * Capacités déduites de la MTU réellement négociée.
 *
 * Ce n'est pas une constante, contrairement aux autres transports : la MTU BLE
 * se négocie par connexion et varie du simple au vingtuple selon les piles —
 * 23 octets sur un vieil Android, 185 sur iOS, jusqu'à 517 ailleurs. Annoncer
 * une valeur fixe ferait soit gaspiller la bande passante disponible, soit
 * dépasser ce que le lien accepte réellement.
 *
 * Le débit, lui, reste la valeur conservatrice de référence : il dépend surtout
 * de l'intervalle de connexion, que l'application ne maîtrise pas.
 */
export function capsForMtu(mtu: number): TransportCaps {
  const usable = Math.max(20, Math.min(mtu, 517) - ATT_HEADER_BYTES)
  return {
    kind: 'ble',
    maxPayloadBytes: usable,
    throughputBytesPerSec: BLE_LINK_BYTES_PER_SEC,
    rttHintMs: 60,
    maxPeers: 4,
    canAdvertise: true,
    canDiscover: true,
    reliable: true,
    ordered: true,
    requiresInternet: false,
  }
}

/** Capacités de référence, avant toute négociation. */
export const BLE_CAPS: TransportCaps = capsForMtu(BLE_SAFE_PAYLOAD_BYTES + ATT_HEADER_BYTES)

class BleLink implements Link {
  readonly #events = new Emitter<LinkEvents>()
  #closed = false

  constructor(
    readonly peerId: PeerId,
    readonly caps: TransportCaps,
    private readonly plugin: BleMeshPlugin,
    private readonly onClosed: (link: BleLink) => void,
  ) {}

  get closed(): boolean {
    return this.#closed
  }

  send(payload: Uint8Array): void {
    if (this.#closed) return
    if (payload.length > this.caps.maxPayloadBytes) {
      throw new TransportError(
        `message de ${payload.length} o au-delà de la MTU négociée (${this.caps.maxPayloadBytes} o)`,
        'ble',
      )
    }
    // L'envoi natif est asynchrone mais le contrat de `Link` ne l'est pas :
    // attendre un accusé à chaque trame doublerait la latence pour une garantie
    // que la couche Channel n'utilise pas. Une erreur ferme le lien.
    void this.plugin
      .send({ peerId: this.peerId, data: toBase64(payload) })
      .catch((error: Error) => this.close(`envoi impossible: ${error.message}`))
  }

  accept(payload: Uint8Array): void {
    if (this.#closed) return
    this.#events.emit('message', payload)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    void this.plugin.disconnect({ peerId: this.peerId }).catch(() => {
      // Déconnecter un pair déjà parti n'a pas à remonter.
    })
    this.#events.emit('close', { reason })
    this.onClosed(this)
  }

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe {
    return this.#events.on(event, fn)
  }
}

export interface BleTransportOptions {
  readonly plugin: BleMeshPlugin
  /** UUID de service propre à l'application. Identique sur tous les appareils. */
  readonly serviceUuid: string
  readonly localName?: string
}

/**
 * Transport Bluetooth Low Energy.
 *
 * C'est **le seul chemin hors-ligne entre iOS et Android** : Wi-Fi Direct et
 * MultipeerConnectivity ne se parlent pas. Toute la conception du socle en
 * découle — cadence réseau, redondance des inputs, format binaire compact.
 *
 * La topologie du BLE impose l'étoile, ce qui tombe bien puisque c'est celle du
 * socle : l'hôte s'annonce en périphérique, les autres s'y connectent en
 * centraux. Un central ne peut pas parler à un autre central, d'où le
 * réacheminement par le hub que la `Session` implémente déjà.
 *
 * Un navigateur ne peut pas héberger par ce chemin : Web Bluetooth ne sait pas
 * s'annoncer. Il ne peut que rejoindre, et encore, sous Chrome.
 */
export class BleTransport implements Transport {
  readonly #plugin: BleMeshPlugin
  readonly #serviceUuid: string
  readonly #localName: string
  readonly #incoming = new Set<(link: Link) => void>()
  readonly #links = new Map<PeerId, BleLink>()
  readonly #listeners: BlePluginListener[] = []
  readonly #discovered = new Map<string, DiscoveredSession>()
  readonly #discoveryWaiters = new Set<(session: DiscoveredSession) => void>()

  #caps: TransportCaps = BLE_CAPS
  #advert: SessionAdvert | undefined
  #ready: Promise<void> | undefined

  constructor(options: BleTransportOptions) {
    this.#plugin = options.plugin
    this.#serviceUuid = options.serviceUuid
    this.#localName = options.localName ?? 'ttd'
  }

  /**
   * Capacités courantes.
   *
   * Reflètent la MTU du dernier lien établi : avant toute connexion, ce sont
   * les valeurs de référence.
   */
  get caps(): TransportCaps {
    return this.#caps
  }

  async #ensureListeners(): Promise<void> {
    if (this.#ready) return this.#ready
    this.#ready = (async () => {
      this.#listeners.push(
        await this.#plugin.addListener('discovered', (event) => {
          const session: DiscoveredSession = {
            advert: {
              sessionId: '',
              // Le code complet n'est pas dans l'annonce : 31 octets ne le
              // permettent pas. L'empreinte suffit à filtrer, et le code est
              // vérifié à la connexion.
              code: '',
              hostName: event.name,
              playerCount: 0,
              maxPlayers: 4,
            },
            kind: 'ble',
            address: event.deviceId,
            rssi: event.rssi,
          }
          this.#discovered.set(event.deviceId, session)
          for (const waiter of this.#discoveryWaiters) waiter(session)
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('peerConnected', (event) => {
          const link = this.#adopt(event.peerId, event.mtu)
          for (const fn of this.#incoming) fn(link)
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('peerDisconnected', (event) => {
          this.#links.get(event.peerId)?.close(event.reason ?? 'déconnecté')
        }),
      )

      this.#listeners.push(
        await this.#plugin.addListener('received', (event) => {
          this.#links.get(event.peerId)?.accept(fromBase64(event.data))
        }),
      )
    })()
    return this.#ready
  }

  #adopt(peerId: PeerId, mtu: number): BleLink {
    const caps = capsForMtu(mtu || DEFAULT_ATT_MTU)
    this.#caps = caps
    const link = new BleLink(peerId, caps, this.#plugin, (closed) => {
      this.#links.delete(closed.peerId)
    })
    this.#links.set(peerId, link)
    return link
  }

  onIncoming(fn: (link: Link) => void): Unsubscribe {
    this.#incoming.add(fn)
    return () => void this.#incoming.delete(fn)
  }

  /** S'annonce en périphérique. L'empreinte du code sert de filtre. */
  async advertise(advert: SessionAdvert): Promise<void> {
    const availability = await this.#plugin.isAvailable()
    if (!availability.available) {
      throw new TransportError(availability.reason ?? 'Bluetooth indisponible', 'ble')
    }
    if (!availability.canAdvertise) {
      // Cas du navigateur : Web Bluetooth est central-only. On le dit
      // explicitement plutôt que d'échouer plus tard sans raison lisible.
      throw new TransportError(
        availability.reason ?? 'cet appareil ne peut pas s’annoncer en Bluetooth (central uniquement)',
        'ble',
      )
    }

    await this.#ensureListeners()
    this.#advert = advert
    await this.#plugin.startAdvertising({
      serviceUuid: this.#serviceUuid,
      fingerprintHex: toHex(fingerprintBytes(advert.code)),
      localName: advert.hostName || this.#localName,
    })
  }

  async stopAdvertising(): Promise<void> {
    this.#advert = undefined
    await this.#plugin.stopAdvertising()
  }

  /**
   * Cherche les hôtes à portée.
   *
   * Le flux reste ouvert : en BLE les appareils apparaissent progressivement,
   * il n'existe aucun instant où la découverte serait « terminée ».
   */
  async *discover(signal?: AbortSignal): AsyncIterable<DiscoveredSession> {
    await this.#ensureListeners()
    await this.#plugin.startScan({ serviceUuid: this.#serviceUuid })

    try {
      for (const session of this.#discovered.values()) yield session

      while (!signal?.aborted) {
        const next = await new Promise<DiscoveredSession | undefined>((resolve) => {
          const waiter = (session: DiscoveredSession) => {
            this.#discoveryWaiters.delete(waiter)
            resolve(session)
          }
          this.#discoveryWaiters.add(waiter)
          signal?.addEventListener(
            'abort',
            () => {
              this.#discoveryWaiters.delete(waiter)
              resolve(undefined)
            },
            { once: true },
          )
        })
        if (!next) return
        yield next
      }
    } finally {
      await this.#plugin.stopScan()
    }
  }

  /**
   * Cherche l'hôte qui porte un code donné.
   *
   * Filtre sur l'empreinte, qui tient dans les 31 octets d'une annonce BLE.
   * C'est ce qui évite de présenter au joueur une liste d'appareils anonymes.
   */
  async findByCode(code: string, timeoutMs = 10_000): Promise<DiscoveredSession> {
    await this.#ensureListeners()
    const wanted = toHex(fingerprintBytes(code))
    await this.#plugin.startScan({ serviceUuid: this.#serviceUuid, fingerprintHex: wanted })

    try {
      const found = await new Promise<DiscoveredSession | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.#discoveryWaiters.delete(waiter)
          resolve(undefined)
        }, timeoutMs)
        const waiter = (session: DiscoveredSession) => {
          this.#discoveryWaiters.delete(waiter)
          clearTimeout(timer)
          resolve(session)
        }
        this.#discoveryWaiters.add(waiter)
        for (const session of this.#discovered.values()) waiter(session)
      })
      if (!found) {
        throw new TransportError(`aucune partie « ${code} » à portée Bluetooth`, 'ble')
      }
      return { ...found, advert: { ...found.advert, code } }
    } finally {
      await this.#plugin.stopScan()
    }
  }

  async connect(target: DiscoveredSession): Promise<Link> {
    await this.#ensureListeners()
    const connected = await this.#plugin.connect({ deviceId: target.address })
    return this.#adopt(connected.peerId, connected.mtu)
  }

  async close(): Promise<void> {
    for (const link of [...this.#links.values()]) link.close('transport fermé')
    this.#links.clear()
    this.#incoming.clear()
    this.#discovered.clear()
    this.#discoveryWaiters.clear()
    if (this.#advert) await this.stopAdvertising().catch(() => undefined)
    for (const listener of this.#listeners) await listener.remove().catch(() => undefined)
    this.#listeners.length = 0
    this.#ready = undefined
  }
}
