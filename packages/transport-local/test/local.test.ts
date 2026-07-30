import { FrameKind, frame, u8 } from '@ttd/wire'
import { Session } from '@ttd/core'
import { describe, expect, it } from 'vitest'
import { LOCAL_CAPS, LocalTransport } from '../src/index.js'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('LocalTransport', () => {
  it('n’annonce ni découverte ni advertising', async () => {
    const transport = new LocalTransport()
    expect(transport.caps.canAdvertise).toBe(false)
    expect(transport.caps.canDiscover).toBe(false)
    expect(transport.caps.requiresInternet).toBe(false)

    await expect(transport.advertise({} as never)).rejects.toThrow(/ne se découvre pas/)
    const found = []
    for await (const session of transport.discover()) found.push(session)
    expect(found).toHaveLength(0)
  })

  it('garde une MTU finie pour que la fragmentation reste exercée', () => {
    // Une MTU infinie en local laisserait un mini-jeu grossir sans qu'on le
    // voie, et l'ennui n'apparaîtrait qu'en phase 9 sur un vrai lien BLE.
    expect(Number.isFinite(LOCAL_CAPS.maxPayloadBytes)).toBe(true)
    expect(LOCAL_CAPS.maxPayloadBytes).toBeLessThan(64 * 1024)
  })

  it('réunit quatre joueurs sur un seul appareil', async () => {
    const transport = new LocalTransport('host')
    const host = new Session({
      sessionId: 'local-1',
      selfId: 'host',
      selfName: 'Hôte',
      isHub: true,
      now: () => 0,
    })
    transport.onIncoming((link) => host.addPeer(link, link.peerId))

    const guests = ['j2', 'j3', 'j4'].map((id) => {
      const link = transport.seat(id)
      const session = new Session({
        sessionId: 'local-1',
        selfId: id,
        selfName: id,
        isHub: false,
        now: () => 0,
      })
      session.addPeer(link, 'host')
      return session
    })

    for (let step = 0; step < 6; step++) {
      for (const session of [host, ...guests]) session.pump(step * 100)
      await settle()
    }

    expect(host.playerCount).toBe(4)
    // Le point du transport local : du point de vue du jeu, rien ne le
    // distingue d'une partie en réseau.
    for (const guest of guests) expect(guest.playerCount).toBe(4)
    expect(new Set([host, ...guests].map((s) => s.host)).size).toBe(1)
  })

  it('fait circuler une trame entre deux joueurs locaux', async () => {
    const transport = new LocalTransport('host')
    const host = new Session({
      sessionId: 'local-2',
      selfId: 'host',
      selfName: 'Hôte',
      isHub: true,
      now: () => 0,
    })
    transport.onIncoming((link) => host.addPeer(link, link.peerId))

    const link = transport.seat('j2')
    const guest = new Session({
      sessionId: 'local-2',
      selfId: 'j2',
      selfName: 'j2',
      isHub: false,
      now: () => 0,
    })
    guest.addPeer(link, 'host')

    const received: number[] = []
    guest.on('frame', ({ payload }) => void received.push(payload[1]!))

    host.broadcast(frame(FrameKind.TickBatch, u8, 3))
    for (let step = 0; step < 4; step++) {
      host.pump(step * 100)
      guest.pump(step * 100)
      await settle()
    }

    expect(received).toEqual([3])
  })

  it('refuse deux fois le même siège', () => {
    const transport = new LocalTransport()
    transport.seat('j2')
    expect(() => transport.seat('j2')).toThrow(/déjà pris/)
  })
})
