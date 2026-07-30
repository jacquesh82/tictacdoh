import { type JoinTicket, ndefToTicket, ticketToNdef } from '@ttd/join'

export type {
  NfcPlugin,
  NfcPluginListener,
  NfcEvents,
  NfcTagEvent,
  NfcAvailability,
} from './plugin.js'
import type { NfcPlugin, NfcPluginListener } from './plugin.js'

/** Erreur d'appairage NFC, distincte d'une erreur de ticket mal formé. */
export class NfcError extends Error {
  override readonly name = 'NfcError'
}

/**
 * Appairage par NFC.
 *
 * Enveloppe le plugin natif pour que l'application ne manipule que des
 * `JoinTicket` : l'encodage NDEF et le base64 du pont Capacitor restent ici.
 * Le reste du socle ignore donc jusqu'à l'existence du NFC — c'est ce qui
 * permet de l'ajouter, ou de le retirer, sans toucher au lobby.
 */
export class NfcPairing {
  readonly #plugin: NfcPlugin
  #listener: NfcPluginListener | undefined
  #presenting = false

  constructor(plugin: NfcPlugin) {
    this.#plugin = plugin
  }

  async availability(): Promise<{ available: boolean; canPresent: boolean; reason?: string }> {
    return this.#plugin.isAvailable()
  }

  /**
   * Lit un ticket approché.
   *
   * Rend le ticket au premier tag valide. Un tag illisible n'interrompt pas la
   * lecture : en pratique on approche souvent un badge de transport ou une
   * carte bancaire par erreur, et abandonner à la première erreur obligerait à
   * tout relancer.
   */
  async read(options: {
    onTicket: (ticket: JoinTicket) => void
    onError?: (message: string) => void
    promptMessage?: string
  }): Promise<void> {
    const dispo = await this.#plugin.isAvailable()
    if (!dispo.available) {
      throw new NfcError(dispo.reason ?? 'NFC indisponible sur cet appareil')
    }

    this.#listener = await this.#plugin.addListener('tagRead', (event) => {
      try {
        options.onTicket(ndefToTicket(fromBase64(event.ndef)))
      } catch (error) {
        options.onError?.(`Tag illisible : ${(error as Error).message}`)
      }
    })

    await this.#plugin.startReading(
      options.promptMessage === undefined ? {} : { promptMessage: options.promptMessage },
    )
  }

  async stopReading(): Promise<void> {
    await this.#listener?.remove()
    this.#listener = undefined
    await this.#plugin.stopReading()
  }

  /**
   * Présente un ticket aux lecteurs à portée.
   *
   * Réservé aux appareils qui savent émuler une carte — Android. Le refuser
   * explicitement vaut mieux que de laisser un iPhone attendre indéfiniment
   * qu'on le lise.
   */
  async present(ticket: JoinTicket, webOrigin?: string): Promise<void> {
    const dispo = await this.#plugin.isAvailable()
    if (!dispo.canPresent) {
      throw new NfcError(
        dispo.reason ?? 'cet appareil ne sait pas présenter de ticket : approchez-le d’un Android',
      )
    }
    const ndef = webOrigin ? ticketToNdef(ticket, webOrigin) : ticketToNdef(ticket)
    await this.#plugin.startPresenting({ ndef: toBase64(ndef) })
    this.#presenting = true
  }

  async stopPresenting(): Promise<void> {
    if (!this.#presenting) return
    this.#presenting = false
    await this.#plugin.stopPresenting()
  }

  /** Libère tout. À appeler en quittant l'écran, sous peine de laisser la puce active. */
  async dispose(): Promise<void> {
    await this.stopReading().catch(() => undefined)
    await this.stopPresenting().catch(() => undefined)
  }
}

/**
 * Base64 sans dépendance.
 *
 * `btoa` n'existe pas partout où ce paquet tourne — ni en test Node ancien, ni
 * dans certaines coquilles — et tirer une bibliothèque pour trente lignes
 * serait disproportionné.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array((clean.length * 3) >> 2)
  let n = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!)
    const b = B64.indexOf(clean[i + 1] ?? 'A')
    const c = clean[i + 2] === undefined ? -1 : B64.indexOf(clean[i + 2]!)
    const d = clean[i + 3] === undefined ? -1 : B64.indexOf(clean[i + 3]!)
    out[n++] = (a << 2) | (b >> 4)
    if (c >= 0) out[n++] = ((b & 15) << 4) | (c >> 2)
    if (d >= 0) out[n++] = ((c & 3) << 6) | d
  }
  return out.slice(0, n)
}
