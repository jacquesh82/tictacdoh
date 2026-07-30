import type { TickInputs } from '@ttd/core'
import {
  Rng,
  assertNoFloats,
  estimatedBytesPerSec,
  findFloats,
  isPlayableOn,
  type MiniGameMeta,
} from '@ttd/game-sdk'
import { BLE_PROFILE, WIFI_PROFILE } from '@ttd/netsim'
import { describe, expect, it } from 'vitest'
import { ESQUIVE_META, INPUT_LEFT, INPUT_RIGHT, encodeInput, esquive } from '../src/index.js'

const SEATS = [0, 1, 2, 3]

/** Trace d'inputs reproductible : chaque siège suit son propre motif. */
function inputsAt(tick: number): TickInputs {
  return SEATS.map((seat) => {
    const phase = (tick + seat * 7) % 11
    if (phase < 4) return new Uint8Array([INPUT_LEFT])
    if (phase < 8) return new Uint8Array([INPUT_RIGHT])
    return new Uint8Array([0])
  })
}

function play(seed: number, ticks: number) {
  const state = esquive.create(SEATS, seed)
  const hashes: number[] = []
  for (let tick = 0; tick < ticks; tick++) {
    if (esquive.isOver(state)) break
    esquive.tick(state, inputsAt(tick))
    hashes.push(esquive.hash(state))
  }
  return { state, hashes }
}

describe('déterminisme', () => {
  it('rejoue à l’identique sur 1000 ticks', () => {
    // C'est le test qui protège tout le netcode. Le socle transmet des inputs,
    // jamais des états : si deux exécutions des mêmes inputs divergent, deux
    // joueurs voient deux parties différentes et rien ne le signale.
    const a = play(0xc0ffee, 1000)
    const b = play(0xc0ffee, 1000)
    expect(a.hashes).toEqual(b.hashes)
    expect(esquive.hash(a.state)).toBe(esquive.hash(b.state))
  })

  it('diverge quand la graine change', () => {
    const a = play(1, 200)
    const b = play(2, 200)
    expect(a.hashes).not.toEqual(b.hashes)
  })

  it('n’emploie ni flottant ni hasard non seedé dans l’état', () => {
    // Vérifié pour **chaque** nombre de joueurs : le placement initial divise
    // la largeur du terrain, et seul le cas à quatre tombait juste. À deux ou
    // trois, un flottant se glissait dans l'état — invisible ici tant que les
    // deux pairs tournaient sur le même moteur JavaScript, mais divergent entre
    // V8 sur Android et JavaScriptCore sur iOS.
    for (const count of [1, 2, 3, 4]) {
      const seats = SEATS.slice(0, count)
      const state = esquive.create(seats, 7)
      for (let tick = 0; tick < 200 && !esquive.isOver(state); tick++) {
        esquive.tick(state, inputsAt(tick))
      }
      // Parcours complet de l'état plutôt qu'une liste de champs à tenir à
      // jour : un champ ajouté plus tard serait sinon oublié ici.
      expect(findFloats(state), `${count} joueur(s)`).toEqual([])
      assertNoFloats(state)
    }
  })

  it('capture le hasard dans l’empreinte', () => {
    // Sans l'état du générateur, deux pairs pourraient avoir la même position
    // apparente et faire apparaître les obstacles suivants à des endroits
    // différents — une désync invisible au premier coup d'œil.
    const state = esquive.create(SEATS, 42)
    const before = esquive.hash(state)
    state.rngState = (state.rngState + 1) >>> 0
    expect(esquive.hash(state)).not.toBe(before)
  })
})

describe('keyframe', () => {
  it('fait l’aller-retour sans perte, hasard compris', () => {
    const { state } = play(0xbeef, 250)
    const restored = esquive.decode(esquive.encode(state))
    expect(esquive.hash(restored)).toBe(esquive.hash(state))

    // Et surtout : la partie doit continuer à l'identique après restauration.
    for (let tick = 250; tick < 320; tick++) {
      esquive.tick(state, inputsAt(tick))
      esquive.tick(restored, inputsAt(tick))
      expect(esquive.hash(restored)).toBe(esquive.hash(state))
    }
  })

  it('reste assez petit pour passer sur un lien BLE', () => {
    const { state } = play(3, 400)
    // Fragmenté par la couche Channel, mais il ne doit pas monopoliser le
    // lien pendant plusieurs secondes.
    expect(esquive.encode(state).length).toBeLessThan(400)
  })
})

describe('règles du jeu', () => {
  it('déplace les joueurs et les garde dans le terrain', () => {
    const state = esquive.create([0], 1)
    const start = state.players[0]!.x
    for (let i = 0; i < 5; i++) esquive.tick(state, [encodeInput(false, true)])
    expect(state.players[0]!.x).toBeGreaterThan(start)

    for (let i = 0; i < 500; i++) esquive.tick(state, [encodeInput(true, false)])
    expect(state.players[0]!.x).toBeGreaterThan(0)
  })

  it('annule les deux directions pressées ensemble', () => {
    const state = esquive.create([0], 1)
    const start = state.players[0]!.x
    esquive.tick(state, [encodeInput(true, true)])
    expect(state.players[0]!.x).toBe(start)
  })

  it('finit toujours par se terminer', () => {
    // Le rythme se resserre avec le temps : sans cela, quatre bons joueurs
    // pourraient jouer indéfiniment et la manche ne rendrait jamais la main.
    for (const seed of [1, 2, 3, 11, 99]) {
      const state = esquive.create(SEATS, seed)
      let tick = 0
      while (!esquive.isOver(state) && tick < 5000) {
        esquive.tick(state, inputsAt(tick))
        tick++
      }
      expect(esquive.isOver(state), `graine ${seed}`).not.toBeNull()
    }
  })

  it('classe les survivants avant les éliminés, du plus tardif au plus tôt', () => {
    const state = esquive.create(SEATS, 5)
    let tick = 0
    while (!esquive.isOver(state) && tick < 5000) {
      esquive.tick(state, inputsAt(tick))
      tick++
    }
    const result = esquive.isOver(state)!
    expect(result.ranking).toHaveLength(4)
    expect([...result.ranking].sort()).toEqual(SEATS)

    const bySeat = new Map(state.players.map((p) => [p.seat, p]))
    for (let i = 1; i < result.ranking.length; i++) {
      const better = bySeat.get(result.ranking[i - 1]!)!
      const worse = bySeat.get(result.ranking[i]!)!
      if (better.alive !== worse.alive) {
        expect(better.alive).toBe(true)
      } else if (!better.alive) {
        expect(better.diedAtTick).toBeGreaterThanOrEqual(worse.diedAtTick)
      }
    }
  })

  it('laisse un joueur solo jouer jusqu’à sa propre erreur', () => {
    const state = esquive.create([0], 8)
    expect(esquive.isOver(state)).toBeNull()
    let tick = 0
    while (!esquive.isOver(state) && tick < 5000) {
      esquive.tick(state, inputsAt(tick))
      tick++
    }
    expect(state.players[0]!.alive).toBe(false)
  })
})

describe('adéquation au lien', () => {
  it('passe sur BLE, le lien le plus contraint', () => {
    // C'est l'aboutissement du socle : un jeu temps réel à quatre tient dans
    // les ~1500 o/s d'un lien Bluetooth, parce que la cadence réseau et la
    // redondance sont dérivées du lien au lieu d'être figées.
    expect(isPlayableOn(ESQUIVE_META, BLE_PROFILE.caps)).toBe(true)
    expect(isPlayableOn(ESQUIVE_META, WIFI_PROFILE.caps)).toBe(true)
    expect(estimatedBytesPerSec(ESQUIVE_META, BLE_PROFILE.caps)).toBeLessThan(1100)
  })

  it('grise malgré tout ce qui ne passera pas', () => {
    // Le filtre garde son sens pour un futur jeu du catalogue : viser
    // gros consomme bien plus qu'un octet de direction.
    const gourmand: MiniGameMeta = {
      ...ESQUIVE_META,
      id: 'visee',
      name: 'Visée',
      inputBytes: 8,
      tickRate: 60,
    }
    expect(isPlayableOn(gourmand, BLE_PROFILE.caps)).toBe(false)
    expect(isPlayableOn(gourmand, WIFI_PROFILE.caps)).toBe(true)
  })

  it('tient dans un octet d’input', () => {
    expect(ESQUIVE_META.inputBytes).toBe(1)
    expect(encodeInput(true, false)[0]).toBe(INPUT_LEFT)
    expect(encodeInput(false, true)[0]).toBe(INPUT_RIGHT)
  })
})

describe('hasard', () => {
  it('fait apparaître les obstacles dans le terrain', () => {
    const rng = new Rng(1)
    void rng
    const { state } = play(0xabc, 600)
    for (const obstacle of state.obstacles) {
      expect(obstacle.x).toBeGreaterThanOrEqual(0)
      expect(obstacle.x).toBeLessThanOrEqual(100_000)
    }
  })
})
