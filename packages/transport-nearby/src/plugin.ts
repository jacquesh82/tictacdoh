/**
 * Contrat du plugin natif « à proximité ».
 *
 * Recouvre deux technologies qui ne se parlent pas :
 * - **Android** : Nearby Connections, stratégie `P2P_STAR`, qui monte du
 *   Wi-Fi Direct sous le capot et retombe sur le Bluetooth si besoin.
 * - **iOS** : MultipeerConnectivity, qui fait la même chose entre appareils
 *   Apple, et seulement entre eux.
 *
 * Il n'existe **aucun pont entre les deux**. C'est un fait de plateforme, pas
 * un manque du socle : ce transport relie donc des appareils de même famille,
 * et le BLE reste le seul chemin hors-ligne entre iOS et Android. La stratégie
 * en étoile de Nearby coïncide avec la topologie du socle, ce qui évite toute
 * adaptation.
 */

export interface NearbyAdvertiseOptions {
  /** Identifiant de service de l'application, commun aux deux bouts. */
  readonly serviceId: string
  /**
   * Nom d'endpoint. Porte le code court : c'est le seul champ librement
   * lisible pendant la découverte, donc le seul filtre possible avant
   * connexion.
   */
  readonly endpointName: string
}

export interface NearbyDiscoverOptions {
  readonly serviceId: string
}

export interface NearbyEndpointEvent {
  readonly endpointId: string
  readonly endpointName: string
}

export interface NearbyConnectedEvent {
  readonly endpointId: string
  readonly endpointName: string
}

export interface NearbyReceivedEvent {
  readonly endpointId: string
  /** Charge utile en base64 : le pont Capacitor ne transporte que du JSON. */
  readonly data: string
}

export interface NearbyDisconnectedEvent {
  readonly endpointId: string
  readonly reason?: string
}

export interface NearbyEvents {
  endpointFound: NearbyEndpointEvent
  endpointLost: { endpointId: string }
  /**
   * Connexion proposée par les deux bouts.
   *
   * Nearby comme Multipeer exigent une acceptation explicite de part et
   * d'autre : le socle l'accorde automatiquement puisque le code court a déjà
   * fait office de filtre.
   */
  connectionRequested: NearbyEndpointEvent
  connected: NearbyConnectedEvent
  disconnected: NearbyDisconnectedEvent
  received: NearbyReceivedEvent
}

export interface NearbyPluginListener {
  remove(): Promise<void>
}

export interface NearbyPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>

  startAdvertising(options: NearbyAdvertiseOptions): Promise<void>
  stopAdvertising(): Promise<void>

  startDiscovery(options: NearbyDiscoverOptions): Promise<void>
  stopDiscovery(): Promise<void>

  requestConnection(options: { endpointId: string; endpointName: string }): Promise<void>
  acceptConnection(options: { endpointId: string }): Promise<void>
  disconnect(options: { endpointId: string }): Promise<void>

  send(options: { endpointId: string; data: string }): Promise<void>

  addListener<K extends keyof NearbyEvents>(
    event: K,
    listener: (payload: NearbyEvents[K]) => void,
  ): Promise<NearbyPluginListener>
}
