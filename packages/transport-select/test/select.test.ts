import type { TransportCaps } from '@ttd/core'
import { esquive } from '@ttd/game-esquive'
import type { MiniGameMeta } from '@ttd/game-sdk'
import { BLE_CAPS } from '@ttd/transport-ble'
import { LOCAL_CAPS } from '@ttd/transport-local'
import { NEARBY_CAPS } from '@ttd/transport-nearby'
import { WEBRTC_CAPS } from '@ttd/transport-webrtc'
import { WS_CAPS } from '@ttd/transport-ws'
import { describe, expect, it } from 'vitest'
import {
  type ProbeResult,
  type TransportCandidate,
  explainSelection,
  rankTransports,
  scoreTransport,
  selectTransport,
} from '../src/index.js'

function candidate(caps: TransportCaps, probe: ProbeResult): TransportCandidate {
  return { kind: caps.kind, caps, probe: () => Promise.resolve(probe) }
}

const reachable = (rttMs?: number): ProbeResult => ({ reachable: true, rttMs, peersFound: 1 })
const absent = (reason: string): ProbeResult => ({ reachable: false, reason })

describe('portes successives', () => {
  it('écarte un transport que personne ne peut joindre', () => {
    // Sonder plutôt que se fier aux capacités : un appareil sait très bien
    // faire du Bluetooth sans que personne ne soit à portée.
    const score = scoreTransport(candidate(NEARBY_CAPS, absent('personne à portée')), absent('personne à portée'))
    expect(score.usable).toBe(false)
    expect(score.reason).toContain('personne à portée')
  })

  it('écarte un lien incapable de porter le jeu, même joignable', () => {
    const gourmand: MiniGameMeta = { ...esquive.meta, inputBytes: 8, tickRate: 60 }
    const score = scoreTransport(candidate(BLE_CAPS, reachable(60)), reachable(60), { game: gourmand })
    // Mieux vaut un lien lent qui tient qu'un lien rapide qui saccade — et
    // mieux vaut encore le dire avant de lancer la partie.
    expect(score.usable).toBe(false)
    expect(score.reason).toContain('o/s')
  })

  it('accepte Esquive sur Bluetooth, le lien le plus contraint', () => {
    const score = scoreTransport(candidate(BLE_CAPS, reachable(60)), reachable(60), {
      game: esquive.meta,
    })
    expect(score.usable).toBe(true)
  })
})

describe('classement', () => {
  it('préfère le hors-ligne à un relay pourtant bien plus rapide', async () => {
    // C'est le point où « fiable » se sépare de « rapide » : le relay est plus
    // véloce que le Bluetooth, mais il suppose du réseau mobile, un serveur en
    // ligne et un opérateur qui répond.
    const ranked = await rankTransports([
      candidate(WS_CAPS, reachable(40)),
      candidate(BLE_CAPS, reachable(60)),
    ])
    expect(ranked[0]!.kind).toBe('ble')
    expect(ranked[0]!.reason).toContain('hors ligne')
  })

  it('préfère le Wi-Fi Direct au Bluetooth quand les deux sont là', async () => {
    // Les deux sont hors-ligne : à égalité sur le critère décisif, c'est le
    // débit qui tranche, et l'écart est de deux ordres de grandeur.
    const ranked = await rankTransports([
      candidate(BLE_CAPS, reachable(60)),
      candidate(NEARBY_CAPS, reachable(25)),
    ])
    expect(ranked[0]!.kind).toBe('nearby')
    expect(ranked[1]!.kind).toBe('ble')
  })

  it('retombe sur le relay quand le pair à pair échoue', async () => {
    const ranked = await rankTransports([
      candidate(WEBRTC_CAPS, absent('NAT symétrique, pas de TURN')),
      candidate(WS_CAPS, reachable(90)),
    ])
    expect(ranked[0]!.kind).toBe('ws')
    expect(ranked.find((r) => r.kind === 'webrtc')!.usable).toBe(false)
  })

  it('place le même appareil devant tout le reste', async () => {
    // Rien ne bat l'absence de réseau.
    const ranked = await rankTransports([
      candidate(NEARBY_CAPS, reachable(25)),
      candidate(LOCAL_CAPS, reachable(0)),
      candidate(WS_CAPS, reachable(40)),
    ])
    expect(ranked[0]!.kind).toBe('local')
  })

  it('pénalise une livraison non garantie', async () => {
    const fragile: TransportCaps = { ...NEARBY_CAPS, kind: 'sim', reliable: false }
    const ranked = await rankTransports([
      candidate(fragile, reachable(25)),
      candidate(NEARBY_CAPS, reachable(25)),
    ])
    expect(ranked[0]!.kind).toBe('nearby')
  })

  it('tient compte de la latence mesurée, pas de celle annoncée', async () => {
    // Un Bluetooth mesuré à 400 ms — appareil au fond du sac — doit passer
    // derrière un Wi-Fi Direct mesuré à 20 ms.
    const ranked = await rankTransports([
      candidate(BLE_CAPS, reachable(400)),
      candidate(NEARBY_CAPS, reachable(20)),
    ])
    expect(ranked[0]!.kind).toBe('nearby')
  })
})

describe('sélection', () => {
  it('rend un choix, ses replis, et de quoi les expliquer', async () => {
    const selection = await selectTransport(
      [
        candidate(BLE_CAPS, reachable(60)),
        candidate(NEARBY_CAPS, reachable(25)),
        candidate(WS_CAPS, reachable(90)),
        candidate(WEBRTC_CAPS, absent('NAT symétrique')),
      ],
      { game: esquive.meta },
    )

    expect(selection.chosen!.kind).toBe('nearby')
    expect(selection.fallbacks.map((f) => f.kind)).toEqual(['ble', 'ws'])
    // Les écartés restent visibles : la page de diagnostic doit pouvoir dire
    // *pourquoi* un transport n'a pas été retenu.
    expect(selection.all).toHaveLength(4)
    expect(explainSelection(selection)).toMatch(/nearby retenu.*repli sur ble/)
  })

  it('le dit franchement quand rien ne convient', async () => {
    const selection = await selectTransport([
      candidate(BLE_CAPS, absent('Bluetooth éteint')),
      candidate(WS_CAPS, absent('pas de réseau')),
    ])
    expect(selection.chosen).toBeUndefined()
    expect(explainSelection(selection)).toContain('Bluetooth éteint')
    expect(explainSelection(selection)).toContain('pas de réseau')
  })

  it('signale l’absence de repli', async () => {
    const selection = await selectTransport([candidate(BLE_CAPS, reachable(60))])
    expect(explainSelection(selection)).toContain('sans repli')
  })

  it('survit à un sondage qui lève', async () => {
    // Une pile native qui plante ne doit pas emporter la sélection entière.
    const explosive: TransportCandidate = {
      kind: 'ble',
      caps: BLE_CAPS,
      probe: () => Promise.reject(new Error('pile Bluetooth en erreur')),
    }
    const selection = await selectTransport([explosive, candidate(WS_CAPS, reachable(90))])
    expect(selection.chosen!.kind).toBe('ws')
    expect(selection.all.find((s) => s.kind === 'ble')!.reason).toContain('pile Bluetooth en erreur')
  })
})
