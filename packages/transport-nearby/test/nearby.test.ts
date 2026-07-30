import { Netcode, Session, TransportError } from '@ttd/core'
import { GameRuntime } from '@ttd/game-sdk'
import { type EsquiveState, esquive } from '@ttd/game-esquive'
import { FrameKind, frame, u8 } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import {
  NEARBY_CAPS,
  NearbyTransport,
  codeFromEndpointName,
  endpointNameFor,
} from '../src/index.js'
import { FakeNearbyNetwork, FakeNearbyPlugin, type Platform } from './fake-plugin.js'

const SERVICE = 'app.tictacdoh'
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function device(network: FakeNearbyNetwork, id: string, platform: Platform = 'android') {
  const plugin = FakeNearbyPlugin.register(new FakeNearbyPlugin({ id, network, platform }))
  return { plugin, transport: new NearbyTransport({ plugin, serviceId: SERVICE }) }
}

async function star(code: string, guestCount: number, platform: Platform = 'android') {
  const network = new FakeNearbyNetwork()
  const host = device(network, `hote-${code}`, platform)
  const hostLinks: Awaited<ReturnType<NearbyTransport['connect']>>[] = []
  host.transport.onIncoming((link) => void hostLinks.push(link))
  await host.transport.advertise({
    sessionId: 'sess-nearby',
    code,
    hostName: 'Salon',
    playerCount: 1,
    maxPlayers: 4,
  })

  const guests = []
  for (let i = 0; i < guestCount; i++) {
    const guest = device(network, `invite-${code}-${i}`, platform)
    const found = await guest.transport.findByCode(code, 500)
    const link = await guest.transport.connect(found, 1000)
    guests.push({ ...guest, link })
  }
  await settle()
  return { network, host, hostLinks, guests }
}

describe('capacités', () => {
  it('annonce un lien large et hors-ligne', () => {
    // Sans commune mesure avec le BLE : c'est ce qui permet au même jeu d'y
    // tourner à pleine cadence sans une ligne de code différente.
    expect(NEARBY_CAPS.requiresInternet).toBe(false)
    expect(NEARBY_CAPS.throughputBytesPerSec).toBeGreaterThan(100_000)
    expect(NEARBY_CAPS.canAdvertise).toBe(true)
    expect(NEARBY_CAPS.canDiscover).toBe(true)
  })
})

describe('nom d’endpoint', () => {
  it('porte le code et se relit', () => {
    // Le nom est le seul champ lisible pendant la découverte : sans le code
    // dedans, il faudrait se connecter à chaque appareil pour savoir lequel
    // héberge la bonne partie.
    const name = endpointNameFor('048213', 'Le salon de Jacques')
    expect(codeFromEndpointName(name)).toBe('048213')
  })

  it('ignore un nom étranger à l’application', () => {
    expect(codeFromEndpointName('imprimante-bureau')).toBeUndefined()
    expect(codeFromEndpointName('ttd-abc-x')).toBeUndefined()
  })

  it('tronque un nom d’hôte très long', () => {
    // Nearby comme Multipeer bornent la longueur du nom d'endpoint.
    const name = endpointNameFor('048213', 'un nom vraiment beaucoup trop long pour tenir')
    expect(name.length).toBeLessThan(40)
    expect(codeFromEndpointName(name)).toBe('048213')
  })
})

describe('découverte et connexion', () => {
  it('relie trois invités à l’hôte', async () => {
    const { hostLinks, guests } = await star('048213', 3)
    expect(hostLinks).toHaveLength(3)
    expect(guests.every((g) => !g.link.closed)).toBe(true)
  })

  it('ne trouve que l’hôte portant le bon code', async () => {
    const network = new FakeNearbyNetwork()
    const wanted = device(network, 'bon')
    const other = device(network, 'autre')
    const seeker = device(network, 'chercheur')

    await wanted.transport.advertise({
      sessionId: 'a',
      code: '048213',
      hostName: 'La bonne',
      playerCount: 1,
      maxPlayers: 4,
    })
    await other.transport.advertise({
      sessionId: 'b',
      code: '999999',
      hostName: 'Autre',
      playerCount: 1,
      maxPlayers: 4,
    })

    const found = await seeker.transport.findByCode('048213', 500)
    expect(found.address).toBe('bon')
  })

  it('ne voit jamais l’autre famille de plateformes', async () => {
    // C'est la contrainte décisive de ce transport, et la raison d'être du
    // BLE dans le socle : Nearby Connections et MultipeerConnectivity n'ont
    // aucun protocole commun.
    const network = new FakeNearbyNetwork()
    const android = device(network, 'android-hote', 'android')
    const iphone = device(network, 'iphone', 'ios')

    await android.transport.advertise({
      sessionId: 'a',
      code: '048213',
      hostName: 'Android',
      playerCount: 1,
      maxPlayers: 4,
    })

    await expect(iphone.transport.findByCode('048213', 200)).rejects.toThrow(/à proximité/)
  })

  it('relie deux iPhone entre eux', async () => {
    const { hostLinks } = await star('112233', 1, 'ios')
    expect(hostLinks).toHaveLength(1)
  })

  it('abandonne au bout du délai imparti', async () => {
    const network = new FakeNearbyNetwork()
    const seeker = device(network, 'seul')
    await expect(seeker.transport.findByCode('000000', 150)).rejects.toThrow(TransportError)
  })

  it('refuse si le Wi-Fi est éteint', async () => {
    const network = new FakeNearbyNetwork()
    const plugin = new FakeNearbyPlugin({ id: 'off', network, available: false })
    const transport = new NearbyTransport({ plugin, serviceId: SERVICE })
    await expect(
      transport.advertise({
        sessionId: 'a',
        code: '048213',
        hostName: 'H',
        playerCount: 1,
        maxPlayers: 4,
      }),
    ).rejects.toThrow(/indisponible|Wi-Fi/)
  })
})

describe('acheminement', () => {
  it('achemine dans les deux sens sans altérer les octets', async () => {
    const { hostLinks, guests } = await star('048213', 2)
    const guestGot: number[] = []
    const hostGot: number[] = []
    guests[0]!.link.on('message', (m) => void guestGot.push(m[1]!))
    for (const link of hostLinks) link.on('message', (m) => void hostGot.push(m[1]!))

    const target = hostLinks.find((l) => l.peerId === guests[0]!.plugin.id)!
    target.send(frame(FrameKind.TickBatch, u8, 55))
    guests[0]!.link.send(frame(FrameKind.Input, u8, 66))
    await settle()

    expect(guestGot).toEqual([55])
    expect(hostGot).toEqual([66])
  })

  it('transporte une charge utile volumineuse intacte', async () => {
    const { hostLinks, guests } = await star('048213', 1)
    const got: Uint8Array[] = []
    guests[0]!.link.on('message', (m) => void got.push(m))

    const big = new Uint8Array(20_000)
    big[0] = FrameKind.Keyframe
    for (let i = 1; i < big.length; i++) big[i] = (i * 11) % 251
    hostLinks[0]!.send(big)
    await settle()

    expect(got).toHaveLength(1)
    expect(Array.from(got[0]!)).toEqual(Array.from(big))
  })
})

describe('partie complète en Wi-Fi Direct simulé', () => {
  it('tourne à pleine cadence réseau, sans divergence', async () => {
    const { hostLinks, guests } = await star('770011', 2)

    const hostSession = new Session({
      sessionId: 'sess-nearby',
      selfId: 'hote',
      selfName: 'Hôte',
      isHub: true,
    })
    for (const link of hostLinks) hostSession.addPeer(link)

    const guestSessions = guests.map((guest, i) => {
      const session = new Session({
        sessionId: 'sess-nearby',
        selfId: `invite-${i}`,
        selfName: `Invité ${i}`,
        isHub: false,
      })
      session.addPeer(guest.link)
      return session
    })

    const sessions = [hostSession, ...guestSessions]
    for (let i = 0; i < 25; i++) {
      for (const session of sessions) session.pump(i * 50)
      await settle(5)
    }
    expect(sessions.every((s) => s.playerCount === 3)).toBe(true)

    const netcodes = sessions.map(
      (session) =>
        new Netcode({
          session,
          inputBytes: esquive.meta.inputBytes,
          tickRate: esquive.meta.tickRate,
        }),
    )
    // Le lien est large : le netcode monte à 30 Hz réseau, là où il tombe à 15
    // en Bluetooth. Le mini-jeu, lui, est rigoureusement le même.
    expect(netcodes[0]!.netRate).toBe(30)
    expect(netcodes[0]!.ticksPerSend).toBe(1)

    const runtimes: GameRuntime<EsquiveState>[] = sessions.map(
      (session, i) => new GameRuntime({ game: esquive, session, netcode: netcodes[i]!, seed: 0x77 }),
    )
    for (const netcode of netcodes) netcode.start(0)

    const traces = runtimes.map(() => new Map<number, number>())
    runtimes.forEach((runtime, i) => {
      runtime.on('simulated', ({ tick, state }) => traces[i]!.set(tick, esquive.hash(state)))
    })

    for (let step = 0; step < 60; step++) {
      const now = 2000 + step * 33
      netcodes.forEach((netcode, i) => netcode.submitInput(new Uint8Array([step + i * 9])))
      for (const session of sessions) session.pump(now)
      for (const netcode of netcodes) netcode.pump(now)
      await settle(2)
    }

    const common = [...traces[0]!.keys()].filter((tick) => traces.every((t) => t.has(tick)))
    expect(common.length, 'aucun tick commun aux trois joueurs').toBeGreaterThan(5)
    for (const tick of common) {
      expect(new Set(traces.map((t) => t.get(tick))).size, `divergence au tick ${tick}`).toBe(1)
    }

    for (const runtime of runtimes) runtime.dispose()
    for (const session of sessions) session.close()
  })
})
