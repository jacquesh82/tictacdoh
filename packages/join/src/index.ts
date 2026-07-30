export { toBase64Url, fromBase64Url } from './base64url.js'
export {
  DEFAULT_CODE_DIGITS,
  MIN_CODE_DIGITS,
  generateCode,
  isValidCode,
  codeFingerprint,
  fingerprintBytes,
  advertMatchesCode,
} from './code.js'
export {
  TICKET_VERSION,
  TICKET_SCHEME,
  TICKET_PATH,
  TicketError,
  type JoinTicket,
  type TransportHint,
  type HintDefaults,
  type CreateTicketOptions,
  type JoinInput,
  createTicket,
  encodeTicket,
  decodeTicket,
  encodeTicketBytes,
  decodeTicketBytes,
  ticketAppUri,
  ticketWebUrl,
  parseJoinInput,
  hintFor,
  resolveHint,
  preferredTransports,
} from './ticket.js'
export { NdefError, ticketToNdef, ndefToTicket } from './ndef.js'
