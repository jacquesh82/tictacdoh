import { PATH_LOSS_EXPONENT, TX_POWER_AT_ONE_METER } from '@ttd/core'

/**
 * Réglages de l'application.
 *
 * Un registre unique plutôt que des constantes éparpillées. Chaque valeur
 * était jusqu'ici écrite en dur au point où elle servait, ce qui posait trois
 * problèmes concrets :
 *
 * - **Rien n'était ajustable sur l'appareil.** Changer l'adresse du relay ou
 *   la calibration de distance imposait de reconstruire, re-signer et
 *   réinstaller — intenable avec un certificat qui expire en sept jours.
 * - **Les mêmes valeurs divergeaient.** L'adresse du relay existait à trois
 *   endroits indépendants, et l'un d'eux avait déjà pris du retard sur les
 *   autres.
 * - **Rien ne documentait les valeurs par défaut.** Un « 2.7 » au milieu d'un
 *   calcul n'apprend pas d'où il sort ni quand le changer.
 *
 * Les défauts restent les mêmes qu'avant : ce registre ne change aucun
 * comportement tant qu'on n'y touche pas.
 */

export type SettingKind = 'texte' | 'nombre'

export interface SettingSpec {
  readonly key: string
  readonly label: string
  /** À quoi ça sert, et quand il est légitime d'y toucher. */
  readonly help: string
  readonly kind: SettingKind
  readonly defaultValue: string
  /** Regroupement d'affichage. */
  readonly group: string
  /** Exemple montré quand le champ est vide. */
  readonly placeholder?: string
  /** Valide une saisie ; rend un message d'erreur, ou undefined si correcte. */
  readonly validate?: (value: string) => string | undefined
}

const positif = (label: string) => (v: string) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return `${label} doit être un nombre strictement positif`
  return undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: 'relayUrl',
    label: 'Adresse du relay',
    help:
      'Vide = déduite de l’adresse du site. À renseigner dans l’application installée, ' +
      'où « localhost » désigne le téléphone lui-même et non le serveur.',
    kind: 'texte',
    defaultValue: '',
    placeholder: 'ws://192.168.1.10:8787',
    group: 'Réseau',
    validate: (v) =>
      v === '' || /^wss?:\/\/.+/.test(v) ? undefined : 'doit commencer par ws:// ou wss://',
  },
  {
    key: 'relayPort',
    label: 'Port du relay',
    help: 'Utilisé quand l’adresse est déduite automatiquement.',
    kind: 'nombre',
    defaultValue: '8787',
    group: 'Réseau',
    validate: positif('le port'),
  },
  {
    key: 'webOrigin',
    label: 'Origine des liens d’invitation',
    help:
      'Adresse publique utilisée dans les QR et les tags NFC, pour qu’un téléphone ' +
      'sans l’application retombe sur le site.',
    kind: 'texte',
    defaultValue: 'https://tictacdoh.app',
    group: 'Réseau',
  },
  {
    key: 'bleServiceUuid',
    label: 'UUID de service Bluetooth',
    help:
      'Identifie l’application sur les ondes. Deux appareils ne se voient que s’ils ' +
      'partagent exactement le même. À ne changer que pour isoler deux essais.',
    kind: 'texte',
    defaultValue: '7ac0d0a1-0000-4000-8000-00805f9b34fb',
    group: 'Bluetooth',
    validate: (v) => (UUID_RE.test(v) ? undefined : 'format UUID attendu (8-4-4-4-12)'),
  },
  {
    key: 'diagnosticFingerprint',
    label: 'Empreinte de diagnostic',
    help:
      'Empreinte annoncée pendant une recherche, distincte de celle d’une vraie partie : ' +
      'elle rend visible sans prétendre héberger une salle.',
    kind: 'texte',
    defaultValue: '000000',
    group: 'Bluetooth',
    validate: (v) => (/^[0-9a-f]{6}$/i.test(v) ? undefined : 'six chiffres hexadécimaux attendus'),
  },
  {
    key: 'nearbyPrefix',
    label: 'Préfixe Wi-Fi Direct',
    help: 'Préfixe des noms d’endpoint, pour ne pas confondre avec d’autres applications.',
    kind: 'texte',
    defaultValue: 'ttd-',
    group: 'Bluetooth',
  },
  {
    key: 'txPower',
    label: 'Puissance reçue à un mètre (dBm)',
    help:
      'Point de référence de l’estimation de distance. Pour calibrer : posez deux appareils ' +
      'à exactement un mètre, lisez le dBm affiché, et reportez-le ici.',
    kind: 'nombre',
    defaultValue: String(TX_POWER_AT_ONE_METER),
    group: 'Estimation de distance',
    validate: (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return 'nombre attendu'
      if (n > 0) return 'un RSSI est négatif'
      return undefined
    },
  },
  {
    key: 'pathLoss',
    label: 'Exposant d’affaiblissement',
    help:
      '2 en champ libre, 3 à 3,5 dans un intérieur meublé. Augmentez-le si les distances ' +
      'affichées vous paraissent trop grandes.',
    kind: 'nombre',
    defaultValue: String(PATH_LOSS_EXPONENT),
    group: 'Estimation de distance',
    validate: (v) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1.5 || n > 6) return 'valeur plausible entre 1,5 et 6'
      return undefined
    },
  },
  {
    key: 'rssiWindow',
    label: 'Mesures lissées',
    help:
      'Nombre de relevés moyennés. Plus haut = distance plus stable mais plus lente à ' +
      'suivre un déplacement.',
    kind: 'nombre',
    defaultValue: '12',
    group: 'Estimation de distance',
    validate: positif('la fenêtre'),
  },
  {
    key: 'lanPollMs',
    label: 'Période d’interrogation du relay (ms)',
    help: 'Intervalle entre deux demandes de la liste des salles.',
    kind: 'nombre',
    defaultValue: '8000',
    group: 'Découverte',
    validate: positif('la période'),
  },
  {
    key: 'roomListTimeoutMs',
    label: 'Délai d’attente du relay (ms)',
    help: 'Au-delà, le relay est déclaré injoignable.',
    kind: 'nombre',
    defaultValue: '4000',
    group: 'Découverte',
    validate: positif('le délai'),
  },
]

const PREFIX = 'ttd.cfg.'

function spec(key: string): SettingSpec {
  const found = SETTINGS.find((s) => s.key === key)
  if (!found) throw new Error(`réglage inconnu : ${key}`)
  return found
}

/** Valeur courante, brute. */
export function setting(key: string): string {
  const stored = globalThis.localStorage?.getItem(PREFIX + key)
  return stored ?? spec(key).defaultValue
}

/** Valeur courante, en nombre. Retombe sur le défaut si la saisie est cassée. */
export function settingNumber(key: string): number {
  const n = Number(setting(key))
  return Number.isFinite(n) ? n : Number(spec(key).defaultValue)
}

/** Ce réglage a-t-il été modifié ? Sert à le signaler dans l'interface. */
export function isCustom(key: string): boolean {
  const stored = globalThis.localStorage?.getItem(PREFIX + key)
  return stored !== null && stored !== undefined && stored !== spec(key).defaultValue
}

/**
 * Enregistre une valeur.
 *
 * Une chaîne vide rétablit le défaut plutôt que de stocker du vide : sans
 * cela, effacer un champ produisait une valeur invalide que rien ne
 * rattrapait.
 *
 * @returns un message d'erreur si la saisie est refusée.
 */
export function setSetting(key: string, value: string): string | undefined {
  const s = spec(key)
  const clean = value.trim()
  if (clean === '') {
    globalThis.localStorage?.removeItem(PREFIX + key)
    return undefined
  }
  const erreur = s.validate?.(clean)
  if (erreur) return erreur
  globalThis.localStorage?.setItem(PREFIX + key, clean)
  return undefined
}

/** Rétablit tous les défauts. */
export function resetSettings(): void {
  for (const s of SETTINGS) globalThis.localStorage?.removeItem(PREFIX + s.key)
}

/** Réglages regroupés, dans l'ordre de déclaration. */
export function groupedSettings(): Array<[string, SettingSpec[]]> {
  const groups = new Map<string, SettingSpec[]>()
  for (const s of SETTINGS) {
    const list = groups.get(s.group) ?? []
    list.push(s)
    groups.set(s.group, list)
  }
  return [...groups.entries()]
}
