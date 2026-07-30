import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Coquille mobile.
 *
 * Le web construit dans `apps/web/dist` est embarqué tel quel : le socle est
 * le même code, seuls les transports natifs s'ajoutent. C'est ce qui permet de
 * corriger un mini-jeu sans repasser par les magasins d'applications.
 */
const config: CapacitorConfig = {
  appId: 'app.tictacdoh',
  appName: 'TicTacDoh',
  webDir: '../web/dist',
  server: {
    /**
     * Schéma de la coquille : `http` et non `https`.
     *
     * En `https://localhost`, le navigateur refuse toute WebSocket `ws://` —
     * contenu mixte — et le relay de développement devient injoignable. Erreur
     * constatée sur appareil, invisible en test.
     *
     * `http://localhost` reste un contexte sécurisé au sens des navigateurs
     * (exception explicite pour localhost), donc rien n'est perdu côté API.
     *
     * ⚠️ En production, le relay **doit** être en `wss://`. La règle de contenu
     * mixte est protectrice : un `ws://` public transporterait les parties en
     * clair. Ce réglage ne fait que débloquer le développement local.
     */
    androidScheme: 'http',
    cleartext: true,
  },
  plugins: {
    BleMesh: {},
    Nearby: {},
    NfcTicket: {},
  },
}

export default config
