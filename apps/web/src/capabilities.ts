import type { TransportKind } from '@ttd/core'
import { isNative, nativePlatform } from './native.js'

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
 *
 * **La coquille native change tout.** Web Bluetooth n'existe pas dans un
 * WebView, mais le plugin natif, lui, sait s'annoncer *et* scanner. Ne tester
 * que les API du navigateur faisait afficher « Bluetooth indisponible » dans
 * l'application mobile — là précisément où il est disponible, et où il est le
 * seul chemin hors-ligne entre iOS et Android.
 */
export function capabilities(): CapabilityRow[] {
  const hasWebRtc = typeof RTCPeerConnection !== 'undefined'
  const hasWebSocket = typeof WebSocket !== 'undefined'
  const hasWebBluetooth = Boolean(nav?.bluetooth) && isSecure
  const hasNfcRead = 'NDEFReader' in globalThis
  const natif = isNative()
  const plateforme = nativePlatform()

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
      // l'API, pas un choix de conception. Le plugin natif, lui, tient les
      // deux rôles.
      host: natif ? 'oui' : 'non',
      join: natif ? 'oui' : hasWebBluetooth ? 'partiel' : 'non',
      note: natif
        ? 'Le seul chemin hors-ligne entre iOS et Android. Débit limité : ~1,5 ko/s.'
        : hasWebBluetooth
          ? 'Le navigateur peut rejoindre, jamais héberger : Web Bluetooth ne sait pas s’annoncer.'
          : isSecure
            ? 'Web Bluetooth absent de ce navigateur. Disponible dans l’application mobile.'
            : 'Web Bluetooth exige une origine sécurisée (HTTPS).',
    },
    {
      kind: 'nearby',
      label: 'Wi-Fi Direct',
      host: natif ? 'oui' : 'non',
      join: natif ? 'oui' : 'non',
      // Nearby et Multipeer ne se parlent pas : le préciser évite de croire
      // qu'un iPhone et un Android se trouveront par ce moyen.
      note: natif
        ? plateforme === 'ios'
          ? 'MultipeerConnectivity : entre appareils Apple seulement.'
          : 'Nearby Connections : entre appareils Android seulement.'
        : 'Aucune API web. Réservé à l’application mobile.',
    },
    {
      kind: 'nfc',
      label: 'NFC',
      // Présenter exige d'émuler une carte : Android sait, iOS jamais —
      // l'émulation y est réservée à Apple Pay.
      host: natif && plateforme === 'android' ? 'oui' : 'non',
      join: natif ? 'oui' : hasNfcRead ? 'partiel' : 'non',
      note: natif
        ? plateforme === 'android'
          ? 'Présente le ticket par émulation de carte, et lit les tags.'
          : 'iOS sait lire un ticket, jamais en présenter un.'
        : hasNfcRead
          ? 'Lecture de tags seulement. Présenter un ticket demande l’application Android.'
          : 'Web NFC absent. Disponible dans l’application mobile.',
    },
  ]
}

export function supportPill(value: Support): { text: string; className: string } {
  if (value === 'oui') return { text: 'oui', className: 'pill ok' }
  if (value === 'partiel') return { text: 'partiel', className: 'pill warn' }
  return { text: 'non', className: 'pill no' }
}
