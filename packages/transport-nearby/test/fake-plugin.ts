import type {
  NearbyAdvertiseOptions,
  NearbyEvents,
  NearbyPlugin,
  NearbyPluginListener,
} from '../src/plugin.js'

/**
 * Réseau « à proximité » simulé, partagé par plusieurs appareils.
 *
 * Reproduit ce qui se vérifie sans matériel : la découverte par nom
 * d'endpoint, la double acceptation qu'exigent Nearby et Multipeer, et
 * l'isolement entre familles de plateformes — un appareil `ios` ne voit jamais
 * un appareil `android`, ce qui est la contrainte la plus importante de ce
 * transport.
 */
export type Platform = 'android' | 'ios'

export class FakeNearbyNetwork {
  readonly #advertisers = new Map<
    string,
    { device: FakeNearbyPlugin; options: NearbyAdvertiseOptions; platform: Platform }
  >()

  advertise(id: string, device: FakeNearbyPlugin, options: NearbyAdvertiseOptions, platform: Platform): void {
    this.#advertisers.set(id, { device, options, platform })
  }

  stopAdvertising(id: string): void {
    this.#advertisers.delete(id)
  }

  visible(serviceId: string, platform: Platform) {
    return [...this.#advertisers.entries()]
      .filter(([, entry]) => entry.options.serviceId === serviceId)
      // Nearby Connections et MultipeerConnectivity n'ont aucun protocole
      // commun : un appareil ne voit que ceux de sa famille.
      .filter(([, entry]) => entry.platform === platform)
      .map(([id, entry]) => ({ id, options: entry.options, device: entry.device }))
  }

  device(id: string): FakeNearbyPlugin | undefined {
    return this.#advertisers.get(id)?.device
  }
}

const later = (fn: () => void) => void setTimeout(fn, 0)

type Listeners = { [K in keyof NearbyEvents]: Set<(payload: NearbyEvents[K]) => void> }

export interface FakeNearbyOptions {
  readonly id: string
  readonly network: FakeNearbyNetwork
  readonly platform?: Platform
  readonly available?: boolean
}

export class FakeNearbyPlugin implements NearbyPlugin {
  readonly id: string
  readonly platform: Platform
  readonly #network: FakeNearbyNetwork
  readonly #available: boolean

  readonly #listeners: Listeners = {
    endpointFound: new Set(),
    endpointLost: new Set(),
    connectionRequested: new Set(),
    connected: new Set(),
    disconnected: new Set(),
    received: new Set(),
    unavailable: new Set(),
  }

  readonly #peers = new Map<string, FakeNearbyPlugin>()
  #discovering: string | undefined

  constructor(options: FakeNearbyOptions) {
    this.id = options.id
    this.platform = options.platform ?? 'android'
    this.#network = options.network
    this.#available = options.available ?? true
  }

  isAvailable(): Promise<{ available: boolean; reason?: string }> {
    return Promise.resolve({
      available: this.#available,
      reason: this.#available ? undefined : 'Wi-Fi désactivé',
    })
  }

  startAdvertising(options: NearbyAdvertiseOptions): Promise<void> {
    this.#network.advertise(this.id, this, options, this.platform)
    return Promise.resolve()
  }

  stopAdvertising(): Promise<void> {
    this.#network.stopAdvertising(this.id)
    return Promise.resolve()
  }

  startDiscovery(options: { serviceId: string }): Promise<void> {
    this.#discovering = options.serviceId
    later(() => {
      if (!this.#discovering) return
      for (const found of this.#network.visible(options.serviceId, this.platform)) {
        if (found.id === this.id) continue
        this.#emit('endpointFound', {
          endpointId: found.id,
          endpointName: found.options.endpointName,
        })
      }
    })
    return Promise.resolve()
  }

  stopDiscovery(): Promise<void> {
    this.#discovering = undefined
    return Promise.resolve()
  }

  requestConnection(options: { endpointId: string; endpointName: string }): Promise<void> {
    const target = this.#network.device(options.endpointId)
    if (!target) return Promise.reject(new Error(`endpoint ${options.endpointId} introuvable`))
    later(() =>
      target.#emit('connectionRequested', {
        endpointId: this.id,
        endpointName: options.endpointName,
      }),
    )
    return Promise.resolve()
  }

  acceptConnection(options: { endpointId: string }): Promise<void> {
    const initiator = this.#network.device(options.endpointId) ?? this.#lookup(options.endpointId)
    if (!initiator) return Promise.reject(new Error(`endpoint ${options.endpointId} introuvable`))

    this.#peers.set(options.endpointId, initiator)
    initiator.#peers.set(this.id, this)
    later(() => {
      this.#emit('connected', { endpointId: options.endpointId, endpointName: options.endpointId })
      initiator.#emit('connected', { endpointId: this.id, endpointName: this.id })
    })
    return Promise.resolve()
  }

  /** Retrouve un initiateur qui n'annonce pas : il n'est pas dans le réseau. */
  #lookup(id: string): FakeNearbyPlugin | undefined {
    return FakeNearbyPlugin.#all.get(id)
  }

  static readonly #all = new Map<string, FakeNearbyPlugin>()

  static register(plugin: FakeNearbyPlugin): FakeNearbyPlugin {
    FakeNearbyPlugin.#all.set(plugin.id, plugin)
    return plugin
  }

  disconnect(options: { endpointId: string }): Promise<void> {
    const peer = this.#peers.get(options.endpointId)
    this.#peers.delete(options.endpointId)
    if (peer) {
      peer.#peers.delete(this.id)
      later(() => peer.#emit('disconnected', { endpointId: this.id }))
    }
    return Promise.resolve()
  }

  send(options: { endpointId: string; data: string }): Promise<void> {
    const peer = this.#peers.get(options.endpointId)
    if (!peer) return Promise.reject(new Error(`endpoint ${options.endpointId} non connecté`))
    later(() => peer.#emit('received', { endpointId: this.id, data: options.data }))
    return Promise.resolve()
  }

  addListener<K extends keyof NearbyEvents>(
    event: K,
    listener: (payload: NearbyEvents[K]) => void,
  ): Promise<NearbyPluginListener> {
    this.#listeners[event].add(listener as never)
    return Promise.resolve({
      remove: () => {
        this.#listeners[event].delete(listener as never)
        return Promise.resolve()
      },
    })
  }

  #emit<K extends keyof NearbyEvents>(event: K, payload: NearbyEvents[K]): void {
    for (const listener of [...this.#listeners[event]]) {
      ;(listener as (p: NearbyEvents[K]) => void)(payload)
    }
  }
}
