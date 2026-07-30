import { Netcode, type TickInputs, netRateFor, redundancyFor } from '@ttd/core'
import { INPUT_REDUNDANCY_BLE, INPUT_REDUNDANCY_DEFAULT } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import { BLE_PROFILE, WIFI_PROFILE, simStar } from '../src/index.js'
import type { SimProfile } from '../src/index.js'

const INPUT_BYTES = 1

/**
 * Quatre joueurs en train de jouer : sessions établies, netcodes démarrés,
 * chaque tick confirmé rejoué dans une trace locale par pair.
 */
function playing(sessionId: string, profile: SimProfile, playerCount = 4) {
  const star = simStar({ sessionId, playerCount, profile })
  star.advance(3000)

  const netcodes = new Map<string, Netcode>()
  const traces = new Map<string, { tick: number; inputs: TickInputs }[]>()

  for (const session of star.all) {
    const netcode = new Netcode({ session, inputBytes: INPUT_BYTES, tickRate: 30 })
    const trace: { tick: number; inputs: TickInputs }[] = []
    netcode.on('tick', (payload) => void trace.push(payload))
    netcode.start(0)
    netcodes.set(session.selfId, netcode)
    traces.set(session.selfId, trace)
    star.net.register(netcode)
  }

  return { star, netcodes, traces }
}

describe('cadence dérivée du lien', () => {
  it('descend à 15 Hz sur BLE et monte à 30 Hz sur Wi-Fi', () => {
    // Le mini-jeu ne change pas ; seul le réseau s'adapte. C'est ce qui permet
    // au même jeu de tourner sur les deux sans code spécifique.
    expect(netRateFor(BLE_PROFILE.caps)).toBe(15)
    expect(netRateFor(WIFI_PROFILE.caps)).toBe(30)
  })

  it('réduit la redondance sur BLE', () => {
    expect(redundancyFor(BLE_PROFILE.caps)).toBe(INPUT_REDUNDANCY_BLE)
    expect(redundancyFor(WIFI_PROFILE.caps)).toBe(INPUT_REDUNDANCY_DEFAULT)
  })
})

describe('séquencement sous profil BLE', () => {
  it('confirme les ticks dans l’ordre et sans trou chez tous les pairs', () => {
    const { star, traces } = playing('nc-1', BLE_PROFILE)
    star.advance(4000)

    for (const [id, trace] of traces) {
      expect(trace.length, `${id} n'a reçu aucun tick`).toBeGreaterThan(20)
      const ticks = trace.map((entry) => entry.tick)
      // Sans trou et strictement croissant : un jeu déterministe ne peut pas
      // sauter un tick ni le rejouer.
      expect(ticks).toEqual(Array.from({ length: ticks.length }, (_, i) => ticks[0]! + i))
    }
  })

  it('donne à tous les pairs exactement la même suite d’inputs', () => {
    const { star, netcodes, traces } = playing('nc-2', BLE_PROFILE)

    // Chaque joueur appuie sur des touches différentes au fil du temps.
    for (let step = 0; step < 40; step++) {
      for (const [id, netcode] of netcodes) {
        const seat = Number(id.slice(1))
        netcode.submitInput(new Uint8Array([(step * 7 + seat * 13) % 256]))
      }
      star.advance(100)
    }
    star.advance(3000)

    const serialize = (trace: { tick: number; inputs: TickInputs }[]) =>
      trace.map((e) => `${e.tick}:${e.inputs.map((i) => (i ? Array.from(i).join('.') : '-')).join(',')}`)

    const reference = serialize(traces.get('p0')!)
    const commonLength = Math.min(...[...traces.values()].map((t) => t.length))
    expect(commonLength).toBeGreaterThan(20)

    // C'est l'invariant sur lequel repose toute la réplication : mêmes inputs,
    // même ordre, donc même état simulé chez tout le monde.
    for (const [id, trace] of traces) {
      expect(serialize(trace).slice(0, commonLength), `divergence chez ${id}`).toEqual(
        reference.slice(0, commonLength),
      )
    }
  })

  it('tient dans le budget du lien BLE', () => {
    const { star, netcodes } = playing('nc-3', BLE_PROFILE)
    const before = star.net.stats.bytes
    const startMs = star.net.now()

    for (let step = 0; step < 50; step++) {
      for (const netcode of netcodes.values()) netcode.submitInput(new Uint8Array([step % 256]))
      star.advance(100)
    }

    const seconds = (star.net.now() - startMs) / 1000
    const bytesPerSec = (star.net.stats.bytes - before) / seconds
    // Trois liens actifs, chacun plafonné à 1500 o/s. On vérifie l'agrégat.
    expect(bytesPerSec).toBeLessThanOrEqual(1500 * 3)
  })

  it('ne bloque pas sur un joueur silencieux', () => {
    const { star, netcodes, traces } = playing('nc-4', BLE_PROFILE)

    // p2 n'appuie sur rien du tout. La partie doit continuer : son silence
    // vaut « aucune touche », il ne fige pas les trois autres.
    for (let step = 0; step < 30; step++) {
      for (const [id, netcode] of netcodes) {
        if (id === 'p2') continue
        netcode.submitInput(new Uint8Array([1]))
      }
      star.advance(100)
    }
    star.advance(2000)

    expect(traces.get('p0')!.length).toBeGreaterThan(20)
    expect(traces.get('p2')!.length).toBeGreaterThan(20)
  })
})

describe('équité du délai d’input', () => {
  it('impose à tous le délai calculé par l’hôte', () => {
    const { star, netcodes } = playing('nc-5', BLE_PROFILE)
    star.advance(4000)

    const delays = [...netcodes.values()].map((n) => n.inputDelayTicks)

    // Seul l'hôte mesure l'aller-retour de tous les joueurs : un rayon ne voit
    // que le hub. S'il calculait son délai lui-même, chacun jouerait avec sa
    // propre avance et l'équité tomberait. Le délai est donc diffusé.
    expect(new Set(delays).size).toBe(1)
    expect(delays[0]).toBeGreaterThanOrEqual(3)
  })

  it('couvre au moins l’espacement des envois réseau', () => {
    // Un input soumis pour un tick que l'hôte a déjà figé est perdu, et le jeu
    // paraît ne pas répondre. Le délai doit donc dépasser ticksPerSend.
    const { star, netcodes } = playing('nc-6', BLE_PROFILE)
    star.advance(4000)
    const host = netcodes.get(star.hub.host)!
    expect(host.inputDelayTicks).toBeGreaterThan(host.ticksPerSend)
  })

  it('grandit avec la latence du lien', () => {
    const fast = playing('nc-7', WIFI_PROFILE, 2)
    fast.star.advance(5000)
    const slow = playing('nc-8', { ...BLE_PROFILE, latencyMs: 150, jitterMs: 10 }, 2)
    slow.star.advance(5000)

    const fastDelay = fast.netcodes.get('p0')!.computeInputDelay()
    const slowDelay = slow.netcodes.get('p0')!.computeInputDelay()
    expect(slowDelay).toBeGreaterThan(fastDelay)
  })
})

describe('attribution des inputs quand l’hôte n’est pas le hub', () => {
  it('attribue chaque input au bon siège malgré le relais', () => {
    // Régression : l'enveloppe de routage ne portait pas le siège d'origine.
    // Le destinataire croyait donc que le hub était l'émetteur, et les inputs
    // des trois joueurs finissaient tous sur le siège du hub dès que
    // l'autorité quittait le centre de l'étoile.
    const { star, netcodes, traces } = playing('nc-10', BLE_PROFILE)

    // On amène l'autorité sur un rayon.
    while (star.hub.isHost) for (const session of star.all) session.rotateHost()
    for (const netcode of netcodes.values()) netcode.start(0)
    star.advance(2000)

    // Chaque joueur envoie une valeur qui l'identifie de façon unique.
    for (let step = 0; step < 30; step++) {
      for (const [id, netcode] of netcodes) {
        netcode.submitInput(new Uint8Array([Number(id.slice(1)) + 1]))
      }
      star.advance(100)
    }
    star.advance(2000)

    const seats = star.hub.roster
    const expected = new Map(seats.map((p) => [p.seat, Number(p.id.slice(1)) + 1]))

    // On ne regarde que les ticks où les quatre sièges sont servis. Aux
    // extrémités de la trace, la fenêtre de maintien d'input a expiré et les
    // valeurs retombent à zéro — c'est le comportement voulu, pas une erreur
    // d'attribution.
    const trace = traces.get('p0')!
    const complete = trace.filter((e) => seats.every((p) => (e.inputs[p.seat]?.[0] ?? 0) !== 0))
    expect(complete.length, 'aucun tick où les 4 joueurs sont servis').toBeGreaterThan(10)

    for (const entry of complete) {
      for (const [seat, value] of expected) {
        expect(entry.inputs[seat]?.[0], `tick ${entry.tick}, siège ${seat}`).toBe(value)
      }
    }
  })
})

describe('rotation d’hôte en cours de partie', () => {
  it('reprend le séquencement sans transférer d’état', () => {
    const { star, netcodes, traces } = playing('nc-9', BLE_PROFILE)

    for (let step = 0; step < 20; step++) {
      for (const netcode of netcodes.values()) netcode.submitInput(new Uint8Array([step % 256]))
      star.advance(100)
    }
    const beforeHost = star.hub.host
    const ticksBefore = traces.get('p0')!.length

    // La manche est finie : l'autorité passe au suivant. Aucun état ne
    // circule, chaque pair a déjà simulé la partie complète.
    for (const session of star.all) session.rotateHost()
    expect(star.hub.host).not.toBe(beforeHost)

    for (let step = 0; step < 20; step++) {
      for (const netcode of netcodes.values()) netcode.submitInput(new Uint8Array([step % 256]))
      star.advance(100)
    }
    star.advance(2000)

    // La partie continue d'avancer sous la nouvelle autorité.
    expect(traces.get('p0')!.length).toBeGreaterThan(ticksBefore + 10)
    const ticks = traces.get('p0')!.map((e) => e.tick)
    expect(ticks).toEqual(Array.from({ length: ticks.length }, (_, i) => ticks[0]! + i))
  })
})
