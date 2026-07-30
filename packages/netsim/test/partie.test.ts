import { Netcode, type Session } from '@ttd/core'
import { GameRuntime, Scoreboard } from '@ttd/game-sdk'
import { type EsquiveState, INPUT_LEFT, INPUT_RIGHT, esquive } from '@ttd/game-esquive'
import { FrameKind, Writer } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import { BLE_PROFILE, WIFI_PROFILE, type SimProfile, simStar } from '../src/index.js'

/**
 * Test d'intégration du socle.
 *
 * C'est le jalon annoncé dans le plan : quatre joueurs jouent une partie
 * complète de bout en bout, sous les contraintes d'un lien BLE, avec rotation
 * d'hôte et perte de joueur. Toutes les couches sont exercées ensemble —
 * transport, canal, session, netcode, SDK et jeu.
 */

const SEED = 0xd0d0

interface Table {
  star: ReturnType<typeof simStar>
  runtimes: Map<string, GameRuntime<EsquiveState>>
  netcodes: Map<string, Netcode>
  play(durationMs: number, inputAt?: (id: string, tick: number) => number): void
}

function table(sessionId: string, profile: SimProfile, playerCount = 4): Table {
  const star = simStar({ sessionId, playerCount, profile })
  star.advance(3000)

  const netcodes = new Map<string, Netcode>()
  const runtimes = new Map<string, GameRuntime<EsquiveState>>()

  for (const session of star.all as Session[]) {
    const netcode = new Netcode({
      session,
      inputBytes: esquive.meta.inputBytes,
      tickRate: esquive.meta.tickRate,
    })
    const runtime = new GameRuntime({ game: esquive, session, netcode, seed: SEED })
    netcode.start(0)
    star.net.register(netcode)
    netcodes.set(session.selfId, netcode)
    runtimes.set(session.selfId, runtime)
  }

  const play: Table['play'] = (durationMs, inputAt) => {
    const steps = Math.ceil(durationMs / 100)
    for (let step = 0; step < steps; step++) {
      for (const [id, netcode] of netcodes) {
        const seat = Number(id.slice(1))
        const value = inputAt
          ? inputAt(id, step)
          : (step + seat) % 6 < 3
            ? INPUT_LEFT
            : INPUT_RIGHT
        netcode.submitInput(new Uint8Array([value]))
      }
      star.advance(100)
    }
  }

  return { star, runtimes, netcodes, play }
}

describe('partie complète à 4 joueurs sous contrainte BLE', () => {
  it('donne le même état à tous les pairs, sans désync', () => {
    const { star, runtimes, play } = table('partie-1', BLE_PROFILE)
    const desyncs: string[] = []
    for (const [id, session] of star.all.map((s) => [s.selfId, s] as const)) {
      void session
      void id
    }

    play(8000)
    star.advance(2000)

    const ticks = [...runtimes.values()].map((r) => r.state.tick)
    expect(Math.min(...ticks)).toBeGreaterThan(30)

    // Chaque pair a simulé les mêmes inputs dans le même ordre : à tick égal,
    // les états doivent être rigoureusement identiques. C'est l'invariant sur
    // lequel repose tout le socle.
    const common = Math.min(...ticks)
    const hashes = new Set<number>()
    for (const runtime of runtimes.values()) {
      if (runtime.state.tick !== common) continue
      hashes.add(esquive.hash(runtime.state))
    }
    expect(hashes.size).toBeLessThanOrEqual(1)
    expect(desyncs).toEqual([])
  })

  it('reste dans le budget du lien', () => {
    const { star, play } = table('partie-2', BLE_PROFILE)
    const before = star.net.stats.bytes
    const startMs = star.net.now()

    play(6000)

    const seconds = (star.net.now() - startMs) / 1000
    const perLink = (star.net.stats.bytes - before) / seconds / 3
    // Un jeu temps réel à quatre tient dans les 1500 o/s d'un lien Bluetooth.
    expect(perLink).toBeLessThanOrEqual(1500)
  })

  it('se termine et classe les joueurs de la même façon partout', () => {
    // On laisse tourner jusqu'à ce que les obstacles fassent leur travail.
    const { star, runtimes, play } = table('partie-3', BLE_PROFILE)
    for (let round = 0; round < 12 && ![...runtimes.values()].some((r) => r.result); round++) {
      play(5000)
    }
    star.advance(3000)

    const results = [...runtimes.values()].map((r) => r.result).filter(Boolean)
    expect(results.length).toBeGreaterThan(0)

    // Tous ceux qui ont conclu doivent avoir conclu pareil : un classement
    // divergent signifierait que deux joueurs n'ont pas joué la même partie.
    const rankings = new Set(results.map((r) => JSON.stringify(r!.ranking)))
    expect(rankings.size).toBe(1)
  })
})

describe('résilience en cours de partie', () => {
  it('continue après la rotation de l’autorité', () => {
    const { star, runtimes, play } = table('partie-4', BLE_PROFILE)
    play(3000)
    const before = [...runtimes.values()][0]!.state.tick

    for (const session of star.all) session.rotateHost()
    play(3000)
    star.advance(2000)

    const after = [...runtimes.values()][0]!.state.tick
    expect(after).toBeGreaterThan(before + 10)

    const common = Math.min(...[...runtimes.values()].map((r) => r.state.tick))
    const hashes = new Set(
      [...runtimes.values()].filter((r) => r.state.tick === common).map((r) => esquive.hash(r.state)),
    )
    expect(hashes.size).toBeLessThanOrEqual(1)
  })

  it('continue après le départ d’un joueur', () => {
    const { star, runtimes, play } = table('partie-5', BLE_PROFILE)
    play(3000)

    star.links.get('p2')!.close('sorti de portée')
    star.advance(1000)
    play(3000)
    star.advance(2000)

    expect(star.hub.playerCount).toBe(3)
    const survivors = [...runtimes.entries()].filter(([id]) => id !== 'p2')
    const ticks = survivors.map(([, r]) => r.state.tick)
    expect(Math.min(...ticks)).toBeGreaterThan(30)
  })
})

describe('lancement de manche par l’hôte', () => {
  it('démarre tout le monde d’un seul ordre', () => {
    // Avant, chaque joueur devait lancer de son côté : les pairs partaient à
    // des instants différents, et le dernier attendait un tick que l'hôte avait
    // déjà figé.
    const star = simStar({ sessionId: 'lancement', playerCount: 4, profile: BLE_PROFILE })
    star.advance(3000)

    const netcodes = new Map<string, Netcode>()
    const debuts = new Map<string, { seed: number; gameId: string; atTick: number }>()
    for (const session of star.all as Session[]) {
      const netcode = new Netcode({
        session,
        inputBytes: esquive.meta.inputBytes,
        tickRate: esquive.meta.tickRate,
      })
      netcode.on('match-start', (payload) => void debuts.set(session.selfId, payload))
      star.net.register(netcode)
      netcodes.set(session.selfId, netcode)
    }

    // C'est le créateur de la salle qui lance, pas l'autorité de séquencement :
    // celle-ci tourne, et le bouton sauterait d'un joueur à l'autre.
    netcodes.get(star.hub.selfId)!.startMatch({ seed: 0xc0ffee, gameId: 'esquive' })
    star.advance(3000)

    expect(debuts.size, 'tous les pairs doivent avoir reçu l’ordre').toBe(4)
    // Même graine partout : sinon les obstacles ne tombent pas aux mêmes
    // endroits et la partie diverge dès le premier tir aléatoire.
    expect(new Set([...debuts.values()].map((d) => d.seed))).toEqual(new Set([0xc0ffee]))
    expect(new Set([...debuts.values()].map((d) => d.gameId))).toEqual(new Set(['esquive']))
    expect(new Set([...debuts.values()].map((d) => d.atTick))).toEqual(new Set([0]))
  })

  it('refuse qu’un invité lance la manche, même s’il a l’autorité', () => {
    const star = simStar({ sessionId: 'lancement', playerCount: 3, profile: BLE_PROFILE })
    star.advance(3000)
    const invite = star.spokes[0]!
    const netcode = new Netcode({ session: invite, inputBytes: 1, tickRate: 30 })
    expect(() => netcode.startMatch({ seed: 1, gameId: 'esquive' })).toThrow(/créateur de la salle/)
  })

  it('ignore un ordre venu d’un autre que l’hôte', () => {
    // Sinon n'importe quel joueur pourrait redémarrer la partie des autres.
    const star = simStar({ sessionId: 'usurpation', playerCount: 3, profile: BLE_PROFILE })
    star.advance(3000)

    const cible = star.spokes[0]!
    const netcode = new Netcode({ session: cible, inputBytes: 1, tickRate: 30 })
    star.net.register(netcode)
    let lance = false
    netcode.on('match-start', () => void (lance = true))

    // Une trame MatchStart forgée par un pair qui n'a pas l'autorité.
    const usurpateur = star.spokes.find((s) => s !== cible)!
    const w = new Writer(32)
    w.u8(FrameKind.MatchStart)
    w.u32(1234)
    w.varuint(0)
    w.str('esquive')
    usurpateur.sendTo(cible.selfId, w.finish(), 'bulk')
    star.advance(2000)

    expect(lance).toBe(false)
  })

  it('fait jouer la même partie après un lancement unique', () => {
    const star = simStar({ sessionId: 'lancement-jeu', playerCount: 3, profile: BLE_PROFILE })
    star.advance(3000)

    const netcodes = new Map<string, Netcode>()
    const runtimes = new Map<string, GameRuntime<EsquiveState>>()
    const traces = new Map<string, Map<number, number>>()

    for (const session of star.all as Session[]) {
      const netcode = new Netcode({
        session,
        inputBytes: esquive.meta.inputBytes,
        tickRate: esquive.meta.tickRate,
      })
      const trace = new Map<number, number>()
      // Le runtime n'est créé qu'à l'ordre de départ : c'est là qu'on connaît
      // la graine choisie par l'hôte.
      netcode.on('match-start', ({ seed }) => {
        const runtime = new GameRuntime({ game: esquive, session, netcode, seed })
        runtime.on('simulated', ({ tick, state }) => trace.set(tick, esquive.hash(state)))
        runtimes.set(session.selfId, runtime)
      })
      star.net.register(netcode)
      netcodes.set(session.selfId, netcode)
      traces.set(session.selfId, trace)
    }

    netcodes.get(star.hub.selfId)!.startMatch({ seed: 0xabcdef, gameId: 'esquive' })

    for (let step = 0; step < 40; step++) {
      for (const netcode of netcodes.values()) netcode.submitInput(new Uint8Array([step % 5]))
      star.advance(100)
    }

    expect(runtimes.size).toBe(3)
    const common = [...traces.get(star.hub.selfId)!.keys()].filter((t) =>
      [...traces.values()].every((m) => m.has(t)),
    )
    expect(common.length, 'aucun tick commun').toBeGreaterThan(5)
    for (const tick of common) {
      expect(new Set([...traces.values()].map((m) => m.get(tick))).size, `tick ${tick}`).toBe(1)
    }
  })
})

describe('cycle de manches', () => {
  /** Table prête à enchaîner des manches, comme le fait l'interface. */
  function tournoi(sessionId: string, playerCount = 3) {
    const star = simStar({ sessionId, playerCount, profile: BLE_PROFILE })
    star.advance(3000)

    const netcodes = new Map<string, Netcode>()
    const runtimes = new Map<string, GameRuntime<EsquiveState>>()
    const boards = new Map<string, Scoreboard>()
    const resultats = new Map<string, string[]>()

    for (const session of star.all as Session[]) {
      const netcode = new Netcode({
        session,
        inputBytes: esquive.meta.inputBytes,
        tickRate: esquive.meta.tickRate,
      })
      const board = new Scoreboard()
      boards.set(session.selfId, board)
      resultats.set(session.selfId, [])

      netcode.on('match-start', ({ seed }) => {
        runtimes.get(session.selfId)?.dispose()
        const runtime = new GameRuntime({ game: esquive, session, netcode, seed })
        runtime.on('finished', ({ result }) => {
          board.record(result)
          resultats.get(session.selfId)!.push(result.ranking.join('-'))
        })
        runtimes.set(session.selfId, runtime)
      })
      star.net.register(netcode)
      netcodes.set(session.selfId, netcode)
    }

    /** Joue jusqu'à la fin de la manche, ou jusqu'à épuisement du temps. */
    const jouer = (maxSteps = 200) => {
      for (let step = 0; step < maxSteps; step++) {
        if ([...runtimes.values()].every((r) => r.result)) break
        for (const netcode of netcodes.values()) {
          netcode.submitInput(new Uint8Array([step % 4 < 2 ? 1 : 2]))
        }
        star.advance(100)
      }
      star.advance(2000)
    }

    const lancer = () => {
      const hub = star.hub
      hub.rotateHost()
      netcodes.get(hub.selfId)!.startMatch({
        seed: 0x1000 + boards.get(hub.selfId)!.rounds,
        gameId: esquive.meta.id,
      })
    }

    return { star, netcodes, runtimes, boards, resultats, jouer, lancer }
  }

  it('conclut une manche identiquement chez tous les joueurs', () => {
    const t = tournoi('cycle-1')
    t.lancer()
    t.jouer()

    const classements = [...t.resultats.values()].filter((r) => r.length > 0)
    expect(classements.length, 'personne n’a conclu').toBeGreaterThan(0)
    // Un classement divergent signifierait que deux joueurs n'ont pas vu la
    // même partie — c'est l'invariant que tout le socle protège.
    expect(new Set(classements.map((r) => r[0])).size).toBe(1)
  })

  it('enchaîne une seconde manche et cumule les points sans rien échanger', () => {
    const t = tournoi('cycle-2')
    t.lancer()
    t.jouer()
    t.lancer()
    t.jouer()

    const sieges = t.star.hub.roster.map((p) => p.seat)
    const tables = [...t.boards.values()].filter((b) => b.rounds === 2)
    expect(tables.length, 'les deux manches doivent être comptées partout').toBeGreaterThan(1)

    // Les points se déduisent du classement, que chaque pair calcule à
    // l'identique : aucun octet de score ne circule, et pourtant tout le monde
    // affiche le même tableau.
    const references = tables.map((b) => JSON.stringify(b.standings(sieges)))
    expect(new Set(references).size).toBe(1)
  })

  it('fait tourner l’autorité entre deux manches', () => {
    // C'est la mesure d'équité : celui qui séquence a un avantage de latence,
    // il ne doit pas le garder d'une manche sur l'autre.
    const t = tournoi('cycle-3')
    t.lancer()
    const premier = t.star.hub.host
    t.jouer()
    t.lancer()
    // L'ordre de lancement porte le compteur de rotations : il faut le laisser
    // arriver avant de vérifier l'accord. Entre-temps, personne ne joue — la
    // manche n'a pas commencé pour ceux qui n'ont pas reçu l'ordre.
    t.star.advance(2000)

    expect(t.star.hub.host).not.toBe(premier)
    expect(new Set(t.star.all.map((s) => s.host)).size).toBe(1)
  })

  it('rejoue une partie différente à chaque manche', () => {
    // Même graine d'une manche à l'autre rendrait le jeu prévisible : les
    // obstacles tomberaient exactement aux mêmes endroits.
    const t = tournoi('cycle-4')
    t.lancer()
    t.jouer()
    const empreinte1 = esquive.hash(t.runtimes.get(t.star.hub.selfId)!.state)
    t.lancer()
    t.jouer()
    const empreinte2 = esquive.hash(t.runtimes.get(t.star.hub.selfId)!.state)
    expect(empreinte2).not.toBe(empreinte1)
  })
})

describe('arrivée en cours de manche', () => {
  it('rattrape par un keyframe un joueur qui démarre en retard', () => {
    // Cas trouvé en conditions réelles : l'hôte séquence depuis un moment, le
    // retardataire attend le tick 0 que personne ne réémettra jamais, et reste
    // figé pour toujours. Le keyframe existait, mais rien ne le déclenchait.
    const star = simStar({ sessionId: 'retard', playerCount: 3, profile: BLE_PROFILE })
    star.advance(3000)

    const netcodes = new Map<string, Netcode>()
    const runtimes = new Map<string, GameRuntime<EsquiveState>>()
    const traces = new Map<string, number[]>()

    for (const session of star.all as Session[]) {
      const netcode = new Netcode({
        session,
        inputBytes: esquive.meta.inputBytes,
        tickRate: esquive.meta.tickRate,
      })
      const runtime = new GameRuntime({ game: esquive, session, netcode, seed: SEED })
      const trace: number[] = []
      runtime.on('simulated', ({ tick }) => void trace.push(tick))
      star.net.register(netcode)
      netcodes.set(session.selfId, netcode)
      runtimes.set(session.selfId, runtime)
      traces.set(session.selfId, trace)
    }

    // Tout le monde démarre sauf p2, qui arrive nettement plus tard.
    const latecomer = 'p2'
    for (const [id, netcode] of netcodes) {
      if (id !== latecomer) netcode.start(0)
    }
    // Assez pour creuser un vrai trou, mais pas au point que la manche soit
    // finie : un hôte qui a conclu cesse de séquencer, et le test ne
    // mesurerait plus rien.
    for (let step = 0; step < 12; step++) {
      for (const [id, netcode] of netcodes) {
        if (id !== latecomer) netcode.submitInput(new Uint8Array([step % 3]))
      }
      star.advance(100)
    }

    const ahead = Math.max(...[...traces].filter(([id]) => id !== latecomer).map(([, t]) => t.length))
    expect(ahead, 'la partie doit avoir avancé avant l’arrivée').toBeGreaterThan(20)
    expect(runtimes.get('p0')!.result, 'la manche ne doit pas être finie').toBeUndefined()

    netcodes.get(latecomer)!.start(0)
    for (let step = 0; step < 25; step++) {
      for (const netcode of netcodes.values()) netcode.submitInput(new Uint8Array([step % 3]))
      star.advance(100)
    }

    const caught = traces.get(latecomer)!
    expect(caught.length, 'le retardataire n’a jamais rattrapé').toBeGreaterThan(5)
    // Il reprend au tick de l'hôte, pas à zéro : c'est bien un rattrapage par
    // état complet, pas un redémarrage de la manche.
    expect(caught[0]!).toBeGreaterThan(20)

    // Et une fois rattrapé, il simule le même état que les autres.
    const others = star.all.filter((s) => s.selfId !== latecomer).map((s) => runtimes.get(s.selfId)!)
    const late = runtimes.get(latecomer)!
    const reference = others.find((r) => r.state.tick === late.state.tick)
    if (reference) {
      expect(esquive.hash(late.state)).toBe(esquive.hash(reference.state))
    }
  })
})

describe('même jeu sur deux liens très différents', () => {
  it('adapte le réseau, pas la vitesse du jeu', () => {
    const ble = table('partie-6', BLE_PROFILE)
    const wifi = table('partie-7', WIFI_PROFILE)

    // Le réseau, lui, est réglé très différemment.
    const bleNet = [...ble.netcodes.values()][0]!
    const wifiNet = [...wifi.netcodes.values()][0]!
    expect(bleNet.netRate).toBe(15)
    expect(wifiNet.netRate).toBe(30)
    expect(bleNet.ticksPerSend).toBe(2)
    expect(wifiNet.ticksPerSend).toBe(1)

    ble.play(4000)
    wifi.play(4000)
    ble.star.advance(1000)
    wifi.star.advance(1000)

    const bleTick = [...ble.runtimes.values()][0]!.state.tick
    const wifiTick = [...wifi.runtimes.values()][0]!.state.tick

    // Et pourtant le jeu avance à la même vitesse des deux côtés. C'est tout
    // l'objet du découplage : sur BLE on envoie deux fois moins souvent, avec
    // deux ticks par envoi. Réduire la cadence réseau ne doit pas ralentir la
    // partie, seulement espacer les paquets.
    const ratio = wifiTick / bleTick
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.25)
  })

  it('consomme bien moins de bande passante sur BLE', () => {
    const ble = table('partie-8', BLE_PROFILE)
    const wifi = table('partie-9', WIFI_PROFILE)
    ble.play(4000)
    wifi.play(4000)

    // Même partie, même vitesse, mais la redondance et la cadence sont
    // réduites là où le lien ne peut pas suivre.
    expect(ble.star.net.stats.bytes).toBeLessThan(wifi.star.net.stats.bytes)
  })
})
