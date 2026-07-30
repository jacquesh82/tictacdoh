import type {
  BleConnectedEvent,
  BleMeshEvents,
  BleMeshPlugin,
  BlePluginListener,
  BleAdvertiseOptions,
  BleScanOptions,
} from '../src/plugin.js'

/**
 * Radio BLE simulée, partagée par plusieurs appareils.
 *
 * Reproduit ce qui compte et se vérifie sans matériel : la topologie en étoile,
 * le filtrage par empreinte dans l'annonce, la MTU négociée par connexion, le
 * refus d'annoncer côté navigateur, et les déconnexions.
 *
 * Elle ne prouve rien sur la portée réelle, la consommation, ni sur le
 * comportement des piles en arrière-plan : cela ne se vérifie que sur de vrais
 * appareils.
 */
export class FakeBleRadio {
  readonly #peripherals = new Map<string, { device: FakeBlePlugin; options: BleAdvertiseOptions }>()

  advertise(id: string, device: FakeBlePlugin, options: BleAdvertiseOptions): void {
    this.#peripherals.set(id, { device, options })
  }

  stopAdvertising(id: string): void {
    this.#peripherals.delete(id)
  }

  /** Annonces visibles, éventuellement filtrées par empreinte. */
  visible(scan: BleScanOptions): Array<{ id: string; options: BleAdvertiseOptions }> {
    return [...this.#peripherals.entries()]
      .filter(([, entry]) => entry.options.serviceUuid === scan.serviceUuid)
      .filter(
        ([, entry]) =>
          scan.fingerprintHex === undefined || entry.options.fingerprintHex === scan.fingerprintHex,
      )
      .map(([id, entry]) => ({ id, options: entry.options }))
  }

  peripheral(id: string): FakeBlePlugin | undefined {
    return this.#peripherals.get(id)?.device
  }
}

export interface FakeBleOptions {
  readonly id: string
  readonly radio: FakeBleRadio
  /** MTU que cette pile négocie. 23 est le défaut BLE avant négociation. */
  readonly mtu?: number
  /** Faux pour un navigateur : Web Bluetooth ne sait pas s'annoncer. */
  readonly canAdvertise?: boolean
  readonly available?: boolean
}

type Listeners = {
  [K in keyof BleMeshEvents]: Set<(payload: BleMeshEvents[K]) => void>
}

const later = (fn: () => void) => void setTimeout(fn, 0)

export class FakeBlePlugin implements BleMeshPlugin {
  readonly id: string
  readonly #radio: FakeBleRadio
  readonly #mtu: number
  readonly #canAdvertise: boolean
  readonly #available: boolean

  readonly #listeners: Listeners = {
    discovered: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    received: new Set(),
  }

  /** Correspondants ouverts : identifiant du pair vers sa pile distante. */
  readonly #peers = new Map<string, { remote: FakeBlePlugin; remoteId: string }>()
  #scanning: BleScanOptions | undefined

  constructor(options: FakeBleOptions) {
    this.id = options.id
    this.#radio = options.radio
    this.#mtu = options.mtu ?? 185
    this.#canAdvertise = options.canAdvertise ?? true
    this.#available = options.available ?? true
  }

  isAvailable(): Promise<{ available: boolean; canAdvertise: boolean; reason?: string }> {
    return Promise.resolve({
      available: this.#available,
      canAdvertise: this.#canAdvertise,
      reason: this.#available
        ? this.#canAdvertise
          ? undefined
          : 'Web Bluetooth est central uniquement : impossible de s’annoncer'
        : 'Bluetooth éteint',
    })
  }

  startAdvertising(options: BleAdvertiseOptions): Promise<void> {
    if (!this.#canAdvertise) return Promise.reject(new Error('advertising non supporté'))
    this.#radio.advertise(this.id, this, options)
    return Promise.resolve()
  }

  stopAdvertising(): Promise<void> {
    this.#radio.stopAdvertising(this.id)
    return Promise.resolve()
  }

  startScan(options: BleScanOptions): Promise<void> {
    this.#scanning = options
    later(() => {
      if (!this.#scanning) return
      for (const found of this.#radio.visible(options)) {
        if (found.id === this.id) continue
        this.#emit('discovered', {
          deviceId: found.id,
          name: found.options.localName,
          rssi: -55,
          fingerprintHex: found.options.fingerprintHex,
        })
      }
    })
    return Promise.resolve()
  }

  stopScan(): Promise<void> {
    this.#scanning = undefined
    return Promise.resolve()
  }

  connect(options: { deviceId: string }): Promise<BleConnectedEvent> {
    const peripheral = this.#radio.peripheral(options.deviceId)
    if (!peripheral) return Promise.reject(new Error(`appareil ${options.deviceId} hors de portée`))

    // La MTU retenue est la plus petite des deux piles : c'est ce que fait une
    // vraie négociation ATT.
    const mtu = Math.min(this.#mtu, peripheral.#mtu)
    this.#peers.set(options.deviceId, { remote: peripheral, remoteId: this.id })
    peripheral.#peers.set(this.id, { remote: this, remoteId: options.deviceId })

    later(() => peripheral.#emit('peerConnected', { peerId: this.id, mtu }))
    return Promise.resolve({ peerId: options.deviceId, mtu })
  }

  disconnect(options: { peerId: string }): Promise<void> {
    const entry = this.#peers.get(options.peerId)
    this.#peers.delete(options.peerId)
    if (entry) {
      entry.remote.#peers.delete(entry.remoteId)
      later(() => entry.remote.#emit('peerDisconnected', { peerId: entry.remoteId }))
    }
    return Promise.resolve()
  }

  send(options: { peerId: string; data: string }): Promise<void> {
    const entry = this.#peers.get(options.peerId)
    if (!entry) return Promise.reject(new Error(`pair ${options.peerId} non connecté`))
    // Remise différée : une pile qui rappellerait son pair de façon synchrone
    // masquerait les bugs de réentrance.
    later(() => entry.remote.#emit('received', { peerId: entry.remoteId, data: options.data }))
    return Promise.resolve()
  }

  addListener<K extends keyof BleMeshEvents>(
    event: K,
    listener: (payload: BleMeshEvents[K]) => void,
  ): Promise<BlePluginListener> {
    this.#listeners[event].add(listener as never)
    return Promise.resolve({
      remove: () => {
        this.#listeners[event].delete(listener as never)
        return Promise.resolve()
      },
    })
  }

  #emit<K extends keyof BleMeshEvents>(event: K, payload: BleMeshEvents[K]): void {
    for (const listener of [...this.#listeners[event]]) {
      ;(listener as (p: BleMeshEvents[K]) => void)(payload)
    }
  }
}
