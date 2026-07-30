import type { TransportKind } from '@ttd/core'

export type Support = 'oui' | 'non' | 'partiel'

export interface CapabilityRow {
  readonly kind: TransportKind | 'nfc'
  readonly label: string
  /** Peut-on héberger une partie par ce moyen ? */
  readonly host: Support
  /** Peut-on en rejoindre une ? */
  readonly join: Support
  readonly note: string
}

const isSecure = globalThis.isSecureContext === true
const nav = globalThis.navigator as (Navigator & { bluetooth?: unknown }) | undefined

/**
 * Ce que cet appareil sait vraiment faire.
 *
 * Écrit à partir des API réellement présentes plutôt que d'une détection de
 * navigateur : c'est la seule façon honnête de le savoir, et cela évite de
 * promettre au joueur un mode qui échouera au moment de se connecter.
 */
export function capabilities(): CapabilityRow[] {
  const hasWebRtc = typeof RTCPeerConnection !== 'undefined'
  const hasWebSocket = typeof WebSocket !== 'undefined'
  const hasWebBluetooth = Boolean(nav?.bluetooth) && isSecure
  const hasNfcRead = 'NDEFReader' in globalThis

  return [
    {
      kind: 'local',
      label: 'Même appareil',
      host: 'oui',
      join: 'oui',
      note: 'Pass-and-play, 1 à 4 joueurs. Aucun réseau.',
    },
    {
      kind: 'ws',
      label: 'Internet / GSM',
      host: hasWebSocket ? 'oui' : 'non',
      join: hasWebSocket ? 'oui' : 'non',
      note: 'Passe par le relay. Le seul chemin disponible partout.',
    },
    {
      kind: 'webrtc',
      label: 'Wi-Fi / P2P',
      host: hasWebRtc ? 'oui' : 'non',
      join: hasWebRtc ? 'oui' : 'non',
      note: hasWebRtc
        ? 'Pair à pair après mise en relation par le relay.'
        : 'WebRTC absent de ce navigateur.',
    },
    {
      kind: 'ble',
      label: 'Bluetooth',
      // Web Bluetooth est central-only : un navigateur ne peut pas se rendre
      // découvrable, donc jamais héberger hors ligne. C'est une limite de
      // l'API, pas un choix de conception.
      host: 'non',
      join: hasWebBluetooth ? 'partiel' : 'non',
      note: hasWebBluetooth
        ? 'Le navigateur peut rejoindre, jamais héberger : Web Bluetooth ne sait pas s’annoncer.'
        : isSecure
          ? 'Web Bluetooth absent de ce navigateur. Disponible dans l’application mobile.'
          : 'Web Bluetooth exige une origine sécurisée (HTTPS).',
    },
    {
      kind: 'nearby',
      label: 'Wi-Fi Direct',
      host: 'non',
      join: 'non',
      note: 'Aucune API web. Réservé à l’application mobile.',
    },
    {
      kind: 'nfc',
      label: 'NFC',
      host: 'non',
      join: hasNfcRead ? 'partiel' : 'non',
      note: hasNfcRead
        ? 'Lecture de tags seulement. Présenter un ticket demande l’application Android.'
        : 'Web NFC absent. Android peut présenter via HCE, iOS ne sait que lire.',
    },
  ]
}

export function supportPill(value: Support): { text: string; className: string } {
  if (value === 'oui') return { text: 'oui', className: 'pill ok' }
  if (value === 'partiel') return { text: 'partiel', className: 'pill warn' }
  return { text: 'non', className: 'pill no' }
}
