import { fail } from './errors.js'
import { Reader } from './reader.js'
import { Writer } from './writer.js'

/** Règle de sérialisation d'une valeur de type `T`. */
export interface Codec<T> {
  readonly name: string
  write(w: Writer, value: T): void
  read(r: Reader): T
}

/** Type de valeur porté par un codec. */
export type Decoded<C> = C extends Codec<infer T> ? T : never

function define<T>(name: string, write: Codec<T>['write'], read: Codec<T>['read']): Codec<T> {
  return { name, write, read }
}

export const u8: Codec<number> = define('u8', (w, v) => void w.u8(v), (r) => r.u8())
export const u16: Codec<number> = define('u16', (w, v) => void w.u16(v), (r) => r.u16())
export const u32: Codec<number> = define('u32', (w, v) => void w.u32(v), (r) => r.u32())
export const varuint: Codec<number> = define('varuint', (w, v) => void w.varuint(v), (r) => r.varuint())
export const varint: Codec<number> = define('varint', (w, v) => void w.varint(v), (r) => r.varint())
export const bool: Codec<boolean> = define('bool', (w, v) => void w.bool(v), (r) => r.bool())
export const str: Codec<string> = define('str', (w, v) => void w.str(v), (r) => r.str())

/** Octets préfixés de leur longueur. Copiés à la lecture. */
export const bytes: Codec<Uint8Array> = define(
  'bytes',
  (w, v) => void w.bytes(v),
  (r) => r.bytes().slice(),
)

/** Octets de longueur fixe connue des deux côtés — n'écrit aucun préfixe. */
export function fixedBytes(length: number): Codec<Uint8Array> {
  return define(
    `fixedBytes(${length})`,
    (w, v) => {
      if (v.length !== length) fail(`fixedBytes(${length}) a reçu ${v.length} octet(s)`)
      w.raw(v)
    },
    (r) => r.raw(length).slice(),
  )
}

/** Liste de longueur variable. */
export function array<T>(item: Codec<T>): Codec<T[]> {
  return define(
    `array(${item.name})`,
    (w, v) => {
      w.varuint(v.length)
      for (const entry of v) item.write(w, entry)
    },
    (r) => {
      const count = r.varuint()
      // Une longueur annoncée n'est pas une longueur disponible : sans ce
      // garde-fou, un pair malveillant ferait allouer un tableau géant.
      if (count > r.remaining) fail(`array annonce ${count} éléments, buffer trop court`)
      const out: T[] = new Array<T>(count)
      for (let i = 0; i < count; i++) out[i] = item.read(r)
      return out
    },
  )
}

/** Valeur optionnelle, précédée d'un octet de présence. */
export function optional<T>(inner: Codec<T>): Codec<T | undefined> {
  return define(
    `optional(${inner.name})`,
    (w, v) => {
      w.bool(v !== undefined)
      if (v !== undefined) inner.write(w, v)
    },
    (r) => (r.bool() ? inner.read(r) : undefined),
  )
}

/** Un membre d'un ensemble fini, encodé sur un varuint. */
export function enumOf<const T extends readonly (string | number)[]>(
  members: T,
): Codec<T[number]> {
  return define(
    `enum(${members.length})`,
    (w, v) => {
      const index = members.indexOf(v)
      if (index < 0) fail(`valeur hors énumération: ${String(v)}`)
      w.varuint(index)
    },
    (r) => {
      const index = r.varuint()
      const member = members[index]
      if (member === undefined) fail(`index d'énumération inconnu: ${index}`)
      return member
    },
  )
}

/**
 * Enregistrement à champs ordonnés. L'ordre des clés *est* le format binaire :
 * réordonner les champs casse la compatibilité entre pairs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance : un
// codec de champ doit rester assignable quel que soit son type porté.
export function struct<S extends Record<string, Codec<any>>>(
  shape: S,
): Codec<{ [K in keyof S]: Decoded<S[K]> }> {
  const entries = Object.entries(shape) as [string, Codec<unknown>][]
  type Value = { [K in keyof S]: Decoded<S[K]> }
  return define<Value>(
    `struct{${entries.map(([k]) => k).join(',')}}`,
    (w, value) => {
      for (const [key, codec] of entries) {
        codec.write(w, (value as Record<string, unknown>)[key])
      }
    },
    (r) => {
      const out: Record<string, unknown> = {}
      for (const [key, codec] of entries) out[key] = codec.read(r)
      return out as Value
    },
  )
}

/** Sérialise une valeur. */
export function encode<T>(codec: Codec<T>, value: T, capacity = 64): Uint8Array {
  const w = new Writer(capacity)
  codec.write(w, value)
  return w.finish()
}

/**
 * Désérialise une valeur. Refuse les octets excédentaires : un buffer plus long
 * que prévu signale presque toujours une divergence de version entre pairs, et
 * on préfère l'apprendre ici plutôt qu'en pleine partie.
 */
export function decode<T>(codec: Codec<T>, buf: Uint8Array): T {
  const r = new Reader(buf)
  const value = codec.read(r)
  if (!r.exhausted) fail(`${r.remaining} octet(s) inattendu(s) après décodage de ${codec.name}`)
  return value
}

/** Taille encodée, en octets. Utilisé par les tests de budget. */
export function sizeOf<T>(codec: Codec<T>, value: T): number {
  const w = new Writer(64)
  codec.write(w, value)
  return w.length
}
