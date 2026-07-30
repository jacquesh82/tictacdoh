import { Rng, seedFrom } from '@ttd/core'
import { describe, expect, it } from 'vitest'
import {
  NdefError,
  TICKET_VERSION,
  TicketError,
  advertMatchesCode,
  codeFingerprint,
  createTicket,
  decodeTicket,
  encodeTicket,
  encodeTicketBytes,
  fingerprintBytes,
  fromBase64Url,
  generateCode,
  hintFor,
  isValidCode,
  ndefToTicket,
  parseJoinInput,
  resolveHint,
  preferredTransports,
  ticketAppUri,
  ticketToNdef,
  ticketWebUrl,
  toBase64Url,
} from '../src/index.js'

const DEFAULTS = {
  relayUrl: 'wss://relay.tictacdoh.app',
  bleServiceUuid: '0000fe2c-0000-1000-8000-00805f9b34fb',
}

/** Ticket nominal : aucun indice explicite, tout se déduit. */
const ticket = createTicket({
  sessionId: 'sess-8f2a41',
  code: '048213',
  hostName: 'Le salon de Jacques',
  transports: [{ kind: 'ws' }, { kind: 'webrtc' }, { kind: 'ble' }, { kind: 'nearby' }],
})

/** Ticket d'un hôte qui utilise son propre relay. */
const customTicket = createTicket({
  sessionId: 'sess-8f2a41',
  code: '048213',
  hostName: 'Relay privé',
  transports: [{ kind: 'ws', hint: 'wss://chez-moi.example/relay' }],
})

describe('base64url', () => {
  it('fait l’aller-retour sur des longueurs quelconques', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256)
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('n’émet aucun caractère à échapper dans une URL', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const encoded = toBase64Url(bytes)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/)
    expect(encodeURIComponent(encoded)).toBe(encoded)
  })

  it('refuse un caractère invalide', () => {
    expect(() => fromBase64Url('abc$def')).toThrow(SyntaxError)
  })
})

describe('code court', () => {
  it('génère un code de la bonne longueur, chiffres seulement', () => {
    const rng = new Rng(seedFrom('partie'))
    for (let i = 0; i < 50; i++) {
      const code = generateCode(rng)
      expect(code).toMatch(/^[0-9]{6}$/)
      expect(isValidCode(code)).toBe(true)
    }
  })

  it('conserve les zéros de tête', () => {
    // Un code traité comme un nombre perdrait ses zéros et deux joueurs
    // taperaient des choses différentes pour la même partie.
    const rng = new Rng(1)
    const codes = Array.from({ length: 300 }, () => generateCode(rng))
    const leading = codes.filter((code) => code.startsWith('0'))
    expect(leading.length).toBeGreaterThan(10)
    for (const code of leading) expect(code).toHaveLength(6)
  })

  it('accepte 4 chiffres pour les parties en présentiel', () => {
    expect(generateCode(new Rng(2), 4)).toMatch(/^[0-9]{4}$/)
    expect(isValidCode('0421')).toBe(true)
    expect(isValidCode('042')).toBe(false)
    expect(isValidCode('04a213')).toBe(false)
  })

  it('rejette une longueur absurde', () => {
    expect(() => generateCode(new Rng(3), 2)).toThrow(RangeError)
    expect(() => generateCode(new Rng(3), 12)).toThrow(RangeError)
  })

  it('produit une empreinte stable tenant sur trois octets', () => {
    // Trois octets, parce qu'un advertising BLE hérité n'en offre que 31 en
    // tout, UUID de service compris.
    expect(codeFingerprint('048213')).toBe(codeFingerprint('048213'))
    expect(fingerprintBytes('048213')).toHaveLength(3)
    expect(codeFingerprint('048213')).toBeLessThanOrEqual(0xff_ffff)
  })

  it('sépare les codes voisins', () => {
    const seen = new Map<number, string>()
    let collisions = 0
    for (let i = 0; i < 5000; i++) {
      const code = String(i).padStart(6, '0')
      const print = codeFingerprint(code)
      if (seen.has(print)) collisions++
      seen.set(print, code)
    }
    // Quelques collisions sur 5000 codes sont sans importance : l'empreinte
    // ne fait que filtrer les sessions à portée, le code complet est vérifié
    // à la connexion.
    expect(collisions).toBeLessThan(10)
  })

  it('filtre les annonces par le code saisi', () => {
    const advert = fingerprintBytes('048213')
    expect(advertMatchesCode(advert, '048213')).toBe(true)
    expect(advertMatchesCode(advert, '048214')).toBe(false)
    expect(advertMatchesCode(new Uint8Array([1, 2]), '048213')).toBe(false)
  })
})

describe('JoinTicket', () => {
  it('fait l’aller-retour sans perte', () => {
    const back = decodeTicket(encodeTicket(ticket))
    expect(back).toEqual(ticket)
  })

  it('reste assez compact pour un QR robuste', () => {
    // Un QR dense se scanne mal en conditions réelles. C'est la raison pour
    // laquelle le ticket ne porte pas de pré-offre WebRTC : les candidats ICE
    // feraient 1 à 2 ko à eux seuls.
    expect(encodeTicketBytes(ticket).length).toBeLessThan(60)
    expect(encodeTicket(ticket).length).toBeLessThan(80)
  })

  it('refuse un ticket d’une autre version', () => {
    const bytes = encodeTicketBytes(ticket)
    bytes[0] = TICKET_VERSION + 1
    expect(() => decodeTicket(toBase64Url(bytes))).toThrow(TicketError)
  })

  it('refuse un code invalide à la création', () => {
    expect(() =>
      createTicket({ ...ticket, code: 'abc' }),
    ).toThrow(TicketError)
  })

  it('produit une URI applicative et un lien universel équivalents', () => {
    const app = ticketAppUri(ticket)
    const web = ticketWebUrl(ticket, 'https://tictacdoh.app/')
    expect(app.startsWith('ttd:/j/')).toBe(true)
    expect(web.startsWith('https://tictacdoh.app/j/')).toBe(true)

    // Les deux portent le même ticket : l'un ouvre l'application installée,
    // l'autre retombe sur le web pour qui ne l'a pas.
    expect(parseJoinInput(app)).toEqual({ kind: 'ticket', ticket })
    expect(parseJoinInput(web)).toEqual({ kind: 'ticket', ticket })
  })

  it('reconstitue les indices déductibles sans les transmettre', () => {
    // Transmettre « sig-8f2a41 » et « ttd-8f2a41 » alors qu'ils se déduisent du
    // sessionId gonflait le ticket de plus de moitié — au point de ne plus
    // tenir dans un autocollant NFC.
    expect(hintFor(ticket, 'ble')).toBeUndefined()
    expect(resolveHint(ticket, 'ble', DEFAULTS)).toBe(DEFAULTS.bleServiceUuid)
    expect(resolveHint(ticket, 'ws', DEFAULTS)).toBe(DEFAULTS.relayUrl)
    expect(resolveHint(ticket, 'webrtc', DEFAULTS)).toBe('sess-8f2a41')
    expect(resolveHint(ticket, 'nearby', DEFAULTS)).toBe('ttd-sess-8f2a41')
    expect(resolveHint(ticket, 'local', DEFAULTS)).toBeUndefined()
  })

  it('laisse un hôte imposer son propre indice', () => {
    // La déduction est une convention, pas une contrainte : qui héberge son
    // relay doit pouvoir le dire.
    expect(resolveHint(customTicket, 'ws', DEFAULTS)).toBe('wss://chez-moi.example/relay')
    expect(decodeTicket(encodeTicket(customTicket))).toEqual(customTicket)
  })

  it('préfère le hors-ligne au relay, et garde le BLE en dernier', () => {
    // Deux appareils qui peuvent se parler sans infrastructure ne devraient
    // jamais faire un aller-retour par un serveur.
    expect(preferredTransports(ticket).map((t) => t.kind)).toEqual([
      'nearby',
      'webrtc',
      'ws',
      'ble',
    ])
  })
})

describe('saisie du joueur', () => {
  it('accepte indifféremment un code, une URI, un lien ou une charge brute', () => {
    // Un seul champ dans l'interface : l'utilisateur n'a pas à savoir de quel
    // porteur vient ce qu'il tient.
    expect(parseJoinInput('048213')).toEqual({ kind: 'code', code: '048213' })
    expect(parseJoinInput('  048213  ')).toEqual({ kind: 'code', code: '048213' })
    expect(parseJoinInput(ticketAppUri(ticket)).kind).toBe('ticket')
    expect(parseJoinInput(ticketWebUrl(ticket, 'https://x.app')).kind).toBe('ticket')
    expect(parseJoinInput(encodeTicket(ticket)).kind).toBe('ticket')
  })

  it('refuse une saisie vide ou un lien sans ticket', () => {
    expect(() => parseJoinInput('   ')).toThrow(TicketError)
    expect(() => parseJoinInput('https://tictacdoh.app/j/')).toThrow(TicketError)
  })
})

describe('NDEF', () => {
  it('fait l’aller-retour par un enregistrement URI', () => {
    // Le NFC ne transporte rien de nouveau : c'est le même ticket que le QR.
    expect(ndefToTicket(ticketToNdef(ticket))).toEqual(ticket)
  })

  it('fait l’aller-retour sur un lien universel', () => {
    expect(ndefToTicket(ticketToNdef(ticket, 'https://tictacdoh.app'))).toEqual(ticket)
  })

  it('abrège le préfixe https pour économiser la place du tag', () => {
    const record = ticketToNdef(ticket, 'https://tictacdoh.app')
    const uri = ticketWebUrl(ticket, 'https://tictacdoh.app')
    // L'enregistrement doit être plus court que l'URI écrite en toutes
    // lettres : un tag NFC courant démarre à 137 octets utiles.
    expect(record.length).toBeLessThan(uri.length + 7)
    expect(record).toContain(4) // code du préfixe « https:// »
  })

  it('tient dans un tag NTAG213', () => {
    // 137 octets utiles, le format le plus répandu des autocollants NFC.
    expect(ticketToNdef(ticket).length).toBeLessThanOrEqual(137)
  })

  it('refuse un enregistrement tronqué ou étranger', () => {
    expect(() => ndefToTicket(new Uint8Array([0xd1, 1]))).toThrow(NdefError)
    const foreign = ticketToNdef(ticket)
    foreign[0] = (foreign[0]! & ~0x07) | 0x02 // TNF « type MIME »
    expect(() => ndefToTicket(foreign)).toThrow(NdefError)
  })
})
