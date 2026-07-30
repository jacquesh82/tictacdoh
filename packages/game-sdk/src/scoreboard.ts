import type { Seat } from '@ttd/core'
import type { GameResult } from './minigame.js'

/**
 * Points d'une manche, par rang.
 *
 * Écart volontairement resserré vers le bas : dans un jeu de soirée, un joueur
 * éliminé en premier doit garder une chance de revenir. Un barème 4/3/2/1
 * plutôt que 10/5/2/0 laisse le classement ouvert jusqu'à la fin.
 */
export function pointsForRank(rank: number, playerCount: number): number {
  return Math.max(0, playerCount - rank)
}

export interface Standing {
  readonly seat: Seat
  readonly points: number
  /** Manches remportées, pour départager à égalité de points. */
  readonly wins: number
}

/**
 * Cumul des points sur plusieurs manches.
 *
 * Aucune synchronisation réseau : chaque pair rejoue la même simulation, obtient
 * donc le même classement, et additionne les mêmes points. Diffuser les scores
 * serait non seulement inutile mais dangereux — deux sources de vérité pour une
 * même donnée finissent toujours par diverger.
 */
export class Scoreboard {
  readonly #points = new Map<Seat, number>()
  readonly #wins = new Map<Seat, number>()
  #rounds = 0

  get rounds(): number {
    return this.#rounds
  }

  /** Enregistre le résultat d'une manche. */
  record(result: GameResult): void {
    this.#rounds++
    const count = result.ranking.length
    result.ranking.forEach((seat, rank) => {
      this.#points.set(seat, (this.#points.get(seat) ?? 0) + pointsForRank(rank, count))
      if (rank === 0) this.#wins.set(seat, (this.#wins.get(seat) ?? 0) + 1)
    })
  }

  /** Classement courant, du premier au dernier. */
  standings(seats: readonly Seat[]): Standing[] {
    return [...seats]
      .map((seat) => ({
        seat,
        points: this.#points.get(seat) ?? 0,
        wins: this.#wins.get(seat) ?? 0,
      }))
      // À égalité de points, le nombre de manches gagnées départage : deux
      // deuxièmes places ne valent pas une victoire.
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.seat - b.seat)
  }

  reset(): void {
    this.#points.clear()
    this.#wins.clear()
    this.#rounds = 0
  }
}
