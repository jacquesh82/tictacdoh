/**
 * Contrat du plugin natif BLE.
 *
 * C'est la frontière entre le TypeScript et le natif. Elle est figée par les
 * tests du paquet : la couche TS est vérifiée ici contre une maquette, et le
 * natif n'a plus qu'à honorer exactement ce contrat.
 *
 * Les charges utiles voyagent en base64 parce que le pont Capacitor ne
 * transporte que du JSON. Le surcoût de 33 % est en mémoire, pas sur les ondes
 * — il ne consomme donc pas le budget BLE, seulement un peu de processeur.
 */

/** Topologie : le hub est périphérique, les autres sont centraux. */
export interface BleAdvertiseOptions {
  readonly serviceUuid: string
  /** Empreinte du code court, en hexadécimal (3 octets). Filtre de découverte. */
  readonly fingerprintHex: string
  readonly localName: string
}

export interface BleScanOptions {
  readonly serviceUuid: string
  /** Ne remonter que les annonces portant cette empreinte, si fournie. */
  readonly fingerprintHex?: string
}

export interface BleDiscoveredEvent {
  readonly deviceId: string
  readonly name: string
  readonly rssi: number
  readonly fingerprintHex: string
}

export interface BleConnectedEvent {
  readonly peerId: string
  /**
   * MTU ATT négociée. La charge utile vaut `mtu - 3` : trois octets d'en-tête
   * ATT sont consommés par la notification elle-même.
   */
  readonly mtu: number
}

export interface BleReceivedEvent {
  readonly peerId: string
  /** Charge utile en base64. */
  readonly data: string
}

export interface BleDisconnectedEvent {
  readonly peerId: string
  readonly reason?: string
}

export interface BleMeshEvents {
  discovered: BleDiscoveredEvent
  /** Un central s'est connecté à notre périphérique (nous sommes le hub). */
  peerConnected: BleConnectedEvent
  peerDisconnected: BleDisconnectedEvent
  received: BleReceivedEvent
}

export interface BlePluginListener {
  remove(): Promise<void>
}

/** Ce que le plugin natif doit fournir. */
export interface BleMeshPlugin {
  /** Disponibilité réelle : adaptateur présent, allumé, permissions accordées. */
  isAvailable(): Promise<{ available: boolean; canAdvertise: boolean; reason?: string }>

  startAdvertising(options: BleAdvertiseOptions): Promise<void>
  stopAdvertising(): Promise<void>

  startScan(options: BleScanOptions): Promise<void>
  stopScan(): Promise<void>

  connect(options: { deviceId: string }): Promise<BleConnectedEvent>
  disconnect(options: { peerId: string }): Promise<void>

  /** Envoi vers un pair précis. Vers un central si l'on est périphérique. */
  send(options: { peerId: string; data: string }): Promise<void>

  addListener<K extends keyof BleMeshEvents>(
    event: K,
    listener: (payload: BleMeshEvents[K]) => void,
  ): Promise<BlePluginListener>
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64 standard, écrit à la main.
 *
 * `btoa` n'existe pas dans toutes les coquilles natives et `Buffer` n'existe
 * pas dans le navigateur : une implémentation locale évite d'avoir à choisir,
 * et garantit un comportement identique des deux côtés du pont.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]!
    if (b === undefined) {
      out += B64[(a & 3) << 4]! + '=='
      break
    }
    out += B64[((a & 3) << 4) | (b >> 4)]!
    if (c === undefined) {
      out += B64[(b & 15) << 2]! + '='
      break
    }
    out += B64[((b & 15) << 2) | (c >> 6)]! + B64[c & 63]!
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let at = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const value = B64.indexOf(clean[i]!)
    if (value < 0) throw new SyntaxError(`caractère base64 invalide: « ${clean[i]} »`)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

/**
 * Séparateur du nom annoncé : `<empreinte>|<nom lisible>`.
 *
 * Cette convention existe parce que les deux plateformes n'offrent pas les
 * mêmes champs d'annonce. Android peut publier des « service data », pas
 * CoreBluetooth : un hôte iPhone n'a que le nom local pour porter l'empreinte
 * du code. Les deux natifs doivent donc écrire l'empreinte dans le nom, et les
 * deux scanners l'y chercher — sans quoi un Android ne verrait jamais un hôte
 * iOS, c'est-à-dire précisément le chemin que le Bluetooth existe pour couvrir.
 */
export const ADVERTISED_NAME_SEPARATOR = '|'

export function encodeAdvertisedName(fingerprintHex: string, localName: string): string {
  return `${fingerprintHex}${ADVERTISED_NAME_SEPARATOR}${localName}`
}

export function parseAdvertisedName(name: string): { fingerprintHex: string; localName: string } {
  const at = name.indexOf(ADVERTISED_NAME_SEPARATOR)
  if (at < 0) return { fingerprintHex: '', localName: name }
  return { fingerprintHex: name.slice(0, at), localName: name.slice(at + 1) }
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
