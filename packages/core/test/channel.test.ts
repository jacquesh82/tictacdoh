import { FrameKind, frame, u8 } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import { Channel, MemoryLink, type TransportCaps } from '../src/index.js'

const bleCaps: TransportCaps = {
  kind: 'ble',
  maxPayloadBytes: 180,
  throughputBytesPerSec: 1500,
  rttHintMs: 60,
  maxPeers: 4,
  canAdvertise: true,
  canDiscover: true,
  reliable: true,
  ordered: true,
  requiresInternet: false,
}

/** Attend que les remises différées par microtâche soient traitées. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function connected(caps: TransportCaps = bleCaps): [Channel, Channel] {
  const [a, b] = MemoryLink.pair('a', 'b', caps)
  return [new Channel(a), new Channel(b)]
}

describe('Channel', () => {
  it('transmet un petit message sans surcoût', async () => {
    const [sender, receiver] = connected()
    const received: Uint8Array[] = []
    receiver.on('message', (m) => void received.push(m))

    const payload = frame(FrameKind.Input, u8, 42)
    sender.send(payload)
    sender.pump(0)
    await settle()

    expect(received).toHaveLength(1)
    // Aucun octet d'enveloppe ajouté : c'est ce qui préserve le budget BLE.
    expect(received[0]).toHaveLength(payload.length)
    expect(Array.from(received[0]!)).toEqual(Array.from(payload))
  })

  it('fragmente et réassemble un message plus grand que la MTU', async () => {
    const [sender, receiver] = connected()
    const received: Uint8Array[] = []
    receiver.on('message', (m) => void received.push(m))

    // Un keyframe réaliste : bien au-delà des 180 octets d'un lien BLE.
    const big = new Uint8Array(1000)
    big[0] = FrameKind.Keyframe
    for (let i = 1; i < big.length; i++) big[i] = i % 251

    sender.send(big, 'bulk')
    // Budget large pour que tous les fragments partent d'un coup.
    sender.pump(0)
    sender.pump(10_000)
    await settle()

    expect(received).toHaveLength(1)
    expect(Array.from(received[0]!)).toEqual(Array.from(big))
  })

  it('respecte le budget du lien plutôt que d’envoyer en rafale', () => {
    const [sender] = connected()
    // 1500 o/s à 70 % = 1050 o/s de budget.
    for (let i = 0; i < 50; i++) sender.send(frame(FrameKind.Input, u8, i))

    // Le seau démarre plein : la première salve peut consommer 1050 octets.
    const firstBurst = sender.pump(0)
    expect(firstBurst).toBeLessThanOrEqual(1050)

    // Sans temps écoulé, plus rien ne doit sortir.
    expect(sender.pump(0)).toBe(0)

    // Une demi-seconde plus tard, ~525 octets de plus sont autorisés.
    expect(sender.pump(500)).toBeLessThanOrEqual(525)
  })

  it('sacrifie les inputs les plus anciens quand la file temps réel déborde', () => {
    const [sender] = connected()
    const dropped: number[] = []
    sender.on('dropped', ({ bytes }) => void dropped.push(bytes))

    for (let i = 0; i < 20; i++) sender.send(frame(FrameKind.Input, u8, i))

    // Profondeur par défaut de 8 : les 12 premiers sont sacrifiés.
    expect(dropped).toHaveLength(12)
    expect(sender.queued).toBe(8)
  })

  it('ne sacrifie jamais un message volumineux', () => {
    const [sender] = connected()
    const dropped: number[] = []
    sender.on('dropped', () => void dropped.push(1))

    for (let i = 0; i < 20; i++) sender.send(frame(FrameKind.Keyframe, u8, i), 'bulk')

    // Un keyframe jeté laisserait un pair désynchronisé sans recours.
    expect(dropped).toHaveLength(0)
    expect(sender.queued).toBe(20)
  })

  it('fait passer le temps réel avant le volumineux', async () => {
    const [sender, receiver] = connected()
    const order: number[] = []
    receiver.on('message', (m) => void order.push(m[0]! & 0x1f))

    sender.send(frame(FrameKind.Keyframe, u8, 1), 'bulk')
    sender.send(frame(FrameKind.Input, u8, 2), 'realtime')
    sender.pump(0)
    await settle()

    // L'input part en premier bien qu'il ait été mis en file en second : un
    // keyframe en attente ne doit pas retarder le tick courant.
    expect(order).toEqual([FrameKind.Input, FrameKind.Keyframe])
  })

  it('refuse de fragmenter sur un lien non fiable', () => {
    const unreliable: TransportCaps = { ...bleCaps, reliable: false }
    const [sender] = connected(unreliable)
    sender.send(new Uint8Array(500).fill(FrameKind.Keyframe), 'bulk')
    // Réassembler sans garantie de livraison produirait des états corrompus
    // silencieusement. Mieux vaut échouer bruyamment.
    expect(() => sender.pump(0)).toThrow(/non fiable/)
  })

  it('ignore un fragment isolé sans fuir de mémoire', async () => {
    const [a, b] = MemoryLink.pair('a', 'b', bleCaps)
    const receiver = new Channel(b)
    const received: Uint8Array[] = []
    receiver.on('message', (m) => void received.push(m))

    // Fragment 0 sur 2 annoncés : le second n'arrivera jamais.
    a.send(new Uint8Array([FrameKind.Keyframe | 0x20, 0, 0, 2, 9, 9, 9]))
    await settle()

    expect(received).toHaveLength(0)
  })
})
