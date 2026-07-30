/**
 * Protocole du relay.
 *
 * Les messages de contrôle sont en JSON, les trames de jeu en binaire — la
 * distinction texte/binaire de WebSocket suffit à les séparer, sans octet de
 * type. Le JSON est un choix assumé ici : le relay est un composant déployé à
 * part, qu'on veut pouvoir inspecter avec un simple client en ligne de
 * commande, et le contrôle ne représente que quelques messages par partie. Le
 * chemin des données, lui, reste binaire et n'est jamais désérialisé par le
 * relay : il ne fait que router des octets opaques.
 */

/** Numéro de place attribué par le relay. 0 est réservé à l'hôte. */
export type Slot = number

export const HOST_SLOT: Slot = 0

export type ClientMessage =
  | {
      readonly t: 'host'
      readonly sessionId: string
      readonly code: string
      /** Nom du joueur qui héberge. */
      readonly name: string
      /** Nom donné à la salle, affiché dans la liste des parties à proximité. */
      readonly roomName: string
    }
  /** Demande la liste des salles ouvertes sur le même réseau. */
  | { readonly t: 'list' }
  | { readonly t: 'join'; readonly code: string; readonly name: string }
  /**
   * Mise en relation WebRTC.
   *
   * Le relay achemine `data` sans jamais le lire : offres, réponses et
   * candidats ICE lui sont opaques. C'est ce qui lui permet d'ignorer les
   * évolutions de WebRTC, et ce qui l'empêche d'être un point de fuite.
   */
  | { readonly t: 'signal'; readonly to: Slot; readonly data: unknown }
  /**
   * Ferme la salle. N'est honoré que si l'émetteur en est l'hôte.
   *
   * Distinct de `bye`, qui ne fait que raccrocher : ici on veut congédier les
   * invités et libérer le code, plutôt que d'attendre l'expiration.
   */
  | { readonly t: 'close' }
  | { readonly t: 'bye' }

/** Une salle telle qu'on la présente à qui cherche une partie. */
export interface RoomSummary {
  readonly code: string
  readonly roomName: string
  readonly hostName: string
  readonly playerCount: number
  readonly maxPlayers: number
}

export type ServerMessage =
  | { readonly t: 'hosting'; readonly code: string }
  | { readonly t: 'rooms'; readonly rooms: readonly RoomSummary[] }
  | {
      readonly t: 'joined'
      readonly slot: Slot
      readonly hostName: string
      readonly roomName: string
      readonly sessionId: string
    }
  | { readonly t: 'peer-joined'; readonly slot: Slot; readonly name: string }
  | { readonly t: 'peer-left'; readonly slot: Slot }
  | { readonly t: 'signal'; readonly from: Slot; readonly data: unknown }
  /** La salle a été fermée par son créateur. */
  | { readonly t: 'closed'; readonly reason: string }
  | { readonly t: 'error'; readonly reason: string; readonly retryAfterMs?: number }

/**
 * Trame de données.
 *
 * Vers l'hôte comme depuis l'hôte, le premier octet porte la place du
 * correspondant. Un invité, lui, n'a qu'un seul interlocuteur possible : ses
 * trames partent nues. C'est un octet économisé sur le chemin le plus fréquent.
 */
export function withSlot(slot: Slot, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = slot
  out.set(payload, 1)
  return out
}

export function readSlot(frame: Uint8Array): { slot: Slot; payload: Uint8Array } {
  return { slot: frame[0] ?? 0, payload: frame.subarray(1) }
}

/**
 * Clé de regroupement réseau d'une adresse.
 *
 * Le relay n'a pas de notion de proximité : ses salles sont mondiales. Les
 * énumérer toutes publierait qui joue et viderait le code court de son sens.
 * On ne présente donc que les salles du **même réseau**, ce qui est une
 * proximité réelle et ne dépasse pas le Wi-Fi de l'utilisateur.
 *
 * Sur une adresse privée, le regroupement se fait au /24 : sur un même réseau
 * domestique, deux appareils ont des adresses voisines mais distinctes —
 * grouper à l'adresse exacte ne rapprocherait personne. Sur une adresse
 * publique, l'adresse entière fait foi : c'est la sortie NAT commune.
 */
export function networkKey(address: string): string {
  const clean = address.replace(/^::ffff:/, '')
  const parts = clean.split('.')
  if (parts.length !== 4) return clean

  const [a, b] = [Number(parts[0]), Number(parts[1])]
  const isPrivate =
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    a === 127
  return isPrivate ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : clean
}
