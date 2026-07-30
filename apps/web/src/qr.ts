import { type HintDefaults, type JoinTicket, ticketWebUrl, ticketToNdef } from '@ttd/join'
import QRCode from 'qrcode'

/**
 * Affiche le QR d'un ticket.
 *
 * Le lien encodé est le lien universel, pas l'URI à schéma privé : un joueur
 * qui n'a pas encore l'application doit atterrir quelque part plutôt que sur
 * une erreur de schéma inconnu.
 */
export async function renderTicket(
  container: HTMLElement,
  ticket: JoinTicket,
  origin: string,
  defaults: HintDefaults,
): Promise<void> {
  const url = ticketWebUrl(ticket, origin)
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
    })
    const ndefBytes = ticketToNdef(ticket, origin).length
    container.innerHTML = `
      <img class="qr" src="${dataUrl}" alt="Code QR pour rejoindre la partie" />
      <p class="muted" style="text-align:center;margin:0.5rem 0 0">
        ${url.length} caractères · ${ndefBytes} o en NFC
      </p>
    `
  } catch (error) {
    container.innerHTML = `<p class="error">QR indisponible : ${(error as Error).message}</p>`
  }
  void defaults
}
