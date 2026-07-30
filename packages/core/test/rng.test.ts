import { describe, expect, it } from 'vitest'
import { Rng, seedFrom } from '../src/index.js'

describe('Rng', () => {
  it('donne la même suite pour une même graine', () => {
    // C'est l'hypothèse sur laquelle repose toute la réplication : deux pairs
    // partis de la même graine doivent simuler exactement la même partie.
    const a = new Rng(12345)
    const b = new Rng(12345)
    const left = Array.from({ length: 100 }, () => a.nextUint32())
    const right = Array.from({ length: 100 }, () => b.nextUint32())
    expect(left).toEqual(right)
  })

  it('donne des suites différentes pour des graines différentes', () => {
    const a = Array.from({ length: 20 }, (_, i) => new Rng(i).nextUint32())
    expect(new Set(a).size).toBe(20)
  })

  it('reste dans les entiers 32 bits non signés', () => {
    const rng = new Rng(7)
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextUint32()
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(0xffff_ffff)
    }
  })

  it('tire uniformément sous une borne', () => {
    const rng = new Rng(99)
    const buckets = new Array<number>(6).fill(0)
    for (let i = 0; i < 60_000; i++) buckets[rng.nextBelow(6)]!++
    // Sans rejet de la queue, le modulo brut favoriserait les petites valeurs.
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(600)
  })

  it('mélange de façon reproductible', () => {
    const items = () => ['p0', 'p1', 'p2', 'p3']
    const a = new Rng(seedFrom('session-abc')).shuffle(items())
    const b = new Rng(seedFrom('session-abc')).shuffle(items())
    expect(a).toEqual(b)
    expect([...a].sort()).toEqual(items())
  })

  it('restaure son état, pour reprendre un keyframe', () => {
    const rng = new Rng(42)
    for (let i = 0; i < 10; i++) rng.nextUint32()
    const snapshot = rng.state
    const expected = Array.from({ length: 5 }, () => rng.nextUint32())

    const restored = new Rng(0)
    restored.state = snapshot
    expect(Array.from({ length: 5 }, () => restored.nextUint32())).toEqual(expected)
  })

  it('dérive des graines distinctes de chaînes proches', () => {
    expect(seedFrom('session-a')).not.toBe(seedFrom('session-b'))
    expect(seedFrom('')).toBe(seedFrom(''))
  })
})
