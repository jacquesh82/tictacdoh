import type { HintDefaults } from '@ttd/join'
import { setSetting, setting, settingNumber } from './settings.js'

/**
 * Adresse du relay, en trois temps.
 *
 * Elle était figée à la compilation, ce qui condamnait la coquille native :
 * `localhost` y désigne le téléphone lui-même, où aucun relay ne tourne. La
 * corriger imposait de reconstruire, re-signer et réinstaller l'application —
 * intenable quand le profil de provisionnement d'un compte gratuit expire au
 * bout de sept jours.
 *
 * L'ordre de résolution va donc du plus explicite au plus devinable :
 *
 * 1. **Ce que l'utilisateur a saisi.** Il sait où tourne son serveur ; rien ne
 *    doit le contredire.
 * 2. **La machine qui sert la page.** En PWA, le site vient déjà du bon hôte :
 *    le relay est presque toujours sur la même machine. Ça évite d'avoir à
 *    régler quoi que ce soit dans le cas courant.
 * 3. **La valeur de compilation**, puis `localhost` en dernier recours, qui ne
 *    vaut que pour le développement sur poste.
 */
export function relayUrl(): string {
  const choisi = setting('relayUrl').trim()
  if (choisi) return choisi

  const origine = globalThis.location
  if (origine?.hostname && !isLoopback(origine.hostname)) {
    // `wss` si la page est en `https` : un navigateur refuse une socket en
    // clair depuis une page sécurisée, et l'échec est muet.
    const scheme = origine.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${origine.hostname}:${settingNumber('relayPort')}`
  }

  return import.meta.env['VITE_RELAY_URL'] ?? `ws://localhost:${settingNumber('relayPort')}`
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/** Enregistre l'adresse choisie. Une chaîne vide rétablit la détection. */
export function setRelayUrl(url: string): void {
  setSetting('relayUrl', url)
}

/** L'adresse a-t-elle été fixée à la main ? Sert à l'afficher comme telle. */
export function relayUrlIsManual(): boolean {
  return setting('relayUrl').trim() !== ''
}

/**
 * Constantes connues des deux côtés d'un appairage.
 *
 * Elles ne voyagent pas dans le ticket : c'est ce qui le garde assez petit
 * pour tenir dans un autocollant NFC et pour donner un QR peu dense, donc
 * lisible du premier coup en conditions réelles.
 *
 * Lu à chaque appel, et non figé au chargement du module : l'adresse du relay
 * peut changer en cours de session, et un ticket émis ensuite doit porter la
 * nouvelle.
 */
export function hintDefaults(): HintDefaults {
  return {
    relayUrl: relayUrl(),
    bleServiceUuid: setting('bleServiceUuid'),
    nearbyPrefix: setting('nearbyPrefix'),
  }
}

/**
 * Origine des liens d'invitation.
 *
 * Une fonction et non une constante : figée au chargement, elle ignorait un
 * changement de réglage jusqu'au redémarrage de l'application.
 */
export function webOrigin(): string {
  return globalThis.location?.origin ?? setting('webOrigin')
}

/** @deprecated Utiliser `webOrigin()`, qui relit le réglage à chaque appel. */
export const WEB_ORIGIN = webOrigin()
