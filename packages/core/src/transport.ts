import type { Unsubscribe } from './emitter.js'

/** Identifiant stable d'un pair pour la durée d'une session. */
export type PeerId = string

/** Siège de jeu, de 0 à MAX_PLAYERS-1. Distinct du PeerId : il est réattribuable. */
export type Seat = number

export type TransportKind = 'local' | 'ws' | 'webrtc' | 'ble' | 'nearby' | 'sim'

/**
 * Ce qu'un transport sait faire.
 *
 * C'est le contrat central du socle. Les couches supérieures ne connaissent
 * aucun transport en particulier : elles lisent ces valeurs et s'adaptent.
 * C'est ce qui permet au même mini-jeu de tourner sur BLE et sur WebRTC sans
 * une ligne de code spécifique.
 */
export interface TransportCaps {
  readonly kind: TransportKind

  /** Charge utile maximale d'un message. Au-delà, `Channel` fragmente. */
  readonly maxPayloadBytes: number

  /** Débit soutenable par lien. Pilote la cadence réseau et la redondance. */
  readonly throughputBytesPerSec: number

  /** Aller-retour typique. Sert d'amorce au délai d'input avant mesure réelle. */
  readonly rttHintMs: number

  /** Pairs simultanés supportés par le transport lui-même. */
  readonly maxPeers: number

  /**
   * Le pair peut se rendre découvrable.
   *
   * `false` en navigateur : Web Bluetooth est central-only et n'expose aucune
   * API d'advertising. Un navigateur ne peut donc jamais héberger hors ligne.
   */
  readonly canAdvertise: boolean

  /** Le pair peut chercher des sessions à portée. */
  readonly canDiscover: boolean

  /** Les messages arrivent, ou le lien se ferme. Sinon, pertes silencieuses. */
  readonly reliable: boolean

  /** Les messages arrivent dans l'ordre d'émission. */
  readonly ordered: boolean

  /** Une connectivité Internet est nécessaire. `false` = vrai hors-ligne. */
  readonly requiresInternet: boolean
}

/** Ce qu'un hôte publie pour être trouvé. */
export interface SessionAdvert {
  readonly sessionId: string
  /** Code court saisi par les joueurs ; sert aussi de filtre de découverte. */
  readonly code: string
  /** Nom du joueur qui héberge. */
  readonly hostName: string
  /**
   * Nom donné à la salle.
   *
   * Distinct du nom de l'hôte : c'est ce qu'on lit dans une liste de parties à
   * proximité, et « Le salon » se reconnaît mieux que le prénom de quelqu'un
   * quand trois parties tournent dans la même pièce.
   */
  readonly roomName?: string
  readonly playerCount: number
  readonly maxPlayers: number
}

/** Une session repérée par la découverte, prête à être rejointe. */
export interface DiscoveredSession {
  readonly advert: SessionAdvert
  readonly kind: TransportKind
  /** Détail propre au transport (URL, UUID de service, identifiant d'endpoint). */
  readonly address: string
  /** Force du signal quand le transport la connaît, pour trier les candidats. */
  readonly rssi?: number
}

export interface LinkEvents extends Record<string, unknown> {
  message: Uint8Array
  close: { reason: string }
}

/** Canal bidirectionnel de messages vers un pair. */
export interface Link {
  readonly peerId: PeerId
  readonly caps: TransportCaps
  readonly closed: boolean

  /**
   * Envoie une charge utile. Ne rend pas la main sur un accusé : sur un lien
   * lent, attendre coûterait plus cher que la perte qu'on cherche à éviter.
   */
  send(payload: Uint8Array): void

  close(reason?: string): void

  on<K extends keyof LinkEvents>(event: K, fn: (payload: LinkEvents[K]) => void): Unsubscribe
}

/** Fabrique de liens pour un moyen physique donné. */
export interface Transport {
  readonly caps: TransportCaps

  /** Se rendre découvrable. Rejeté si `caps.canAdvertise` est `false`. */
  advertise(advert: SessionAdvert): Promise<void>
  stopAdvertising(): Promise<void>

  /**
   * Cherche les sessions à portée. Le flux reste ouvert jusqu'à l'abandon :
   * en BLE les pairs apparaissent progressivement, il n'y a pas d'instant où
   * la découverte est « terminée ».
   */
  discover(signal?: AbortSignal): AsyncIterable<DiscoveredSession>

  connect(target: DiscoveredSession): Promise<Link>

  /** Liens entrants, quand ce pair est l'hôte. */
  onIncoming(fn: (link: Link) => void): Unsubscribe

  close(): Promise<void>
}

/** Erreur de transport : lien perdu, capacité absente, pair injoignable. */
export class TransportError extends Error {
  override readonly name = 'TransportError'

  constructor(
    message: string,
    readonly kind: TransportKind,
  ) {
    super(message)
  }
}
