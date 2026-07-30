import { Rng } from '@ttd/core'

/** Longueur par défaut du code court. */
export const DEFAULT_CODE_DIGITS = 6

/** Longueur minimale acceptée, pour les parties en présentiel. */
export const MIN_CODE_DIGITS = 4

/**
 * Code court saisi par les joueurs.
 *
 * Ce n'est pas qu'un confort de saisie : hors ligne, c'est **le filtre de
 * découverte**. En BLE et en Nearby, son empreinte voyage dans les données
 * d'advertising, si bien qu'un joueur qui tape le code ne voit que la bonne
 * session parmi celles à portée. Sans lui, il faudrait choisir dans une liste
 * d'appareils anonymes.
 */
export function generateCode(rng: Rng, digits = DEFAULT_CODE_DIGITS): string {
  if (!Number.isInteger(digits) || digits < MIN_CODE_DIGITS || digits > 9) {
    throw new RangeError(`longueur de code invalide: ${digits}`)
  }
  let code = ''
  for (let i = 0; i < digits; i++) code += String(rng.nextBelow(10))
  return code
}

export function isValidCode(code: string): boolean {
  return (
    code.length >= MIN_CODE_DIGITS && code.length <= 9 && /^[0-9]+$/.test(code)
  )
}

/**
 * Empreinte du code sur 24 bits, à placer dans les données d'advertising.
 *
 * Trois octets : un advertising BLE hérité n'en offre que 31 en tout, service
 * UUID compris. Assez pour que les collisions soient négligeables entre les
 * quelques sessions à portée, et le code complet est vérifié à la connexion de
 * toute façon.
 */
export function codeFingerprint(code: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash & 0xff_ffff
}

/** Empreinte sérialisée pour l'advertising, en gros-boutiste. */
export function fingerprintBytes(code: string): Uint8Array {
  const value = codeFingerprint(code)
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
}

/** Une annonce à portée correspond-elle au code saisi ? */
export function advertMatchesCode(advertised: Uint8Array, code: string): boolean {
  if (advertised.length !== 3) return false
  const expected = fingerprintBytes(code)
  return (
    advertised[0] === expected[0] &&
    advertised[1] === expected[1] &&
    advertised[2] === expected[2]
  )
}
