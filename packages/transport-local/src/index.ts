import {
  type DiscoveredSession,
  type Link,
  MemoryLink,
  type PeerId,
  type SessionAdvert,
  type Transport,
  TransportError,
  type TransportCaps,
  type Unsubscribe,
} from '@ttd/core'

/**
 * Capacités du transport local.
 *
 * Volontairement pas « infinies ». Le mode local est le premier banc d'essai
 * de tout mini-jeu : s'il annonce une MTU illimitée, un jeu peut grossir sans
 * qu'on s'en aperçoive et ne se révéler injouable qu'en phase 9, sur un vrai
 * lien BLE. La MTU annoncée reste donc généreuse mais finie, ce qui garde le
 * chemin de fragmentation exercé dès le premier jour.
 */
export const LOCAL_CAPS: TransportCaps = {
  kind: 'local',
  maxPayloadBytes: 4096,
  throughputBytesPerSec: 8 * 1024 * 1024,
  rttHintMs: 0,
  maxPeers: 4,
  canAdvertise: false,
  canDiscover: false,
  reliable: true,
  ordered: true,
  requiresInternet: false,
}

/**
 * Transport « même appareil » : pass-and-play et écran partagé.
 *
 * N'expose ni découverte ni advertising — il n'y a rien à découvrir. Les pairs
 * sont créés directement par `seat()`. Son intérêt n'est pas de faire du
 * réseau mais de prouver que l'abstraction tient : un mini-jeu ne doit pas
 * savoir qu'il tourne en local.
 */
export class LocalTransport implements Transport {
  readonly caps = LOCAL_CAPS

  readonly #incoming = new Set<(link: Link) => void>()
  readonly #links = new Map<PeerId, MemoryLink>()
  readonly #hostId: PeerId

  constructor(hostId: PeerId = 'local-host') {
    this.#hostId = hostId
  }

  /**
   * Crée le lien d'un joueur local supplémentaire et le présente à l'hôte.
   * @returns le bout de lien côté joueur.
   */
  seat(peerId: PeerId): Link {
    if (this.#links.has(peerId)) {
      throw new TransportError(`siège local déjà pris: ${peerId}`, 'local')
    }
    const [hostSide, peerSide] = MemoryLink.pair(this.#hostId, peerId, LOCAL_CAPS)
    this.#links.set(peerId, peerSide)
    for (const fn of this.#incoming) fn(hostSide)
    return peerSide
  }

  advertise(_advert: SessionAdvert): Promise<void> {
    return Promise.reject(
      new TransportError('le transport local ne se découvre pas : les joueurs sont déjà là', 'local'),
    )
  }

  stopAdvertising(): Promise<void> {
    return Promise.resolve()
  }

  // eslint-disable-next-line require-yield -- flux volontairement vide
  async *discover(): AsyncIterable<DiscoveredSession> {
    // Rien à découvrir sur un seul appareil.
  }

  connect(_target: DiscoveredSession): Promise<Link> {
    return Promise.reject(new TransportError('le transport local ne se connecte pas', 'local'))
  }

  onIncoming(fn: (link: Link) => void): Unsubscribe {
    this.#incoming.add(fn)
    return () => void this.#incoming.delete(fn)
  }

  close(): Promise<void> {
    for (const link of this.#links.values()) link.close('transport closed')
    this.#links.clear()
    this.#incoming.clear()
    return Promise.resolve()
  }
}
