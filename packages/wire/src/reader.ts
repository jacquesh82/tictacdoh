import { fail } from './errors.js'

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Lecture binaire bornée.
 *
 * Toutes les entrées viennent du réseau et sont donc hostiles par défaut :
 * chaque lecture vérifie ses bornes et lève une `WireError` plutôt que de
 * renvoyer `undefined` ou de boucler.
 */
export class Reader {
  readonly #buf: Uint8Array
  #pos = 0

  constructor(buf: Uint8Array) {
    this.#buf = buf
  }

  get position(): number {
    return this.#pos
  }

  get remaining(): number {
    return this.#buf.length - this.#pos
  }

  get exhausted(): boolean {
    return this.#pos >= this.#buf.length
  }

  #take(n: number): number {
    if (this.#pos + n > this.#buf.length) {
      fail(`lecture hors bornes: ${n} octet(s) demandé(s), ${this.remaining} disponible(s)`)
    }
    const at = this.#pos
    this.#pos += n
    return at
  }

  u8(): number {
    const at = this.#take(1)
    return this.#buf[at]!
  }

  u16(): number {
    const at = this.#take(2)
    return (this.#buf[at]! << 8) | this.#buf[at + 1]!
  }

  u32(): number {
    const at = this.#take(4)
    // `>>> 0` pour repasser en non signé après le décalage de 24 bits.
    return (
      ((this.#buf[at]! << 24) |
        (this.#buf[at + 1]! << 16) |
        (this.#buf[at + 2]! << 8) |
        this.#buf[at + 3]!) >>> 0
    )
  }

  varuint(): number {
    let result = 0
    let scale = 1
    for (let i = 0; i < 8; i++) {
      const byte = this.u8()
      result += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) fail('varuint hors de l’entier sûr')
        return result
      }
      scale *= 0x80
    }
    return fail('varuint trop long (plus de 8 octets)')
  }

  varint(): number {
    const zigzag = this.varuint()
    return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2
  }

  bool(): boolean {
    const byte = this.u8()
    if (byte > 1) fail(`bool invalide: ${byte}`)
    return byte === 1
  }

  /**
   * Octets bruts. Vue sur le buffer source — non copiée, donc à ne pas
   * conserver au-delà du décodage sans `.slice()`.
   */
  raw(n: number): Uint8Array {
    const at = this.#take(n)
    return this.#buf.subarray(at, at + n)
  }

  bytes(): Uint8Array {
    return this.raw(this.varuint())
  }

  str(): string {
    try {
      return utf8.decode(this.bytes())
    } catch {
      return fail('chaîne UTF-8 invalide')
    }
  }
}
