import type { TransportKind } from '@ttd/core'
import { Reader, Writer, array, enumOf, str, struct, u8 } from '@ttd/wire'
import { fromBase64Url, toBase64Url } from './base64url.js'
import { isValidCode } from './code.js'

/** Version du format. Un pair qui lit un ticket plus récent doit le dire. */
export const TICKET_VERSION = 1

/** Schéma privé, capté par l'application installée. */
export const TICKET_SCHEME = 'ttd'

/** Chemin du lien universel, pour les appareils sans l'application. */
export const TICKET_PATH = '/j/'

const TRANSPORT_KINDS = ['local', 'ws', 'webrtc', 'ble', 'nearby', 'sim'] as const

/** Comment joindre l'hôte par un transport donné. */
export interface TransportHint {
  readonly kind: TransportKind
  /**
   * URL du relay, identifiant de signaling, UUID de service, nom d'endpoint.
   *
   * Vide dans le cas courant. La plupart des indices se déduisent du
   * `sessionId` ou sont des constantes de l'application : les transmettre
   * gonflait le ticket de plus de moitié, au point qu'il ne tenait plus dans
   * un autocollant NFC NTAG213. On ne transporte donc que ce qui n'est pas
   * déductible — voir `resolveHint`.
   */
  readonly hint?: string
}

/** Constantes de l'application, connues des deux côtés. */
export interface HintDefaults {
  readonly relayUrl: string
  readonly bleServiceUuid: string
  readonly nearbyPrefix?: string
}

/**
 * Indice effectif pour un transport : celui du ticket s'il est explicite,
 * sinon celui que la convention permet de reconstituer.
 */
export function resolveHint(
  ticket: JoinTicket,
  kind: TransportKind,
  defaults: HintDefaults,
): string | undefined {
  const entry = ticket.transports.find((t) => t.kind === kind)
  if (!entry) return undefined
  if (entry.hint && entry.hint.length > 0) return entry.hint

  switch (kind) {
    case 'ws':
      return defaults.relayUrl
    case 'ble':
      return defaults.bleServiceUuid
    case 'webrtc':
      return ticket.sessionId
    case 'nearby':
      return `${defaults.nearbyPrefix ?? 'ttd-'}${ticket.sessionId}`
    default:
      return undefined
  }
}

/**
 * Tout ce qu'il faut pour rejoindre une partie.
 *
 * Un seul objet, plusieurs porteurs : QR, code court, NFC, lien universel.
 * C'est ce qui rend l'ajout d'un porteur gratuit — le NFC n'a demandé aucun
 * protocole nouveau, seulement un encodage NDEF du même ticket.
 *
 * Le QR ne sert pas qu'à éviter une saisie : en portant les indices de
 * transport, il **supprime le tour de découverte**. Le joueur connaît déjà
 * l'UUID de service BLE et se connecte directement, au lieu de scanner un
 * environnement lent et bruité.
 */
export interface JoinTicket {
  readonly v: number
  readonly sessionId: string
  readonly code: string
  readonly hostName: string
  readonly transports: readonly TransportHint[]
}

const ticketCodec = struct({
  v: u8,
  sessionId: str,
  code: str,
  hostName: str,
  transports: array(struct({ kind: enumOf(TRANSPORT_KINDS), hint: str })),
})

export class TicketError extends Error {
  override readonly name = 'TicketError'
}

function validate(ticket: JoinTicket): void {
  if (ticket.v !== TICKET_VERSION) {
    throw new TicketError(
      `ticket en version ${ticket.v}, cette application lit la version ${TICKET_VERSION}`,
    )
  }
  if (!isValidCode(ticket.code)) throw new TicketError(`code invalide: « ${ticket.code} »`)
  if (ticket.sessionId.length === 0) throw new TicketError('identifiant de session vide')
}

export interface CreateTicketOptions {
  readonly sessionId: string
  readonly code: string
  readonly hostName: string
  readonly transports: readonly TransportHint[]
}

export function createTicket(options: CreateTicketOptions): JoinTicket {
  const ticket: JoinTicket = { v: TICKET_VERSION, ...options }
  validate(ticket)
  return ticket
}

/** Sérialise en binaire compact. */
export function encodeTicketBytes(ticket: JoinTicket): Uint8Array {
  validate(ticket)
  const w = new Writer(128)
  ticketCodec.write(w, {
    v: ticket.v,
    sessionId: ticket.sessionId,
    code: ticket.code,
    hostName: ticket.hostName,
    transports: ticket.transports.map((t) => ({ kind: t.kind, hint: t.hint ?? '' })),
  })
  return w.finish()
}

export function decodeTicketBytes(bytes: Uint8Array): JoinTicket {
  let raw
  try {
    raw = ticketCodec.read(new Reader(bytes))
  } catch (cause) {
    throw new TicketError(`ticket illisible: ${(cause as Error).message}`)
  }
  const ticket: JoinTicket = {
    v: raw.v,
    sessionId: raw.sessionId,
    code: raw.code,
    hostName: raw.hostName,
    transports: raw.transports.map((t) =>
      t.hint.length > 0 ? { kind: t.kind, hint: t.hint } : { kind: t.kind },
    ),
  }
  validate(ticket)
  return ticket
}

/** Ticket encodé pour une URL ou un QR. */
export function encodeTicket(ticket: JoinTicket): string {
  return toBase64Url(encodeTicketBytes(ticket))
}

export function decodeTicket(payload: string): JoinTicket {
  return decodeTicketBytes(fromBase64Url(payload))
}

/** URI à schéma privé : ouvre directement l'application installée. */
export function ticketAppUri(ticket: JoinTicket): string {
  return `${TICKET_SCHEME}:${TICKET_PATH}${encodeTicket(ticket)}`
}

/**
 * Lien universel. Ouvre l'application si elle est installée, et retombe sur
 * le web sinon — ce qui compte pour un joueur qui découvre le jeu en scannant
 * le QR de quelqu'un d'autre.
 */
export function ticketWebUrl(ticket: JoinTicket, origin: string): string {
  return `${origin.replace(/\/$/, '')}${TICKET_PATH}${encodeTicket(ticket)}`
}

/** Ce qu'un joueur a fourni pour rejoindre. */
export type JoinInput =
  | { readonly kind: 'ticket'; readonly ticket: JoinTicket }
  | { readonly kind: 'code'; readonly code: string }

/**
 * Interprète une saisie, quelle qu'en soit la forme.
 *
 * Un seul champ dans l'interface accepte le code tapé, l'URI scannée, le lien
 * collé ou la charge utile NFC brute. L'utilisateur n'a pas à savoir de quel
 * porteur vient ce qu'il tient.
 */
export function parseJoinInput(text: string): JoinInput {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new TicketError('saisie vide')

  if (isValidCode(trimmed)) return { kind: 'code', code: trimmed }

  const at = trimmed.lastIndexOf(TICKET_PATH)
  const payload = at >= 0 ? trimmed.slice(at + TICKET_PATH.length) : trimmed
  if (payload.length === 0) throw new TicketError('lien sans ticket')

  return { kind: 'ticket', ticket: decodeTicket(payload) }
}

/** Indice pour un transport donné, s'il figure dans le ticket. */
export function hintFor(ticket: JoinTicket, kind: TransportKind): string | undefined {
  return ticket.transports.find((t) => t.kind === kind)?.hint
}

/**
 * Transports du ticket, du plus au moins souhaitable.
 *
 * Le hors-ligne passe avant : si deux appareils peuvent se parler sans
 * infrastructure, c'est toujours préférable à un aller-retour par un relay.
 * Le BLE ferme la marche — il fonctionne partout mais reste le plus lent.
 */
export function preferredTransports(ticket: JoinTicket): TransportHint[] {
  const rank: Record<TransportKind, number> = {
    local: 0,
    nearby: 1,
    webrtc: 2,
    ws: 3,
    ble: 4,
    sim: 5,
  }
  return [...ticket.transports].sort((a, b) => rank[a.kind] - rank[b.kind])
}
