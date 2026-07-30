import { describe, expect, it } from 'vitest'
import {
  FX_MAX,
  FX_ONE,
  fx,
  fxAbs,
  fxAssertSafe,
  fxClamp,
  fxDiv,
  fxFloor,
  fxFromInt,
  fxMul,
  fxRound,
  fxSqrt,
  fxToNumber,
} from '../src/index.js'

describe('virgule fixe', () => {
  it('convertit dans les deux sens', () => {
    expect(fx(1)).toBe(FX_ONE)
    expect(fx(1.5)).toBe(1500)
    expect(fx(-0.25)).toBe(-250)
    expect(fxToNumber(fx(3.75))).toBe(3.75)
    expect(fxFromInt(7)).toBe(7000)
  })

  it('ne produit que des entiers', () => {
    // C'est toute la raison d'être du module : un flottant qui se glisse dans
    // la simulation fait diverger deux plateformes en quelques centaines de
    // ticks, sans rien signaler.
    const values = [fx(0.1), fxMul(fx(0.1), fx(0.3)), fxDiv(fx(1), fx(3)), fxSqrt(fx(2))]
    for (const value of values) expect(Number.isInteger(value)).toBe(true)
  })

  it('multiplie et divise de façon reproductible', () => {
    expect(fxMul(fx(2), fx(3))).toBe(fx(6))
    expect(fxMul(fx(0.5), fx(0.5))).toBe(fx(0.25))
    expect(fxDiv(fx(6), fx(3))).toBe(fx(2))
    expect(fxDiv(fx(1), fx(4))).toBe(fx(0.25))
    expect(() => fxDiv(fx(1), 0)).toThrow(RangeError)
  })

  it('donne exactement le même résultat à chaque exécution', () => {
    const run = () => {
      let value = fx(1)
      for (let i = 1; i <= 500; i++) {
        value = fxMul(value, fx(1.001))
        value = fxDiv(value, fx(1.0005))
        value = fxAbs(value)
      }
      return value
    }
    expect(run()).toBe(run())
  })

  it('arrondit vers le bas y compris pour les négatifs', () => {
    expect(fxFloor(fx(2.7))).toBe(2)
    expect(fxFloor(fx(-2.1))).toBe(-3)
    expect(fxRound(fx(2.5))).toBe(3)
  })

  it('borne et prend la valeur absolue', () => {
    expect(fxClamp(fx(5), fx(0), fx(3))).toBe(fx(3))
    expect(fxClamp(fx(-5), fx(0), fx(3))).toBe(fx(0))
    expect(fxAbs(fx(-2.5))).toBe(fx(2.5))
  })

  it('calcule une racine reproductible', () => {
    expect(fxSqrt(fx(4))).toBe(fx(2))
    expect(fxSqrt(fx(9))).toBe(fx(3))
    expect(fxSqrt(fx(0))).toBe(0)
    expect(() => fxSqrt(fx(-1))).toThrow(RangeError)
  })

  it('signale une valeur sortie du domaine sûr', () => {
    // Au-delà de 2^26, le produit de deux valeurs dépasse l'entier sûr et la
    // multiplication perd des bits — donc le déterminisme.
    expect(fxAssertSafe(fx(1000))).toBe(fx(1000))
    expect(() => fxAssertSafe(FX_MAX + 1)).toThrow(RangeError)
    expect(() => fxAssertSafe(1.5)).toThrow(TypeError)
  })

  it('reste exact aux limites du domaine', () => {
    const big = FX_MAX - 1
    expect(Number.isSafeInteger(big * big)).toBe(true)
    expect(Number.isInteger(fxMul(big, fx(1)))).toBe(true)
  })
})
