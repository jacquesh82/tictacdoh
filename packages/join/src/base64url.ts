const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

/**
 * Base64url, sans remplissage.
 *
 * Écrit à la main plutôt qu'appuyé sur `btoa`/`Buffer` : le ticket doit
 * s'encoder à l'identique dans un navigateur, dans Node et dans une coquille
 * native, et les trois n'offrent pas les mêmes primitives. Sans remplissage
 * parce que le résultat finit dans une URL et dans un QR, où chaque caractère
 * compte en densité.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]

    out += ALPHABET[a >> 2]
    if (b === undefined) {
      out += ALPHABET[(a & 0x03) << 4]
      break
    }
    out += ALPHABET[((a & 0x03) << 4) | (b >> 4)]
    if (c === undefined) {
      out += ALPHABET[(b & 0x0f) << 2]
      break
    }
    out += ALPHABET[((b & 0x0f) << 2) | (c >> 6)]
    out += ALPHABET[c & 0x3f]
  }
  return out
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.trim()
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outAt = 0
  let buffer = 0
  let bits = 0

  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i)
    const value = code < 128 ? LOOKUP[code]! : -1
    if (value < 0) throw new SyntaxError(`caractère base64url invalide: « ${clean[i]} »`)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outAt++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, outAt)
}
