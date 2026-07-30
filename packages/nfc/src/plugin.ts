/**
 * Contrat du plugin NFC natif.
 *
 * ## Ce que le matériel permet vraiment
 *
 * L'appairage NFC n'est **pas symétrique**, et c'est une contrainte de
 * plateforme qu'aucune conception ne contourne :
 *
 * - **Android** sait présenter (émulation de carte, HCE) *et* lire.
 * - **iOS** ne sait que **lire**. L'émulation de carte est réservée à Apple
 *   Pay ; Core NFC n'expose rien d'équivalent.
 * - **Android Beam**, qui permettait l'échange symétrique, a été retiré.
 *
 * Le seul chemin viable est donc : **un Android présente, n'importe qui lit**.
 * Plus la lecture de tags physiques, qu'on peut programmer une fois pour
 * toutes.
 *
 * Le NFC complète donc le QR, il ne le remplace pas — le QR, lui, marche dans
 * les deux sens entre n'importe quels appareils. Ce que le NFC apporte, c'est
 * la vitesse : approcher deux téléphones est plus rapide que sortir une
 * caméra, viser et attendre la mise au point.
 *
 * ## Ce qui circule
 *
 * Rien de nouveau : le même `JoinTicket` que le QR, encodé en NDEF par
 * `@ttd/join`. Ajouter ce porteur n'a coûté aucun protocole.
 */

export interface NfcTagEvent {
  /** Enregistrement NDEF brut, en base64 : le pont Capacitor ne porte que du JSON. */
  readonly ndef: string
}

export interface NfcEvents {
  /** Un tag ou un appareil présentant un NDEF a été lu. */
  tagRead: NfcTagEvent
  /** Un lecteur a interrogé notre émulation de carte. Utile au diagnostic. */
  ticketRead: { readonly at: number }
}

export interface NfcPluginListener {
  remove(): Promise<void>
}

export interface NfcAvailability {
  /** Une puce NFC existe et est activée. */
  readonly available: boolean
  /** L'appareil sait présenter un ticket (Android uniquement). */
  readonly canPresent: boolean
  /** Formulé pour l'utilisateur quand quelque chose manque. */
  readonly reason?: string
}

export interface NfcPlugin {
  isAvailable(): Promise<NfcAvailability>

  /**
   * Passe en lecture. Émet `tagRead` à chaque approche.
   *
   * Sur iOS, ouvre la feuille système de lecture ; sur Android, active le mode
   * lecteur sans interface. La différence est visible pour l'utilisateur, d'où
   * `promptMessage`, ignoré sur Android.
   */
  startReading(options?: { promptMessage?: string }): Promise<void>
  stopReading(): Promise<void>

  /**
   * Présente un ticket jusqu'à `stopPresenting`.
   *
   * Rejeté si `canPresent` est faux — inutile de laisser croire à un iPhone
   * qu'il peut héberger par ce moyen.
   */
  startPresenting(options: { ndef: string }): Promise<void>
  stopPresenting(): Promise<void>

  addListener<K extends keyof NfcEvents>(
    event: K,
    listener: (payload: NfcEvents[K]) => void,
  ): Promise<NfcPluginListener>
}
