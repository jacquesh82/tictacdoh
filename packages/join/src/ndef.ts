import { type JoinTicket, TICKET_SCHEME, ticketAppUri, ticketWebUrl } from './ticket.js'
import { TicketError, parseJoinInput } from './ticket.js'

/**
 * Préfixes d'URI normalisés NDEF.
 *
 * Le premier octet d'un enregistrement URI code un préfixe courant, ce qui
 * évite de l'écrire en toutes lettres. Sur un tag NFC dont la capacité utile
 * démarre souvent à 137 octets, économiser huit caractères sur « https:// »
 * n'est pas anecdotique.
 */
const URI_PREFIXES = ['', 'http://www.', 'https://www.', 'http://', 'https://'] as const

const TNF_WELL_KNOWN = 0x01
const RECORD_TYPE_URI = 0x55

const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class NdefError extends Error {
  override readonly name = 'NdefError'
}

function splitPrefix(uri: string): { code: number; rest: string } {
  // On part des préfixes les plus longs : « https://www. » doit gagner sur
  // « https:// », sinon l'économie est perdue.
  let best = { code: 0, rest: uri }
  for (let code = 1; code < URI_PREFIXES.length; code++) {
    const prefix = URI_PREFIXES[code]!
    if (uri.startsWith(prefix) && prefix.length > URI_PREFIXES[best.code]!.length) {
      best = { code, rest: uri.slice(prefix.length) }
    }
  }
  return best
}

/**
 * Encode un ticket en enregistrement NDEF URI.
 *
 * Le NFC ne transporte rien de nouveau : c'est le même `JoinTicket` que le QR,
 * sous un autre emballage. Ajouter un porteur n'a donc coûté aucun protocole.
 *
 * Réserve matérielle, à connaître avant de compter dessus : un iPhone ne peut
 * pas *présenter* cet enregistrement — l'émulation de carte est réservée à
 * Apple Pay, et Core NFC ne sait que lire. Android Beam ayant été retiré, le
 * seul chemin viable est « un Android présente via HCE, n'importe qui lit »,
 * plus la lecture de tags physiques. Le NFC complète le QR, il ne le remplace
 * pas : le QR, lui, est symétrique.
 */
export function ticketToNdef(ticket: JoinTicket, webOrigin?: string): Uint8Array {
  const uri = webOrigin ? ticketWebUrl(ticket, webOrigin) : ticketAppUri(ticket)
  const { code, rest } = splitPrefix(uri)
  const body = utf8.encode(rest)

  const payloadLength = body.length + 1
  const short = payloadLength <= 0xff

  const header =
    0x80 | // MB : premier enregistrement du message
    0x40 | // ME : dernier enregistrement du message
    (short ? 0x10 : 0) | // SR : longueur de charge utile sur un octet
    TNF_WELL_KNOWN

  const out: number[] = [header, 1]
  if (short) {
    out.push(payloadLength)
  } else {
    out.push(
      (payloadLength >>> 24) & 0xff,
      (payloadLength >>> 16) & 0xff,
      (payloadLength >>> 8) & 0xff,
      payloadLength & 0xff,
    )
  }
  out.push(RECORD_TYPE_URI, code)
  return new Uint8Array([...out, ...body])
}

/** Décode un enregistrement NDEF URI et en extrait le ticket. */
export function ndefToTicket(record: Uint8Array): JoinTicket {
  if (record.length < 5) throw new NdefError('enregistrement NDEF trop court')

  const header = record[0]!
  if ((header & 0x07) !== TNF_WELL_KNOWN) {
    throw new NdefError(`type NDEF non géré: TNF ${header & 0x07}`)
  }

  const typeLength = record[1]!
  const short = (header & 0x10) !== 0
  let at = 2
  let payloadLength: number
  if (short) {
    payloadLength = record[at]!
    at += 1
  } else {
    payloadLength =
      ((record[at]! << 24) | (record[at + 1]! << 16) | (record[at + 2]! << 8) | record[at + 3]!) >>> 0
    at += 4
  }

  // Un identifiant d'enregistrement, si présent, s'intercale ici.
  if ((header & 0x08) !== 0) at += 1 + record[at]!

  const type = record.subarray(at, at + typeLength)
  at += typeLength
  if (typeLength !== 1 || type[0] !== RECORD_TYPE_URI) {
    throw new NdefError('enregistrement NDEF qui n’est pas de type URI')
  }

  const payload = record.subarray(at, at + payloadLength)
  if (payload.length !== payloadLength) throw new NdefError('charge utile NDEF tronquée')

  const prefix = URI_PREFIXES[payload[0]!]
  if (prefix === undefined) throw new NdefError(`préfixe d’URI inconnu: ${payload[0]}`)

  let rest: string
  try {
    rest = utf8Decoder.decode(payload.subarray(1))
  } catch {
    throw new NdefError('URI NDEF en UTF-8 invalide')
  }

  const uri = prefix + rest
  if (!uri.startsWith(`${TICKET_SCHEME}:`) && !prefix.startsWith('http')) {
    throw new NdefError(`URI étrangère à l’application: ${uri}`)
  }

  const parsed = parseJoinInput(uri)
  if (parsed.kind !== 'ticket') throw new TicketError('URI sans ticket')
  return parsed.ticket
}
