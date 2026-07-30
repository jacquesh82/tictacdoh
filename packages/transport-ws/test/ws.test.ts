import { FrameKind, frame, u8 } from '@ttd/wire'
import { Netcode, Session } from '@ttd/core'
import { GameRuntime } from '@ttd/game-sdk'
import { type EsquiveState, esquive } from '@ttd/game-esquive'
import { RelayServer, networkKey } from '@ttd/relay'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WS_CAPS, WsTransport } from '../src/index.js'

let relay: RelayServer
let url: string

beforeEach(async () => {
  relay = new RelayServer({ maxFailedJoins: 3, rateWindowMs: 60_000 })
  const port = await relay.listen(0)
  url = `ws://127.0.0.1:${port}`
})

afterEach(async () => {
  await relay.close()
})

const settle = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Hôte plus `guestCount` invités, reliés par le relay. */
async function room(code: string, guestCount: number) {
  const host = new WsTransport({ url, selfName: 'Hôte' })
  const hostLinks: Array<{ link: Awaited<ReturnType<WsTransport['joinByCode']>>['link']; id: string }> = []
  host.onIncoming((link) => void hostLinks.push({ link, id: link.peerId }))
  await host.advertise({
    sessionId: 'sess-ws',
    code,
    hostName: 'Hôte',
    roomName: 'Le salon',
    playerCount: 1,
    maxPlayers: 4,
  })

  const guests: WsTransport[] = []
  const joins = []
  for (let i = 0; i < guestCount; i++) {
    const guest = new WsTransport({ url, selfName: `Invité ${i + 1}` })
    guests.push(guest)
    joins.push(await guest.joinByCode(code))
  }
  await settle()
  return { host, hostLinks, guests, joins }
}

describe('salle et code court', () => {
  it('ouvre une salle et laisse rejoindre par le code', async () => {
    const { hostLinks, joins } = await room('048213', 2)
    expect(relay.roomCount).toBe(1)
    expect(hostLinks).toHaveLength(2)
    expect(joins[0]!.hostName).toBe('Hôte')
    expect(joins[0]!.sessionId).toBe('sess-ws')
    // Les places sont distinctes : c'est ce qui permet à l'hôte de savoir qui
    // lui parle sur une connexion partagée.
    expect(joins[0]!.slot).not.toBe(joins[1]!.slot)
  })

  it('liste les salles du même réseau, avec leur nom', async () => {
    await room('048213', 1)
    const curious = new WsTransport({ url, selfName: 'Curieux' })
    const rooms = await curious.listRooms(1000)

    expect(rooms).toHaveLength(1)
    // Le nom de la salle est distinct de celui de l'hôte : c'est ce qu'on lit
    // dans une liste, et « Le salon » se repère mieux qu'un prénom quand
    // plusieurs parties tournent dans la même pièce.
    expect(rooms[0]!.roomName).toBe('Le salon')
    expect(rooms[0]!.hostName).toBe('Hôte')
    expect(rooms[0]!.playerCount).toBe(2)
    expect(rooms[0]!.code).toBe('048213')
    await curious.close()
  })

  it('donne un nom par défaut à une salle anonyme', async () => {
    const host = new WsTransport({ url, selfName: 'Ada' })
    await host.advertise({
      sessionId: 's',
      code: '111111',
      hostName: 'Ada',
      playerCount: 1,
      maxPlayers: 4,
    })
    const curious = new WsTransport({ url, selfName: 'Curieux' })
    const rooms = await curious.listRooms(1000)
    expect(rooms[0]!.roomName).toBe('Partie de Ada')
    await host.close()
    await curious.close()
  })

  it('expose la découverte par le flux standard', async () => {
    await room('048213', 0)
    const curious = new WsTransport({ url, selfName: 'Curieux' })
    expect(WS_CAPS.canDiscover).toBe(true)
    const found = []
    for await (const session of curious.discover()) found.push(session)
    expect(found).toHaveLength(1)
    expect(found[0]!.advert.roomName).toBe('Le salon')
    await curious.close()
  })

  it('ne remonte aucune salle quand il n’y en a pas', async () => {
    const curious = new WsTransport({ url, selfName: 'Curieux' })
    expect(await curious.listRooms(1000)).toEqual([])
    await curious.close()
  })

  it('refuse un code inconnu', async () => {
    const guest = new WsTransport({ url, selfName: 'Perdu' })
    await expect(guest.joinByCode('999999')).rejects.toThrow(/aucune partie/)
    await guest.close()
  })

  it('refuse deux salles sous le même code', async () => {
    await room('048213', 0)
    const other = new WsTransport({ url, selfName: 'Doublon' })
    await expect(
      other.advertise({
        sessionId: 'autre',
        code: '048213',
        hostName: 'Doublon',
        playerCount: 1,
        maxPlayers: 4,
      }),
    ).rejects.toThrow(/déjà utilisé/)
    await other.close()
  })

  it('refuse un cinquième joueur', async () => {
    await room('048213', 3)
    const extra = new WsTransport({ url, selfName: 'Cinquième' })
    await expect(extra.joinByCode('048213')).rejects.toThrow(/complète/)
    await extra.close()
  })
})

describe('fermeture de salle', () => {
  it('retire la salle de la liste et congédie les invités', async () => {
    const { host, joins } = await room('048213', 2)
    const closed: string[] = []
    for (const join of joins) join.link.on('close', () => void closed.push('invité'))

    await host.closeRoom()
    await settle(150)

    expect(relay.roomCount).toBe(0)
    // Prévenir plutôt que laisser tomber : sans cela, l'écran des invités
    // resterait figé sur une salle qui n'existe plus.
    expect(closed).toHaveLength(2)

    const curious = new WsTransport({ url, selfName: 'Curieux' })
    expect(await curious.listRooms(1000)).toEqual([])
    await curious.close()
  })

  it('libère le code aussitôt, sans attendre l’expiration', async () => {
    const { host } = await room('048213', 0)
    await host.closeRoom()
    await settle(120)

    // Rouvrir sous le même code doit être immédiatement possible.
    const encore = new WsTransport({ url, selfName: 'Encore' })
    await encore.advertise({
      sessionId: 's2',
      code: '048213',
      hostName: 'Encore',
      roomName: 'La suite',
      playerCount: 1,
      maxPlayers: 4,
    })
    expect(relay.roomCount).toBe(1)
    await encore.close()
  })

  it('refuse qu’un invité ferme la salle', async () => {
    // Sinon n'importe qui pourrait mettre fin à la partie des autres.
    const { guests, joins } = await room('048213', 2)
    const closed: string[] = []
    joins[1]!.link.on('close', () => void closed.push('autre invité'))

    await guests[0]!.closeRoom()
    await settle(150)

    expect(relay.roomCount).toBe(1)
    expect(closed, 'les autres joueurs ne doivent pas être déconnectés').toHaveLength(0)
  })
})

describe('périmètre de la découverte', () => {
  it('regroupe un réseau domestique, sépare deux réseaux distincts', () => {
    // Deux appareils d'un même Wi-Fi ont des adresses voisines mais distinctes :
    // grouper à l'adresse exacte ne rapprocherait personne. Sur une adresse
    // publique en revanche, l'adresse entière fait foi — c'est la sortie NAT.
    expect(networkKey('192.168.1.152')).toBe(networkKey('192.168.1.188'))
    expect(networkKey('192.168.1.152')).not.toBe(networkKey('192.168.2.10'))
    expect(networkKey('10.0.0.5')).toBe(networkKey('10.0.0.99'))
    expect(networkKey('172.16.4.1')).toBe(networkKey('172.16.4.250'))
  })

  it('ne regroupe jamais deux adresses publiques distinctes', () => {
    // Sinon deux inconnus derrière des IP voisines verraient leurs parties
    // respectives, ce qui est précisément ce qu'on veut éviter.
    expect(networkKey('81.2.3.4')).not.toBe(networkKey('81.2.3.5'))
  })

  it('traite les adresses IPv4 encapsulées en IPv6', () => {
    // Node remonte souvent « ::ffff:192.168.1.1 » : ne pas le normaliser
    // mettrait chaque appareil dans son propre réseau.
    expect(networkKey('::ffff:192.168.1.10')).toBe(networkKey('192.168.1.20'))
  })
})

describe('limitation des tentatives', () => {
  it('bloque après trop d’essais infructueux', async () => {
    // Six chiffres ne font qu'un million de possibilités : sans comptage des
    // échecs, un code se force en quelques minutes et le « secret » n'en est
    // plus un.
    for (let i = 0; i < 3; i++) {
      const guest = new WsTransport({ url, selfName: 'Essai' })
      await expect(guest.joinByCode(String(100000 + i))).rejects.toThrow(/aucune partie/)
      await guest.close()
    }
    const blocked = new WsTransport({ url, selfName: 'Bloqué' })
    await expect(blocked.joinByCode('123456')).rejects.toThrow(/trop de tentatives/)
    await blocked.close()
  })

  it('ne pénalise pas une connexion à un code valide', async () => {
    await room('048213', 0)
    for (let i = 0; i < 5; i++) {
      const guest = new WsTransport({ url, selfName: `Invité ${i}` })
      const joined = await guest.joinByCode('048213')
      expect(joined.hostName).toBe('Hôte')
      await guest.close()
      await settle(30)
    }
  })
})

describe('acheminement des trames', () => {
  it('achemine dans les deux sens sans altérer les octets', async () => {
    const { hostLinks, joins } = await room('048213', 2)

    const received = new Map<string, number[]>()
    for (const [index, join] of joins.entries()) {
      received.set(`invité${index}`, [])
      join.link.on('message', (m) => void received.get(`invité${index}`)!.push(m[1]!))
    }
    const hostGot: number[] = []
    for (const entry of hostLinks) entry.link.on('message', (m) => void hostGot.push(m[1]!))

    // Hôte vers un invité précis, puis chaque invité vers l'hôte.
    hostLinks[0]!.link.send(frame(FrameKind.TickBatch, u8, 11))
    joins[0]!.link.send(frame(FrameKind.Input, u8, 21))
    joins[1]!.link.send(frame(FrameKind.Input, u8, 22))
    await settle()

    // Ciblé : seul le premier invité reçoit.
    expect(received.get('invité0')).toEqual([11])
    expect(received.get('invité1')).toEqual([])
    expect(hostGot.sort()).toEqual([21, 22])
  })

  it('transporte une charge utile volumineuse intacte', async () => {
    const { hostLinks, joins } = await room('048213', 1)
    const got: Uint8Array[] = []
    joins[0]!.link.on('message', (m) => void got.push(m))

    const big = new Uint8Array(8000)
    big[0] = FrameKind.Keyframe
    for (let i = 1; i < big.length; i++) big[i] = (i * 13) % 251
    hostLinks[0]!.link.send(big)
    await settle(150)

    expect(got).toHaveLength(1)
    expect(Array.from(got[0]!)).toEqual(Array.from(big))
  })

  it('prévient l’hôte du départ d’un invité', async () => {
    const { hostLinks, guests } = await room('048213', 2)
    const closed: string[] = []
    for (const entry of hostLinks) entry.link.on('close', () => void closed.push(entry.id))

    await guests[0]!.close()
    await settle(120)
    expect(closed).toHaveLength(1)
  })

  it('ferme la salle quand l’hôte s’en va', async () => {
    const { host, joins } = await room('048213', 2)
    const closed: string[] = []
    for (const join of joins) join.link.on('close', () => void closed.push('invité'))

    await host.close()
    await settle(150)

    // Sans centre, les invités ne peuvent plus se joindre : mieux vaut fermer
    // franchement que de les laisser dans une partie qui n'existe plus.
    expect(closed).toHaveLength(2)
    expect(relay.roomCount).toBe(0)
  })
})

describe('partie complète par le relay', () => {
  it('fait tourner Esquive à trois joueurs de bout en bout', async () => {
    const { hostLinks, joins } = await room('048213', 2)

    // L'identifiant de session est celui que le transport attribue : sans
    // cela, le roster publié par l'hôte ne contient pas l'invité, qui se
    // retirerait lui-même en l'appliquant.
    const hostSession = new Session({
      sessionId: 'sess-ws',
      selfId: 'slot-0',
      selfName: 'Hôte',
      isHub: true,
    })
    for (const entry of hostLinks) hostSession.addPeer(entry.link, entry.id)

    const guestSessions = joins.map((join, i) => {
      const session = new Session({
        sessionId: 'sess-ws',
        selfId: `slot-${join.slot}`,
        selfName: `Invité ${i}`,
        isHub: false,
      })
      session.addPeer(join.link, 'Hôte')
      return session
    })

    const sessions = [hostSession, ...guestSessions]
    for (let i = 0; i < 20; i++) {
      for (const session of sessions) session.pump(i * 50)
      await settle(20)
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
      (session, i) =>
        new GameRuntime({ game: esquive, session, netcode: netcodes[i]!, seed: 0xabc }),
    )
    for (const netcode of netcodes) netcode.start(0)

    const traces = runtimes.map(() => new Map<number, number>())
    runtimes.forEach((runtime, i) => {
      runtime.on('simulated', ({ tick, state }) => traces[i]!.set(tick, esquive.hash(state)))
    })

    for (let step = 0; step < 60; step++) {
      const now = 1000 + step * 33
      // Un input distinct par joueur : avec la même valeur pour tous, une
      // confusion de sièges resterait invisible dans les empreintes.
      netcodes.forEach((netcode, i) => netcode.submitInput(new Uint8Array([step + i * 5])))
      for (const session of sessions) session.pump(now)
      for (const netcode of netcodes) netcode.pump(now)
      await settle(5)
    }
    await settle(200)
    for (const session of sessions) session.pump(5000)

    const common = [...traces[0]!.keys()].filter((tick) => traces.every((t) => t.has(tick)))
    expect(common.length, 'aucun tick commun aux trois joueurs').toBeGreaterThan(5)

    // Le vrai réseau, avec sa latence propre : mêmes inputs, même ordre, donc
    // même état chez tout le monde.
    for (const tick of common) {
      const hashes = new Set(traces.map((t) => t.get(tick)))
      expect(hashes.size, `divergence au tick ${tick}`).toBe(1)
    }

    for (const runtime of runtimes) runtime.dispose()
    for (const session of sessions) session.close()
  })
})
