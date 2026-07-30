import { FrameKind, frame, u8 } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import { MemoryLink, Session, type TransportCaps } from '../src/index.js'

const caps: TransportCaps = {
  kind: 'sim',
  maxPayloadBytes: 512,
  throughputBytesPerSec: 1_000_000,
  rttHintMs: 20,
  maxPeers: 4,
  canAdvertise: true,
  canDiscover: true,
  reliable: true,
  ordered: true,
  requiresInternet: false,
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Star {
  hub: Session
  spokes: Session[]
  all: Session[]
  links: Map<string, MemoryLink>
  /** Fait circuler les messages jusqu'à ce que le réseau soit au repos. */
  settleAll: () => Promise<void>
}

/**
 * Étoile de `count` joueurs, comme en BLE ou en Nearby : le hub voit tout le
 * monde, chaque rayon ne voit que le hub.
 */
function star(sessionId: string, count: number, order?: string[]): Star {
  const hub = new Session({ sessionId, selfId: 'p0', selfName: 'p0', isHub: true, now: () => 0 })
  const spokes: Session[] = []
  const links = new Map<string, MemoryLink>()
  const ids = order ?? Array.from({ length: count - 1 }, (_, i) => `p${i + 1}`)

  for (const id of ids) {
    const spoke = new Session({ sessionId, selfId: id, selfName: id, isHub: false, now: () => 0 })
    const [hubSide, spokeSide] = MemoryLink.pair('p0', id, caps)
    links.set(id, hubSide)
    hub.addPeer(hubSide, id)
    spoke.addPeer(spokeSide, 'p0')
    spokes.push(spoke)
  }

  const all = [hub, ...spokes]
  const settleAll = async () => {
    for (let step = 0; step < 6; step++) {
      for (const session of all) session.pump(step * 100)
      await settle()
    }
  }
  return { hub, spokes, all, links, settleAll }
}

describe('roster', () => {
  it('propage la composition de la partie aux rayons', async () => {
    const { spokes, settleAll } = star('s1', 4)
    await settleAll()

    // Un rayon n'a qu'un seul lien mais joue à quatre : c'est précisément la
    // distinction entre « liens ouverts » et « joueurs de la partie ».
    for (const spoke of spokes) {
      expect(spoke.playerCount).toBe(4)
      expect(spoke.roster.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3'])
    }
  })

  it('attribue le siège libre le plus bas', async () => {
    const { hub, settleAll } = star('s1', 4)
    await settleAll()
    expect(hub.selfSeat).toBe(0)
    expect(hub.peers.map((p) => p.seat).sort()).toEqual([1, 2, 3])
  })

  it('refuse un cinquième joueur', () => {
    const { hub } = star('s1', 4)
    const [extra] = MemoryLink.pair('p0', 'p4', caps)
    expect(() => hub.addPeer(extra, 'p4')).toThrow(/pleine/)
  })

  it('libère le siège et prévient les rayons au départ d’un joueur', async () => {
    const { hub, spokes, links, settleAll } = star('s1', 4)
    await settleAll()

    const departures: string[] = []
    spokes[0]!.on('peer-left', ({ peer }) => void departures.push(peer.id))

    links.get('p2')!.close('parti')
    await settleAll()

    expect(hub.playerCount).toBe(3)
    expect(departures).toEqual(['p2'])
    expect(spokes[0]!.roster.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p3'])
  })
})

describe('rotation de l’hôte', () => {
  it('désigne une seule autorité dès que le roster est connu', async () => {
    // Régression : chaque pair s'auto-désignait hôte au démarrage et rien ne
    // le corrigeait, puisque tout le monde figure dans l'ordre. Quatre
    // autorités simultanées, donc quatre séquencements concurrents.
    const { all, settleAll } = star('accord', 4)
    await settleAll()

    const hosts = new Set(all.map((session) => session.host))
    expect(hosts.size).toBe(1)
    expect(all.filter((session) => session.isHost)).toHaveLength(1)
  })

  it('reste d’accord après un nombre quelconque de manches', async () => {
    const { all, settleAll } = star('accord', 4)
    await settleAll()

    for (let round = 0; round < 9; round++) {
      for (const session of all) session.rotateHost()
      expect(new Set(all.map((s) => s.host)).size).toBe(1)
    }
  })

  it('donne le même ordre à tous les pairs sans se le transmettre', async () => {
    const { all, settleAll } = star('session-abc', 4)
    await settleAll()

    const sequences = all.map((session) => {
      const seen = [session.host]
      for (let i = 0; i < 3; i++) seen.push(session.rotateHost())
      return seen
    })
    // L'ordre se déduit de l'identifiant de session et du roster : aucun
    // message n'est nécessaire pour que les quatre pairs soient d'accord.
    expect(sequences[1]).toEqual(sequences[0])
    expect(sequences[2]).toEqual(sequences[0])
    expect(sequences[3]).toEqual(sequences[0])
  })

  it('fait passer l’autorité par chacun sur un cycle complet', async () => {
    const { hub, settleAll } = star('session-abc', 4)
    await settleAll()

    const visited = new Set([hub.host])
    for (let i = 0; i < 3; i++) visited.add(hub.rotateHost())
    // C'est l'exigence d'équité : personne ne garde l'avantage de latence.
    expect(visited.size).toBe(4)
  })

  it('revient à l’hôte de départ après un tour complet', async () => {
    const { hub, settleAll } = star('session-abc', 4)
    await settleAll()

    const first = hub.host
    for (let i = 0; i < 4; i++) hub.rotateHost()
    expect(hub.host).toBe(first)
  })

  it('ne dépend pas de l’ordre d’arrivée des joueurs', async () => {
    // Sinon l'hôte initial resterait systématiquement premier dans l'ordre et
    // la rotation ne corrigerait rien.
    const a = star('meme-session', 4, ['p1', 'p2', 'p3'])
    const b = star('meme-session', 4, ['p3', 'p1', 'p2'])
    await a.settleAll()
    await b.settleAll()
    expect(b.hub.hostOrder).toEqual(a.hub.hostOrder)
  })

  it('promeut le suivant quand l’hôte disparaît en cours de partie', async () => {
    const { hub, links, settleAll } = star('session-abc', 4)
    await settleAll()

    // On amène l'autorité sur un pair distant, puis on coupe son lien.
    while (hub.isHost) hub.rotateHost()
    const lostHost = hub.host
    expect(lostHost).not.toBe(hub.selfId)

    const changes: string[] = []
    hub.on('host-changed', ({ host }) => void changes.push(host))
    links.get(lostHost)!.close('perdu')
    await settleAll()

    expect(hub.host).not.toBe(lostHost)
    expect(changes).toHaveLength(1)
    // Le survivant promu fait toujours partie de la partie.
    expect(hub.roster.map((p) => p.id)).toContain(hub.host)
  })
})

describe('routage par le hub', () => {
  it('achemine une diffusion d’un rayon vers tous les autres', async () => {
    const { hub, spokes, settleAll } = star('s2', 4)
    await settleAll()

    const seen = new Map<string, number[]>()
    for (const session of [hub, ...spokes]) {
      seen.set(session.selfId, [])
      session.on('frame', ({ payload }) => void seen.get(session.selfId)!.push(payload[1]!))
    }

    // p1 n'a qu'un lien, celui du hub, et pourtant p2 et p3 doivent recevoir.
    // C'est ce que la séparation hub/hôte rend possible.
    spokes[0]!.broadcast(frame(FrameKind.TickBatch, u8, 77))
    await settleAll()

    expect(seen.get('p0')).toEqual([77])
    expect(seen.get('p2')).toEqual([77])
    expect(seen.get('p3')).toEqual([77])
    expect(seen.get('p1')).toEqual([])
  })

  it('achemine un envoi ciblé vers le bon joueur seulement', async () => {
    const { hub, spokes, settleAll } = star('s3', 4)
    await settleAll()

    const received: string[] = []
    for (const session of [hub, ...spokes]) {
      session.on('frame', () => void received.push(session.selfId))
    }

    spokes[0]!.sendTo('p2', frame(FrameKind.Input, u8, 5))
    await settleAll()

    expect(received).toEqual(['p2'])
  })

  it('permet à un hôte non-hub de diffuser à toute la partie', async () => {
    const { hub, spokes, settleAll } = star('s5', 4)
    await settleAll()

    // Cas central de la conception : l'autorité a tourné vers un rayon.
    const authority = spokes.find((s) => s.selfId !== hub.selfId)!
    while (authority.host !== authority.selfId) {
      for (const session of [hub, ...spokes]) session.rotateHost()
    }
    expect(authority.isHost).toBe(true)
    expect(authority.isHub).toBe(false)

    const seen: string[] = []
    for (const session of [hub, ...spokes]) {
      session.on('frame', () => void seen.push(session.selfId))
    }
    authority.broadcast(frame(FrameKind.TickBatch, u8, 1))
    await settleAll()

    expect(seen.sort()).toEqual(['p0', 'p2', 'p3'])
  })
})

describe('mesure d’aller-retour', () => {
  it('mesure le RTT et alimente le pire cas', async () => {
    let clock = 0
    const hub = new Session({
      sessionId: 's4',
      selfId: 'p0',
      selfName: 'p0',
      isHub: true,
      now: () => clock,
      pingIntervalMs: 100,
    })
    const spoke = new Session({
      sessionId: 's4',
      selfId: 'p1',
      selfName: 'p1',
      isHub: false,
      now: () => clock,
      pingIntervalMs: 1_000_000,
    })
    const [hubSide, spokeSide] = MemoryLink.pair('p0', 'p1', caps)
    hub.addPeer(hubSide, 'p1')
    spoke.addPeer(spokeSide, 'p0')

    // Le hub émet son ping à t=1000.
    clock = 1000
    hub.pump(clock)
    await settle()

    // Le rayon répond 40 ms plus tard.
    clock = 1040
    spoke.pump(clock)
    await settle()

    expect(hub.worstRttMs()).toBe(40)
  })
})
