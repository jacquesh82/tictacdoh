import { describe, expect, it } from 'vitest'
import { createTicket, ticketToNdef } from '@ttd/join'
import { NfcError, NfcPairing, fromBase64, toBase64 } from '../src/index.js'
import type { NfcAvailability, NfcEvents, NfcPlugin, NfcPluginListener } from '../src/plugin.js'

/** Puce NFC simulée, pilotable depuis le test. */
class FakeNfc implements NfcPlugin {
  reading = false
  presenting = false
  presented: string | undefined
  readonly prompts: string[] = []
  #listeners: Array<(e: NfcEvents['tagRead']) => void> = []

  constructor(private readonly dispo: NfcAvailability) {}

  async isAvailable(): Promise<NfcAvailability> {
    return this.dispo
  }
  async startReading(options?: { promptMessage?: string }): Promise<void> {
    this.reading = true
    if (options?.promptMessage) this.prompts.push(options.promptMessage)
  }
  async stopReading(): Promise<void> {
    this.reading = false
  }
  async startPresenting(options: { ndef: string }): Promise<void> {
    this.presenting = true
    this.presented = options.ndef
  }
  async stopPresenting(): Promise<void> {
    this.presenting = false
  }
  async addListener<K extends keyof NfcEvents>(
    event: K,
    listener: (payload: NfcEvents[K]) => void,
  ): Promise<NfcPluginListener> {
    if (event === 'tagRead') {
      this.#listeners.push(listener as (e: NfcEvents['tagRead']) => void)
    }
    return {
      remove: async () => {
        this.#listeners = []
      },
    }
  }

  /** Simule l'approche d'un tag. */
  approach(ndef: Uint8Array): void {
    for (const fn of this.#listeners) fn({ ndef: toBase64(ndef) })
  }
  approachRaw(base64: string): void {
    for (const fn of this.#listeners) fn({ ndef: base64 })
  }
}

const ANDROID: NfcAvailability = { available: true, canPresent: true }
const IPHONE: NfcAvailability = {
  available: true,
  canPresent: false,
  reason: 'iOS ne sait que lire : l’émulation de carte est réservée à Apple Pay',
}
const ABSENT: NfcAvailability = { available: false, canPresent: false, reason: 'NFC désactivé' }

function ticket() {
  return createTicket({
    sessionId: 'salon-42',
    code: '048213',
    hostName: 'Ada',
    transports: [{ kind: 'ws' }],
  })
}

describe('base64', () => {
  it('fait l’aller-retour sur toutes les longueurs de reste', () => {
    // Les trois cas de bourrage — 0, 1 et 2 octets restants — sont exactement
    // là où une implémentation maison se trompe.
    for (let n = 0; n < 12; n++) {
      const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff))
      expect([...fromBase64(toBase64(bytes))], `${n} octets`).toEqual([...bytes])
    }
  })

  it('couvre toute la plage d’octets', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })
})

describe('NfcPairing — lecture', () => {
  it('rend le ticket approché', async () => {
    const puce = new FakeNfc(ANDROID)
    const nfc = new NfcPairing(puce)
    const recus: string[] = []

    await nfc.read({ onTicket: (t) => recus.push(t.code) })
    expect(puce.reading).toBe(true)

    puce.approach(ticketToNdef(ticket()))
    expect(recus).toEqual(['048213'])
  })

  it('survit à un tag illisible et continue de lire', async () => {
    // Cas réel : on approche une carte de transport avant le bon téléphone.
    // Abandonner à la première erreur obligerait à tout relancer.
    const puce = new FakeNfc(ANDROID)
    const nfc = new NfcPairing(puce)
    const recus: string[] = []
    const erreurs: string[] = []

    await nfc.read({ onTicket: (t) => recus.push(t.code), onError: (m) => erreurs.push(m) })
    puce.approachRaw(toBase64(new Uint8Array([1, 2, 3])))
    expect(erreurs).toHaveLength(1)
    expect(puce.reading).toBe(true)

    puce.approach(ticketToNdef(ticket()))
    expect(recus).toEqual(['048213'])
  })

  it('refuse de lire sans puce active', async () => {
    const nfc = new NfcPairing(new FakeNfc(ABSENT))
    await expect(nfc.read({ onTicket: () => undefined })).rejects.toThrow(NfcError)
  })

  it('transmet le message d’invite, que seul iOS affiche', async () => {
    const puce = new FakeNfc(IPHONE)
    await new NfcPairing(puce).read({
      onTicket: () => undefined,
      promptMessage: 'Approchez le téléphone de l’hôte',
    })
    expect(puce.prompts).toEqual(['Approchez le téléphone de l’hôte'])
  })

  it('libère la puce en fin de lecture', async () => {
    const puce = new FakeNfc(ANDROID)
    const nfc = new NfcPairing(puce)
    await nfc.read({ onTicket: () => undefined })
    await nfc.stopReading()
    expect(puce.reading).toBe(false)
    // Un écouteur oublié continuerait de recevoir après le départ de l'écran.
    let recu = false
    puce.approach(ticketToNdef(ticket()))
    expect(recu).toBe(false)
  })
})

describe('NfcPairing — présentation', () => {
  it('présente le ticket sur un appareil qui sait émuler', async () => {
    const puce = new FakeNfc(ANDROID)
    const nfc = new NfcPairing(puce)
    await nfc.present(ticket())
    expect(puce.presenting).toBe(true)
    // Ce qui est présenté doit être exactement le NDEF du ticket : un lecteur
    // tiers doit pouvoir le décoder sans rien savoir de nous.
    expect(fromBase64(puce.presented!)).toEqual(ticketToNdef(ticket()))
  })

  it('refuse sur un iPhone, en expliquant pourquoi', async () => {
    const nfc = new NfcPairing(new FakeNfc(IPHONE))
    await expect(nfc.present(ticket())).rejects.toThrow(/Apple Pay|présenter/)
  })

  it('présente le lien web quand une origine est fournie', async () => {
    const puce = new FakeNfc(ANDROID)
    await new NfcPairing(puce).present(ticket(), 'https://tictacdoh.app')
    expect(fromBase64(puce.presented!)).toEqual(ticketToNdef(ticket(), 'https://tictacdoh.app'))
  })

  it('coupe la présentation à la libération', async () => {
    const puce = new FakeNfc(ANDROID)
    const nfc = new NfcPairing(puce)
    await nfc.present(ticket())
    await nfc.dispose()
    expect(puce.presenting).toBe(false)
    expect(puce.reading).toBe(false)
  })

  it('ne coupe rien si rien n’a été présenté', async () => {
    // `stopPresenting` sur une puce inactive lève sur certains appareils : on
    // ne l'appelle que si l'on a effectivement commencé.
    const puce = new FakeNfc(ANDROID)
    let coupes = 0
    puce.stopPresenting = async () => {
      coupes++
    }
    await new NfcPairing(puce).stopPresenting()
    expect(coupes).toBe(0)
  })
})
