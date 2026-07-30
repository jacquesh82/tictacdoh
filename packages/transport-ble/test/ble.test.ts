import { Netcode, Session, TransportError } from '@ttd/core'
import { GameRuntime } from '@ttd/game-sdk'
import { type EsquiveState, esquive } from '@ttd/game-esquive'
import { fingerprintBytes, generateCode } from '@ttd/join'
import { Rng } from '@ttd/core'
import { FrameKind, frame, u8 } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import {
  BleTransport,
  capsForMtu,
  encodeAdvertisedName,
  fromBase64,
  parseAdvertisedName,
  toBase64,
  toHex,
} from '../src/index.js'
import { FakeBlePlugin, FakeBleRadio } from './fake-plugin.js'

const SERVICE = '7ac0d0a1-0000-4000-8000-00805f9b34fb'
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function device(radio: FakeBleRadio, id: string, options: { mtu?: number; canAdvertise?: boolean } = {}) {
  const plugin = new FakeBlePlugin({ id, radio, ...options })
  return { plugin, transport: new BleTransport({ plugin, serviceUuid: SERVICE }) }
}

/** Étoile BLE : l'hôte s'annonce en périphérique, les autres s'y connectent. */
async function star(code: string, guestCount: number) {
  const radio = new FakeBleRadio()
  const host = device(radio, 'hote')
  const hostLinks: Awaited<ReturnType<BleTransport['connect']>>[] = []
  host.transport.onIncoming((link) => void hostLinks.push(link))
  await host.transport.advertise({
    sessionId: 'sess-ble',
    code,
    hostName: 'Salon',
    playerCount: 1,
    maxPlayers: 4,
  })

  const guests = []
  for (let i = 0; i < guestCount; i++) {
    const guest = device(radio, `invite${i}`)
    const found = await guest.transport.findByCode(code, 500)
    const link = await guest.transport.connect(found)
    guests.push({ ...guest, link, found })
  }
  await settle()
  return { radio, host, hostLinks, guests }
}

describe('base64 du pont natif', () => {
  it('fait l’aller-retour sur des longueurs quelconques', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31) % 256)
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('produit un base64 standard, remplissage compris', () => {
    // Le natif utilisera les fonctions de sa plateforme : le format doit être
    // rigoureusement standard, sinon les deux côtés du pont ne se comprennent
    // pas et le symptôme est un message corrompu, pas une erreur.
    expect(toBase64(new Uint8Array([0]))).toBe('AA==')
    expect(toBase64(new Uint8Array([0, 0]))).toBe('AAA=')
    expect(toBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
    expect(Array.from(fromBase64('TWFu'))).toEqual([77, 97, 110])
  })
})

describe('nom annoncé, convention commune aux deux plateformes', () => {
  it('fait l’aller-retour empreinte + nom lisible', () => {
    // Android peut publier des « service data », CoreBluetooth non : un hôte
    // iPhone n'a que le nom local pour porter l'empreinte. Les deux natifs
    // doivent donc suivre cette convention, sinon un Android ne verra jamais
    // un hôte iOS — le chemin même que le Bluetooth existe pour couvrir.
    const name = encodeAdvertisedName('a1b2c3', 'Le salon')
    expect(parseAdvertisedName(name)).toEqual({ fingerprintHex: 'a1b2c3', localName: 'Le salon' })
  })

  it('tolère un nom sans empreinte', () => {
    // Un appareil tiers qui annonce le même service ne suit pas la convention :
    // on ne doit pas le confondre avec un hôte du jeu.
    expect(parseAdvertisedName('imprimante')).toEqual({
      fingerprintHex: '',
      localName: 'imprimante',
    })
  })

  it('préserve un nom d’hôte contenant le séparateur', () => {
    const name = encodeAdvertisedName('a1b2c3', 'chez Paul | salon')
    expect(parseAdvertisedName(name).localName).toBe('chez Paul | salon')
  })
})

describe('MTU négociée', () => {
  it('déduit la charge utile de la MTU, en retirant l’en-tête ATT', () => {
    // Trois octets partent en en-tête de notification : les oublier ferait
    // rejeter silencieusement les trames les plus longues.
    expect(capsForMtu(185).maxPayloadBytes).toBe(182)
    expect(capsForMtu(517).maxPayloadBytes).toBe(514)
  })

  it('supporte une pile restée à la MTU par défaut', () => {
    // 23 octets, c'est le minimum du BLE avant négociation. Rare, mais un
    // appareil ancien peut ne jamais négocier mieux.
    expect(capsForMtu(23).maxPayloadBytes).toBe(20)
  })

  it('retient la plus petite MTU des deux piles', async () => {
    const radio = new FakeBleRadio()
    const host = device(radio, 'hote', { mtu: 517 })
    const guest = device(radio, 'invite', { mtu: 23 })
    await host.transport.advertise({
      sessionId: 's',
      code: '048213',
      hostName: 'H',
      playerCount: 1,
      maxPlayers: 4,
    })
    const found = await guest.transport.findByCode('048213', 500)
    const link = await guest.transport.connect(found)
    expect(link.caps.maxPayloadBytes).toBe(20)
  })
})

describe('annonce et découverte', () => {
  it('ne remonte que les hôtes portant le code saisi', async () => {
    const radio = new FakeBleRadio()
    const wanted = device(radio, 'cherche')
    const other = device(radio, 'autre')
    const seeker = device(radio, 'chercheur')

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
      hostName: 'Une autre',
      playerCount: 1,
      maxPlayers: 4,
    })

    // Sans ce filtre, le joueur devrait choisir dans une liste d'appareils
    // anonymes : une annonce BLE n'a pas la place de porter le code entier.
    const found = await seeker.transport.findByCode('048213', 500)
    expect(found.advert.hostName).toBe('La bonne')
    expect(found.address).toBe('cherche')
  })

  it('place bien l’empreinte du code dans l’annonce', async () => {
    const radio = new FakeBleRadio()
    const host = device(radio, 'hote')
    await host.transport.advertise({
      sessionId: 'a',
      code: '048213',
      hostName: 'H',
      playerCount: 1,
      maxPlayers: 4,
    })
    const [advert] = radio.visible({ serviceUuid: SERVICE })
    expect(advert!.options.fingerprintHex).toBe(toHex(fingerprintBytes('048213')))
    expect(advert!.options.fingerprintHex).toHaveLength(6)
  })

  it('abandonne proprement si personne ne porte ce code', async () => {
    const radio = new FakeBleRadio()
    const seeker = device(radio, 'chercheur')
    await expect(seeker.transport.findByCode('000000', 100)).rejects.toThrow(/à portée Bluetooth/)
  })

  it('refuse d’annoncer depuis un navigateur, avec la vraie raison', async () => {
    // Web Bluetooth est central uniquement. Le dire tôt évite un échec plus
    // loin dont personne ne comprendrait la cause.
    const radio = new FakeBleRadio()
    const browser = device(radio, 'navigateur', { canAdvertise: false })
    await expect(
      browser.transport.advertise({
        sessionId: 'a',
        code: '048213',
        hostName: 'H',
        playerCount: 1,
        maxPlayers: 4,
      }),
    ).rejects.toThrow(/central/)
  })

  it('refuse si le Bluetooth est éteint', async () => {
    const radio = new FakeBleRadio()
    const plugin = new FakeBlePlugin({ id: 'x', radio, available: false })
    const transport = new BleTransport({ plugin, serviceUuid: SERVICE })
    await expect(
      transport.advertise({
        sessionId: 'a',
        code: '048213',
        hostName: 'H',
        playerCount: 1,
        maxPlayers: 4,
      }),
    ).rejects.toThrow(TransportError)
  })
})

describe('acheminement', () => {
  it('relie trois invités à l’hôte et achemine dans les deux sens', async () => {
    const { hostLinks, guests } = await star('048213', 3)
    expect(hostLinks).toHaveLength(3)

    const received = new Map<number, number[]>()
    guests.forEach((guest, i) => {
      received.set(i, [])
      guest.link.on('message', (m) => void received.get(i)!.push(m[1]!))
    })
    const hostGot: number[] = []
    for (const link of hostLinks) link.on('message', (m) => void hostGot.push(m[1]!))

    hostLinks[1]!.send(frame(FrameKind.TickBatch, u8, 42))
    guests.forEach((guest, i) => guest.link.send(frame(FrameKind.Input, u8, 10 + i)))
    await settle()

    // Ciblé : seul le deuxième invité reçoit.
    expect(received.get(0)).toEqual([])
    expect(received.get(1)).toEqual([42])
    expect(received.get(2)).toEqual([])
    expect(hostGot.sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  it('refuse une trame plus longue que la MTU négociée', async () => {
    const { guests } = await star('048213', 1)
    const link = guests[0]!.link
    // Une pile réelle tronquerait ou rejetterait en silence : mieux vaut lever
    // ici, où la pile d'appels désigne le coupable.
    expect(() => link.send(new Uint8Array(link.caps.maxPayloadBytes + 1))).toThrow(/MTU négociée/)
  })

  it('prévient les deux bouts à la déconnexion', async () => {
    const { hostLinks, guests } = await star('048213', 2)
    const closed: string[] = []
    hostLinks.forEach((link, i) => link.on('close', () => void closed.push(`hote-${i}`)))
    guests[0]!.link.on('close', () => void closed.push('invite-0'))

    guests[0]!.link.close('parti')
    await settle()

    expect(closed).toContain('invite-0')
    expect(closed.some((c) => c.startsWith('hote-'))).toBe(true)
  })
})

describe('partie complète en Bluetooth simulé', () => {
  it('fait tourner Esquive à trois joueurs sans divergence', async () => {
    const code = generateCode(new Rng(7))
    const { hostLinks, guests } = await star(code, 2)

    const hostSession = new Session({
      sessionId: 'sess-ble',
      selfId: 'slot-0',
      selfName: 'Hôte',
      isHub: true,
    })
    hostLinks.forEach((link, i) => hostSession.addPeer(link, `Invité ${i}`))

    const guestSessions = guests.map((guest, i) => {
      const session = new Session({
        sessionId: 'sess-ble',
        selfId: `slot-${i + 1}`,
        selfName: `Invité ${i}`,
        isHub: false,
      })
      session.addPeer(guest.link, 'Hôte')
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
    const runtimes: GameRuntime<EsquiveState>[] = sessions.map(
      (session, i) => new GameRuntime({ game: esquive, session, netcode: netcodes[i]!, seed: 0xb1e }),
    )
    // La cadence réseau doit tomber à 15 Hz : c'est le lien le plus contraint
    // du socle, et le netcode le déduit tout seul des capacités annoncées.
    expect(netcodes[0]!.netRate).toBe(15)
    expect(netcodes[0]!.ticksPerSend).toBe(2)

    for (const netcode of netcodes) netcode.start(0)

    const traces = runtimes.map(() => new Map<number, number>())
    runtimes.forEach((runtime, i) => {
      runtime.on('simulated', ({ tick, state }) => traces[i]!.set(tick, esquive.hash(state)))
    })

    for (let step = 0; step < 60; step++) {
      const now = 2000 + step * 33
      // Un input distinct par joueur : avec la même valeur pour tous, une
      // confusion de sièges resterait invisible.
      netcodes.forEach((netcode, i) => netcode.submitInput(new Uint8Array([step + i * 7])))
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
