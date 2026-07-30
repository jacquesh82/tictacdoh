import { describe, expect, it } from 'vitest'
import {
  Reader,
  WireError,
  Writer,
  VARINT_MAX,
  VARINT_MIN,
  array,
  bool,
  bytes,
  decode,
  encode,
  enumOf,
  fixedBytes,
  optional,
  str,
  struct,
  u16,
  u32,
  u8,
  varint,
  varuint,
} from '../src/index.js'

describe('primitives', () => {
  it('fait l’aller-retour sur les entiers de taille fixe', () => {
    for (const [codec, value] of [
      [u8, 0],
      [u8, 255],
      [u16, 0xbeef],
      [u32, 0xdead_beef],
    ] as const) {
      expect(decode(codec, encode(codec, value))).toBe(value)
    }
  })

  it('refuse les entiers hors bornes', () => {
    expect(() => encode(u8, 256)).toThrow(WireError)
    expect(() => encode(u8, -1)).toThrow(WireError)
    expect(() => encode(u16, 0x1_0000)).toThrow(WireError)
    expect(() => encode(u8, 1.5)).toThrow(WireError)
  })

  it('fait l’aller-retour sur varuint, y compris au-delà de 32 bits', () => {
    const values = [0, 1, 127, 128, 300, 0xffff, 0xffff_ffff, 2 ** 45, Number.MAX_SAFE_INTEGER]
    for (const value of values) {
      expect(decode(varuint, encode(varuint, value))).toBe(value)
    }
  })

  it('encode les petits varuint sur un seul octet', () => {
    // C'est la propriété qui tient tout le budget : les numéros de tick et les
    // compteurs restent sur un octet en usage normal.
    expect(encode(varuint, 0)).toHaveLength(1)
    expect(encode(varuint, 127)).toHaveLength(1)
    expect(encode(varuint, 128)).toHaveLength(2)
    expect(encode(varuint, 16_383)).toHaveLength(2)
  })

  it('fait l’aller-retour sur varint signé, jusqu’aux bornes exactes', () => {
    // Bornes asymétriques : zigzag(v) = 2v pour v >= 0 et -2v-1 sinon, donc le
    // négatif atteint -2^52 quand le positif s'arrête à 2^52 - 1.
    for (const value of [0, -1, 1, -64, 64, -100_000, 100_000, VARINT_MIN, VARINT_MAX]) {
      expect(decode(varint, encode(varint, value))).toBe(value)
    }
  })

  it('refuse un varint hors bornes avec un message explicite', () => {
    // L'erreur doit désigner le varint, pas le varuint sous-jacent, sinon le
    // diagnostic part sur une fausse piste.
    expect(() => encode(varint, VARINT_MAX + 1)).toThrow(/varint hors bornes/)
    expect(() => encode(varint, VARINT_MIN - 1)).toThrow(/varint hors bornes/)
  })

  it('encode les petits négatifs de façon compacte', () => {
    expect(encode(varint, -1)).toHaveLength(1)
    expect(encode(varint, -63)).toHaveLength(1)
  })

  it('fait l’aller-retour sur les chaînes UTF-8', () => {
    for (const value of ['', 'abc', 'Esquive — 4 joueurs', '日本語', '🎮']) {
      expect(decode(str, encode(str, value))).toBe(value)
    }
  })

  it('fait l’aller-retour sur les octets et les booléens', () => {
    const payload = new Uint8Array([1, 2, 3, 250])
    expect(Array.from(decode(bytes, encode(bytes, payload)))).toEqual([1, 2, 3, 250])
    expect(decode(bool, encode(bool, true))).toBe(true)
    expect(decode(bool, encode(bool, false))).toBe(false)
  })
})

describe('robustesse face à des octets hostiles', () => {
  it('lève plutôt que de lire hors bornes', () => {
    expect(() => decode(u32, new Uint8Array([1, 2]))).toThrow(WireError)
    expect(() => new Reader(new Uint8Array([])).u8()).toThrow(WireError)
  })

  it('refuse un varuint sans fin', () => {
    const endless = new Uint8Array(12).fill(0x80)
    expect(() => decode(varuint, endless)).toThrow(WireError)
  })

  it('refuse une longueur de tableau supérieure au buffer', () => {
    // Un pair malveillant annonce 100 000 éléments dans 3 octets : sans garde-fou
    // on allouerait le tableau avant de découvrir le mensonge.
    const hostile = new Uint8Array([0xa0, 0x8d, 0x06])
    expect(() => decode(array(u8), hostile)).toThrow(WireError)
  })

  it('refuse un booléen non canonique', () => {
    expect(() => decode(bool, new Uint8Array([2]))).toThrow(WireError)
  })

  it('refuse de l’UTF-8 invalide', () => {
    expect(() => decode(str, new Uint8Array([2, 0xff, 0xfe]))).toThrow(WireError)
  })

  it('refuse les octets excédentaires', () => {
    // Signale une divergence de version entre pairs : on veut le savoir tout de
    // suite, pas au milieu d'une partie.
    expect(() => decode(u8, new Uint8Array([1, 99]))).toThrow(WireError)
  })
})

describe('combinateurs', () => {
  it('fait l’aller-retour sur un tableau', () => {
    expect(decode(array(varuint), encode(array(varuint), []))).toEqual([])
    expect(decode(array(varuint), encode(array(varuint), [1, 200, 30_000]))).toEqual([1, 200, 30_000])
  })

  it('fait l’aller-retour sur une valeur optionnelle', () => {
    const codec = optional(str)
    expect(decode(codec, encode(codec, undefined))).toBeUndefined()
    expect(decode(codec, encode(codec, 'hôte'))).toBe('hôte')
  })

  it('fait l’aller-retour sur une énumération et rejette l’inconnu', () => {
    const codec = enumOf(['ws', 'webrtc', 'ble', 'nearby'] as const)
    expect(decode(codec, encode(codec, 'ble'))).toBe('ble')
    expect(encode(codec, 'ws')).toHaveLength(1)
    expect(() => decode(codec, new Uint8Array([9]))).toThrow(WireError)
  })

  it('fait l’aller-retour sur une structure', () => {
    const codec = struct({ tick: varuint, seat: u8, alive: bool, name: str })
    const value = { tick: 1234, seat: 2, alive: true, name: 'Ada' }
    expect(decode(codec, encode(codec, value))).toEqual(value)
  })

  it('n’écrit pas de préfixe pour des octets de longueur fixe', () => {
    const codec = fixedBytes(4)
    const value = new Uint8Array([9, 8, 7, 6])
    expect(encode(codec, value)).toHaveLength(4)
    expect(Array.from(decode(codec, encode(codec, value)))).toEqual([9, 8, 7, 6])
    expect(() => encode(codec, new Uint8Array(3))).toThrow(WireError)
  })
})

describe('Writer', () => {
  it('grandit au-delà de sa capacité initiale', () => {
    const w = new Writer(1)
    for (let i = 0; i < 500; i++) w.u8(i % 256)
    expect(w.finish()).toHaveLength(500)
  })

  it('ne refuse aucun flottant parce qu’il n’en propose pas', () => {
    // Test documentaire : l'absence de f32/f64 est délibérée. La simulation est
    // en virgule fixe, et un flottant sur le fil serait une source de désync
    // entre plateformes.
    expect('f32' in Writer.prototype).toBe(false)
    expect('f64' in Writer.prototype).toBe(false)
  })
})
