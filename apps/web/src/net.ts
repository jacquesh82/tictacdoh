import { type Link, Rng, Session, seedFrom } from '@ttd/core'
import { createTicket, generateCode, type JoinTicket } from '@ttd/join'
import { WsTransport } from '@ttd/transport-ws'
import { WebRtcTransport } from '@ttd/transport-webrtc'
import { HINT_DEFAULTS } from './app-config.js'

export interface NetRoom {
  readonly session: Session
  readonly ticket: JoinTicket
  readonly code: string
  readonly roomName: string
  /** Transport réellement utilisé par pair, pour l'affichage. */
  readonly linkKinds: Map<string, string>
  /** Ferme la salle pour tout le monde. Réservé au créateur. */
  closeRoom(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Délai accordé au pair à pair avant de se rabattre sur le relay.
 *
 * Court volontairement : un joueur qui attend dix secondes devant un écran
 * vide croit que ça a échoué. Mieux vaut démarrer par le relay et laisser
 * WebRTC réussir la prochaine fois que d'imposer cette attente.
 */
const RTC_GRACE_MS = 3000

/**
 * Ouvre une partie en réseau.
 *
 * Deux transports en parallèle : le relay met en relation et sert de secours,
 * WebRTC prend le relais quand il y parvient. Le socle au-dessus ne voit
 * qu'un `Link` — c'est tout l'intérêt de l'abstraction, et la raison pour
 * laquelle un échec de NAT ne rend pas le jeu injouable.
 */
export async function hostRoom(
  relayUrl: string,
  hostName: string,
  roomName = '',
): Promise<NetRoom> {
  const sessionId = `net-${Date.now().toString(36)}`
  const code = generateCode(new Rng(seedFrom(sessionId + Math.random())))

  const ws = new WsTransport({ url: relayUrl, selfName: hostName })
  await ws.advertise({ sessionId, code, hostName, roomName, playerCount: 1, maxPlayers: 4 })

  const rtc = new WebRtcTransport({ signal: ws, selfSlot: 0, isHost: true })
  // L'identité de session est celle du transport : le hub s'attribue la
  // place 0, et chaque invité la sienne. Un identifiant choisi librement ferait
  // publier un roster où le destinataire ne se reconnaît pas.
  const session = new Session({
    sessionId,
    selfId: WsTransport.peerIdForSlot(0),
    selfName: hostName,
    isHub: true,
  })
  const linkKinds = new Map<string, string>()

  /** Liens relayés en attente, le temps de voir si WebRTC aboutit. */
  const waiting = new Map<string, { link: Link; timer: number }>()

  const adopt = (link: Link, kind: string) => {
    linkKinds.set(link.peerId, kind)
    session.addPeer(link, ws.peerName(link.peerId) ?? link.peerId)
  }

  rtc.onIncoming((link) => {
    // Les deux transports désignent un pair par sa place, jamais par son nom :
    // c'est ce qui permet de reconnaître ici l'invité déjà arrivé par le relay
    // et de remplacer son lien, au lieu de l'ajouter une seconde fois.
    const pending = waiting.get(link.peerId)
    if (pending) {
      clearTimeout(pending.timer)
      waiting.delete(link.peerId)
      pending.link.close('remplacé par le pair à pair')
    }
    adopt(link, 'webrtc')
  })

  ws.onIncoming((link) => {
    // On patiente : si le pair à pair s'établit, il vaut mieux. Sinon on prend
    // le relay, qui a le mérite de toujours marcher.
    const timer = globalThis.setTimeout(() => {
      waiting.delete(link.peerId)
      adopt(link, 'ws')
    }, RTC_GRACE_MS) as unknown as number
    waiting.set(link.peerId, { link, timer })
  })

  const ticket = createTicket({
    sessionId,
    code,
    hostName,
    transports: [{ kind: 'webrtc' }, { kind: 'ws' }],
  })

  return {
    session,
    ticket,
    code,
    roomName: roomName || `Partie de ${hostName}`,
    linkKinds,
    async closeRoom() {
      for (const entry of waiting.values()) clearTimeout(entry.timer)
      session.close()
      await rtc.close()
      await ws.closeRoom()
    },
    async dispose() {
      for (const entry of waiting.values()) clearTimeout(entry.timer)
      session.close()
      await rtc.close()
      await ws.close()
    },
  }
}

export interface JoinedNetRoom {
  readonly session: Session
  readonly kind: string
  readonly hostName: string
  readonly roomName: string
  dispose(): Promise<void>
}

/** Rejoint une partie par son code court. */
export async function joinRoom(
  relayUrl: string,
  code: string,
  selfName: string,
): Promise<JoinedNetRoom> {
  const ws = new WsTransport({ url: relayUrl, selfName })
  const joined = await ws.joinByCode(code)

  const rtc = new WebRtcTransport({ signal: ws, selfSlot: joined.slot, isHost: false })

  let link: Link = joined.link
  let kind = 'ws'
  try {
    link = await rtc.connectToHost(joined.hostName, RTC_GRACE_MS)
    kind = 'webrtc'
    joined.link.close('remplacé par le pair à pair')
  } catch {
    // Échec d'appairage — NAT restrictif, pas de TURN, ou hôte trop lent. Le
    // relay reste ouvert : la partie démarre quand même, un peu plus lente.
    await rtc.close()
  }

  const session = new Session({
    sessionId: joined.sessionId,
    selfId: WsTransport.peerIdForSlot(joined.slot),
    selfName,
    isHub: false,
  })
  session.addPeer(link, joined.hostName)

  return {
    session,
    kind,
    hostName: joined.hostName,
    roomName: joined.roomName,
    async dispose() {
      session.close()
      await rtc.close()
      await ws.close()
    },
  }
}

export const RELAY_URL = HINT_DEFAULTS.relayUrl
