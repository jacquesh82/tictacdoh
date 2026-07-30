import type { HintDefaults } from '@ttd/join'

/**
 * Constantes connues des deux côtés d'un appairage.
 *
 * Elles ne voyagent pas dans le ticket : c'est ce qui le garde assez petit
 * pour tenir dans un autocollant NFC et pour donner un QR peu dense, donc
 * lisible du premier coup en conditions réelles.
 */
export const HINT_DEFAULTS: HintDefaults = {
  relayUrl: import.meta.env['VITE_RELAY_URL'] ?? 'ws://localhost:8787',
  // UUID de service BLE propre à l'application, tiré de la plage 128 bits.
  bleServiceUuid: '7ac0d0a1-0000-4000-8000-00805f9b34fb',
  nearbyPrefix: 'ttd-',
}

export const WEB_ORIGIN = globalThis.location?.origin ?? 'https://tictacdoh.app'
