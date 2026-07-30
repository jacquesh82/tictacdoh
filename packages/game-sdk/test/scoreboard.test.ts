import { describe, expect, it } from 'vitest'
import { Scoreboard, pointsForRank } from '../src/index.js'

describe('barème', () => {
  it('récompense le rang, sans écraser les derniers', () => {
    // Un écart resserré garde le classement ouvert : un joueur éliminé tôt doit
    // pouvoir revenir sur les manches suivantes.
    expect(pointsForRank(0, 4)).toBe(4)
    expect(pointsForRank(3, 4)).toBe(1)
    expect(pointsForRank(0, 2)).toBe(2)
  })
})

describe('cumul sur plusieurs manches', () => {
  it('additionne et classe', () => {
    const board = new Scoreboard()
    board.record({ ranking: [0, 1, 2, 3], reason: 'dernier survivant' })
    board.record({ ranking: [3, 2, 1, 0], reason: 'dernier survivant' })

    expect(board.rounds).toBe(2)
    const standings = board.standings([0, 1, 2, 3])
    // 0 et 3 ont chacun 4+1 = 5 points et une victoire ; 1 et 2 ont 3+2 = 5
    // points sans victoire. Les vainqueurs passent devant.
    expect(standings.map((s) => s.points)).toEqual([5, 5, 5, 5])
    expect(standings.slice(0, 2).map((s) => s.seat).sort()).toEqual([0, 3])
    expect(standings.slice(0, 2).every((s) => s.wins === 1)).toBe(true)
  })

  it('départage à égalité par les manches gagnées', () => {
    // Deux deuxièmes places ne valent pas une victoire, même à points égaux.
    const board = new Scoreboard()
    board.record({ ranking: [0, 1], reason: 'x' })
    board.record({ ranking: [1, 0], reason: 'x' })
    board.record({ ranking: [0, 1], reason: 'x' })
    const standings = board.standings([0, 1])
    expect(standings[0]!.seat).toBe(0)
    expect(standings[0]!.wins).toBe(2)
  })

  it('donne le même classement à tous les pairs sans échanger un octet', () => {
    // Les points se déduisent du classement, que chaque pair calcule à
    // l'identique. Les diffuser créerait une seconde source de vérité, et deux
    // sources finissent toujours par diverger.
    const manches = [
      { ranking: [2, 0, 1], reason: 'x' },
      { ranking: [1, 2, 0], reason: 'x' },
      { ranking: [0, 1, 2], reason: 'x' },
    ]
    const a = new Scoreboard()
    const b = new Scoreboard()
    for (const m of manches) a.record(m)
    for (const m of manches) b.record(m)
    expect(a.standings([0, 1, 2])).toEqual(b.standings([0, 1, 2]))
  })

  it('repart de zéro sur demande', () => {
    const board = new Scoreboard()
    board.record({ ranking: [0, 1], reason: 'x' })
    board.reset()
    expect(board.rounds).toBe(0)
    expect(board.standings([0, 1]).every((s) => s.points === 0)).toBe(true)
  })
})
