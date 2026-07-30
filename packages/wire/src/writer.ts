import { fail } from './errors.js'

const utf8 = new TextEncoder()

/**
 * Bornes d'un `varint`. Le zigzag consomme un bit de portée, et il est
 * asymétrique : `zigzag(v) = 2v` pour v >= 0, `-2v - 1` sinon. Le négatif
 * atteint donc exactement -2^52, le positif s'arrête un cran plus tôt.
 */
export const VARINT_MAX = 2 ** 52 - 1
export const VARINT_MIN = -(2 ** 52)

/**
 * Écriture binaire sur buffer croissant.
 *
 * Volontairement sans `f32`/`f64` : la simulation des mini-jeux est en virgule
 * fixe (règle dure du SDK, cf. plan). Ne pas offrir de flottant sur le fil est
 * la façon la moins coûteuse d'empêcher un flottant de traverser le réseau et
 * de provoquer une désync entre plateformes.
 */
export class Writer {
  #buf: Uint8Array
  #len = 0

  constructor(initialCapacity = 64) {
    this.#buf = new Uint8Array(Math.max(1, initialCapacity))
  }

  /** Nombre d'octets écrits jusqu'ici. */
  get length(): number {
    return this.#len
  }

  #ensure(extra: number): void {
    const needed = this.#len + extra
    if (needed <= this.#buf.length) return
    let cap = this.#buf.length
    while (cap < needed) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.#buf.subarray(0, this.#len))
    this.#buf = next
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) fail(`u8 hors bornes: ${v}`)
    this.#ensure(1)
    this.#buf[this.#len++] = v
    return this
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) fail(`u16 hors bornes: ${v}`)
    this.#ensure(2)
    this.#buf[this.#len++] = (v >>> 8) & 0xff
    this.#buf[this.#len++] = v & 0xff
    return this
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) fail(`u32 hors bornes: ${v}`)
    this.#ensure(4)
    this.#buf[this.#len++] = (v >>> 24) & 0xff
    this.#buf[this.#len++] = (v >>> 16) & 0xff
    this.#buf[this.#len++] = (v >>> 8) & 0xff
    this.#buf[this.#len++] = v & 0xff
    return this
  }

  /**
   * Entier non signé de taille variable (LEB128). 1 octet jusqu'à 127.
   * C'est le type par défaut du protocole : les numéros de tick, compteurs et
   * longueurs restent petits en pratique et tiennent sur 1 à 2 octets.
   */
  varuint(v: number): this {
    if (!Number.isInteger(v) || v < 0) fail(`varuint attend un entier >= 0, reçu ${v}`)
    if (v > Number.MAX_SAFE_INTEGER) fail(`varuint hors de l'entier sûr: ${v}`)
    let rest = v
    // Division plutôt que décalage : au-delà de 2^31 les opérateurs bit à bit
    // de JS repassent en 32 bits signés et corrompraient la valeur.
    while (rest >= 0x80) {
      this.u8((rest % 0x80) | 0x80)
      rest = Math.floor(rest / 0x80)
    }
    return this.u8(rest)
  }

  /**
   * Entier signé de taille variable (zigzag + LEB128).
   *
   * Le zigzag double la magnitude avant encodage : la portée utile est la
   * moitié de celle de `varuint`. Vérifié ici pour que le message d'erreur
   * désigne le vrai coupable plutôt que le `varuint` sous-jacent.
   */
  varint(v: number): this {
    if (!Number.isInteger(v)) fail(`varint attend un entier, reçu ${v}`)
    if (v > VARINT_MAX || v < VARINT_MIN) fail(`varint hors bornes: ${v}`)
    const zigzag = v >= 0 ? v * 2 : -v * 2 - 1
    return this.varuint(zigzag)
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }

  /** Octets bruts, sans préfixe de longueur. */
  raw(bytes: Uint8Array): this {
    this.#ensure(bytes.length)
    this.#buf.set(bytes, this.#len)
    this.#len += bytes.length
    return this
  }

  /** Octets préfixés de leur longueur. */
  bytes(value: Uint8Array): this {
    this.varuint(value.length)
    return this.raw(value)
  }

  /** Chaîne UTF-8 préfixée de sa longueur en octets. */
  str(value: string): this {
    return this.bytes(utf8.encode(value))
  }

  /** Copie les octets écrits. */
  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len)
  }
}
