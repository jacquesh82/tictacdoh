import { FrameKind, frame, u8 } from '@ttd/wire'
import { Channel, TransportError } from '@ttd/core'
import { describe, expect, it } from 'vitest'
import {
  BLE_PROFILE,
  LOSSY_PROFILE,
  SimNetwork,
  WIFI_PROFILE,
  simStar,
} from '../src/index.js'

describe('SimNetwork', () => {
  it('applique la latence du profil', () => {
    const net = new SimNetwork({ profile: { ...BLE_PROFILE, jitterMs: 0 } })
    const [a, b] = net.pair('a', 'b')
    const received: number[] = []
    b.on('message', () => void received.push(net.now()))

    a.send(new Uint8Array([1]))
    net.advance(20)
    expect(received).toHaveLength(0)

    net.advance(20)
    expect(received).toEqual([30])
  })

  it('rejoue exactement à graine égale', () => {
    // Sans cette propriété, un test réseau qui échoue une fois sur dix est
    // impossible à diagnostiquer.
    const run = () => {
      const net = new SimNetwork({ profile: LOSSY_PROFILE, seed: 1234 })
      const [a, b] = net.pair('a', 'b')
      const times: number[] = []
      b.on('message', () => void times.push(net.now()))
      for (let i = 0; i < 50; i++) {
        a.send(new Uint8Array([i]))
        net.advance(10)
      }
      net.advance(500)
      return times
    }
    expect(run()).toEqual(run())
  })

  it('préserve l’ordre malgré la gigue', () => {
    const net = new SimNetwork({ profile: LOSSY_PROFILE, seed: 7 })
    const [a, b] = net.pair('a', 'b')
    const order: number[] = []
    b.on('message', (m) => void order.push(m[0]!))

    for (let i = 0; i < 40; i++) {
      a.send(new Uint8Array([i]))
      net.advance(5)
    }
    net.advance(1000)

    // La gigue retarde, elle ne réordonne pas : aucun de nos transports réels
    // ne livre dans le désordre, et simuler l'inverse testerait un fantôme.
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('perd des messages sur un profil non fiable, et seulement là', () => {
    const lossy = new SimNetwork({ profile: LOSSY_PROFILE, seed: 3 })
    const [a] = lossy.pair('a', 'b')
    for (let i = 0; i < 200; i++) a.send(new Uint8Array([i]))
    lossy.advance(1000)
    expect(lossy.stats.lost).toBeGreaterThan(10)

    const ble = new SimNetwork({ profile: BLE_PROFILE })
    const [c] = ble.pair('c', 'd')
    for (let i = 0; i < 200; i++) c.send(new Uint8Array([i]))
    ble.advance(1000)
    expect(ble.stats.lost).toBe(0)
  })

  it('refuse un profil fiable qui prétend perdre des messages', () => {
    // Un lien fiable ne perd pas silencieusement : il se coupe. Mélanger les
    // deux modèles ferait passer des tests sur un comportement inexistant.
    expect(
      () => new SimNetwork({ profile: { ...BLE_PROFILE, lossRate: 0.1 } }),
    ).toThrow(TransportError)
  })

  it('fait respecter la MTU', () => {
    const net = new SimNetwork({ profile: BLE_PROFILE })
    const [a] = net.pair('a', 'b')
    expect(() => a.send(new Uint8Array(200))).toThrow(/MTU/)
  })

  it('coupe et rétablit la remise sans fermer le lien', () => {
    const net = new SimNetwork({ profile: { ...WIFI_PROFILE, jitterMs: 0 } })
    const [a, b] = net.pair('a', 'b')
    const received: number[] = []
    b.on('message', (m) => void received.push(m[0]!))

    net.cut('b')
    a.send(new Uint8Array([1]))
    net.advance(200)
    expect(received).toEqual([])
    // Le lien n'est pas fermé : l'application ne sait pas encore qu'elle est
    // hors de portée, exactement comme dans un tunnel.
    expect(b.closed).toBe(false)

    net.restore('b')
    a.send(new Uint8Array([2]))
    net.advance(200)
    expect(received).toEqual([2])
  })
})

describe('Channel sous contrainte BLE', () => {
  it('fragmente un keyframe et le réassemble intact', () => {
    const net = new SimNetwork({ profile: BLE_PROFILE })
    const [a, b] = net.pair('a', 'b')
    const sender = new Channel(a)
    const receiver = new Channel(b)
    net.register(sender, receiver)

    const received: Uint8Array[] = []
    receiver.on('message', (m) => void received.push(m))

    const keyframe = new Uint8Array(900)
    keyframe[0] = FrameKind.Keyframe
    for (let i = 1; i < keyframe.length; i++) keyframe[i] = (i * 7) % 251

    sender.send(keyframe, 'bulk')
    // 900 o à 1050 o/s de budget : il faut environ une seconde. Un keyframe
    // n'est pas gratuit sur BLE, et c'est utile de le voir.
    net.advance(3000)

    expect(received).toHaveLength(1)
    expect(Array.from(received[0]!)).toEqual(Array.from(keyframe))
  })

  it('ne dépasse jamais le débit annoncé du lien', () => {
    const net = new SimNetwork({ profile: BLE_PROFILE })
    const [a, b] = net.pair('a', 'b')
    const sender = new Channel(a)
    net.register(sender)
    void b

    for (let i = 0; i < 400; i++) sender.send(frame(FrameKind.Input, u8, i % 256))
    net.advance(1000)

    // 1500 o/s × 70 % d'utilisation, plus le seau initial. Sans ce lissage la
    // file du système sature et la latence ne redescend plus de la partie.
    expect(net.stats.bytes).toBeLessThanOrEqual(1500 * 2)
  })
})

describe('étoile simulée', () => {
  it('réunit quatre joueurs sous profil BLE', () => {
    const star = simStar({ sessionId: 'sim-1', playerCount: 4, profile: BLE_PROFILE })
    star.advance(2000)

    expect(star.hub.playerCount).toBe(4)
    for (const spoke of star.spokes) expect(spoke.playerCount).toBe(4)
    // Une seule autorité, malgré la latence et la gigue.
    expect(new Set(star.all.map((s) => s.host)).size).toBe(1)
  })

  it('achemine une diffusion de rayon à rayon via le hub', () => {
    const star = simStar({ sessionId: 'sim-2', playerCount: 4, profile: BLE_PROFILE })
    star.advance(2000)

    const seen: string[] = []
    for (const session of star.all) {
      session.on('frame', () => void seen.push(session.selfId))
    }
    star.spokes[0]!.broadcast(frame(FrameKind.TickBatch, u8, 9))
    star.advance(2000)

    expect(seen.sort()).toEqual(['p0', 'p2', 'p3'])
  })

  it('survit à la perte d’un joueur en cours de partie', () => {
    const star = simStar({ sessionId: 'sim-3', playerCount: 4, profile: BLE_PROFILE })
    star.advance(2000)

    star.links.get('p2')!.close('sorti de portée')
    star.advance(2000)

    expect(star.hub.playerCount).toBe(3)
    for (const spoke of star.spokes.filter((s) => s.selfId !== 'p2')) {
      expect(spoke.roster.map((p) => p.id)).not.toContain('p2')
    }
    expect(new Set(star.all.filter((s) => s.selfId !== 'p2').map((s) => s.host)).size).toBe(1)
  })

  it('accueille un joueur arrivé en cours de session', () => {
    const star = simStar({ sessionId: 'sim-4', playerCount: 2, profile: BLE_PROFILE })
    star.advance(2000)
    expect(star.hub.playerCount).toBe(2)

    const late = star.join('p2')
    star.advance(2000)

    expect(star.hub.playerCount).toBe(3)
    expect(late.roster.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p2'])
    expect(new Set(star.all.map((s) => s.host)).size).toBe(1)
  })

  it('mesure un aller-retour cohérent avec le profil', () => {
    const star = simStar({ sessionId: 'sim-5', playerCount: 2, profile: BLE_PROFILE })
    star.advance(6000)

    // Aller simple de 30 ms ± 15 : l'aller-retour doit tomber autour de 60 ms.
    const rtt = star.hub.worstRttMs()
    expect(rtt).toBeGreaterThan(20)
    expect(rtt).toBeLessThan(140)
  })
})
