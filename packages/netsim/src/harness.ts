import { type MemoryLink, type PeerId, Session } from '@ttd/core'
import { SimNetwork } from './network.js'
import type { SimProfile } from './profiles.js'

export interface SimStarOptions {
  readonly sessionId: string
  readonly playerCount: number
  readonly profile: SimProfile
  readonly seed?: number
}

export interface SimStar {
  readonly net: SimNetwork
  readonly hub: Session
  readonly spokes: Session[]
  readonly all: Session[]
  /** Liens côté hub, pour couper un joueur en cours de partie. */
  readonly links: Map<PeerId, MemoryLink>
  advance(durationMs: number, stepMs?: number): void
  /** Ajoute un joueur en cours de session. Rend sa session. */
  join(peerId: PeerId): Session
}

/**
 * Étoile complète prête à jouer : un hub, N rayons, tous branchés sur le même
 * réseau simulé.
 *
 * Reproduit la topologie réelle du BLE et de Nearby, où le hub est le seul à
 * voir tout le monde. Les tests d'intégration du netcode partent tous d'ici.
 */
export function simStar(options: SimStarOptions): SimStar {
  const net = new SimNetwork({ profile: options.profile, seed: options.seed })
  const links = new Map<PeerId, MemoryLink>()

  const hub = new Session({
    sessionId: options.sessionId,
    selfId: 'p0',
    selfName: 'p0',
    isHub: true,
    now: () => net.now(),
  })
  net.register(hub)

  const spokes: Session[] = []
  const all: Session[] = [hub]

  const join = (peerId: PeerId): Session => {
    const spoke = new Session({
      sessionId: options.sessionId,
      selfId: peerId,
      selfName: peerId,
      isHub: false,
      now: () => net.now(),
    })
    const [hubSide, spokeSide] = net.pair('p0', peerId)
    links.set(peerId, hubSide)
    hub.addPeer(hubSide, peerId)
    spoke.addPeer(spokeSide, 'p0')
    net.register(spoke)
    spokes.push(spoke)
    all.push(spoke)
    return spoke
  }

  for (let i = 1; i < options.playerCount; i++) join(`p${i}`)

  return {
    net,
    hub,
    spokes,
    all,
    links,
    advance: (durationMs, stepMs) => net.advance(durationMs, stepMs),
    join,
  }
}
