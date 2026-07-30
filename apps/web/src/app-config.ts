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

/**
 * Message d'échec du relay, avec le geste qui le corrige.
 *
 * Le conseil dépend de l'endroit où l'on tourne, et c'est tout l'intérêt :
 * « le relay est-il lancé ? » a du sens sur un poste de développement et aucun
 * sur un téléphone, où l'adresse est simplement absente. Dans la coquille
 * native la page vient de `localhost`, donc l'adresse ne peut pas être déduite
 * de l'origine et le repli désigne l'appareil lui-même.
 */
export function relayAdvice(message: string): string {
  const url = relayUrl()
  const loopback = /\/\/(localhost|127\.0\.0\.1|\[?::1\]?)[:/]/.test(url)
  const natif = globalThis.location?.protocol === 'capacitor:' || isNativeShell()

  if (natif && loopback && !relayUrlIsManual()) {
    return `${url} désigne cet appareil. Renseignez l’adresse du serveur dans Diagnostic → Configuration.`
  }

  // Un `wss://` qui échoue vers une adresse privée est, dans l'immense
  // majorité des cas, un certificat non reconnu — aucune autorité publique
  // n'en émet pour une IP privée. On ne peut pas le confirmer depuis le
  // JavaScript : les navigateurs masquent délibérément la cause d'un échec
  // TLS, et c'est aussi ce qui interdit de proposer d'accepter le certificat
  // depuis l'application. Le dire comme une hypothèse probable, avec le geste
  // qui la lève, vaut mieux que de laisser chercher.
  if (url.startsWith('wss://') && isPrivateHost(url)) {
    return (
      `${message} — relay visé : ${url}. Cause probable : certificat non reconnu. ` +
      `L’autorité doit être installée dans les réglages du système ` +
      `(voir docs/relay-tls.md) ; une application ne peut pas accorder cette confiance à votre place.`
    )
  }

  return `${message} — relay visé : ${url}`
}

/** L'adresse vise-t-elle une machine du réseau local ? */
function isPrivateHost(url: string): boolean {
  const hote = /^wss?:\/\/([^:/]+)/.exec(url)?.[1] ?? ''
  return (
    /^10\./.test(hote) ||
    /^192\.168\./.test(hote) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hote) ||
    hote.endsWith('.local')
  )
}

/**
 * Coquille native, détectée sans dépendre de Capacitor.
 *
 * `app-config` est importé très tôt et par des modules qui ne doivent rien
 * savoir du natif : on se contente donc d'un indice d'origine.
 */
function isNativeShell(): boolean {
  const h = globalThis.location?.hostname
  return h === 'localhost' && globalThis.location?.port === ''
}
