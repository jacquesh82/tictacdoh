import type { TransportKind } from '@ttd/core'
import { isNative, nativePlatform } from './native.js'

/**
 * Identification de l'appareil.
 *
 * Sert à deux choses concrètes : expliquer à l'utilisateur pourquoi tel moyen
 * de communication lui est refusé — « pas de Bluetooth en navigateur » est
 * incompréhensible sans savoir qu'on *est* en navigateur — et documenter les
 * traces quand un test tourne mal sur un appareil qu'on n'a pas sous la main.
 *
 * Tout est déduit de ce que la plateforme déclare. Rien n'est deviné à partir
 * de la taille de l'écran : une fenêtre étroite sur un ordinateur n'en fait pas
 * un téléphone, et l'inverse existe aussi.
 */

export type FormFactor = 'téléphone' | 'tablette' | 'ordinateur' | 'inconnu'

export interface DeviceInfo {
  /** Coquille native ou navigateur. */
  readonly runtime: 'natif' | 'navigateur'
  /** `ios`, `android` ou `web`, tel que Capacitor le rapporte. */
  readonly platform: string
  readonly formFactor: FormFactor
  /** Système d'exploitation, au mieux de ce que le navigateur veut bien dire. */
  readonly os: string
  readonly browser: string
  /** Écran logique, en points CSS. */
  readonly screen: string
  /** Densité de pixels. */
  readonly pixelRatio: number
  readonly touch: boolean
  /** Origine sécurisée : conditionne caméra, presse-papiers et service worker. */
  readonly secureContext: boolean
  /** Nombre de cœurs annoncé, quand il l'est. */
  readonly cores?: number
}

export function deviceInfo(): DeviceInfo {
  const ua = globalThis.navigator?.userAgent ?? ''
  const plat = nativePlatform()

  return {
    runtime: isNative() ? 'natif' : 'navigateur',
    platform: plat,
    formFactor: formFactor(ua, plat),
    os: osName(ua, plat),
    browser: browserName(ua),
    screen: `${globalThis.screen?.width ?? 0} × ${globalThis.screen?.height ?? 0}`,
    pixelRatio: globalThis.devicePixelRatio ?? 1,
    // `maxTouchPoints` plutôt qu'un test d'événement : Chrome expose
    // `ontouchstart` sur un poste fixe dès qu'un écran tactile est branché,
    // et l'inverse — un téléphone sans la propriété — n'existe pas.
    touch: (globalThis.navigator?.maxTouchPoints ?? 0) > 0,
    secureContext: Boolean(globalThis.isSecureContext),
    ...(globalThis.navigator?.hardwareConcurrency
      ? { cores: globalThis.navigator.hardwareConcurrency }
      : {}),
  }
}

function formFactor(ua: string, plat: string): FormFactor {
  if (plat === 'ios') return /iPad/i.test(ua) ? 'tablette' : 'téléphone'
  if (plat === 'android') {
    // Android ne dit pas « tablette ». La convention est que les téléphones
    // annoncent « Mobile » et les tablettes non — c'est fragile, mais c'est
    // tout ce que la plateforme donne.
    return /Mobile/i.test(ua) ? 'téléphone' : 'tablette'
  }
  if (/iPhone|Android.*Mobile|Windows Phone/i.test(ua)) return 'téléphone'
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablette'
  if (/Macintosh|Windows|Linux|CrOS/i.test(ua)) {
    // Un iPad récent se déclare « Macintosh ». Le tactile le trahit : aucun
    // Mac n'expose de points de contact.
    return (globalThis.navigator?.maxTouchPoints ?? 0) > 1 ? 'tablette' : 'ordinateur'
  }
  return 'inconnu'
}

function osName(ua: string, plat: string): string {
  if (plat === 'ios') return iosVersion(ua)
  if (plat === 'android') return androidVersion(ua)
  if (/Windows NT 10/.test(ua)) return 'Windows 10 ou 11'
  if (/Mac OS X/.test(ua)) return 'macOS'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'inconnu'
}

function iosVersion(ua: string): string {
  const m = /OS (\d+)[_.](\d+)/.exec(ua)
  return m ? `iOS ${m[1]}.${m[2]}` : 'iOS'
}

function androidVersion(ua: string): string {
  const m = /Android (\d+(?:\.\d+)?)/.exec(ua)
  return m ? `Android ${m[1]}` : 'Android'
}

function browserName(ua: string): string {
  // L'ordre compte : tous ces navigateurs se déclarent aussi « Safari », et
  // les dérivés de Chrome se déclarent « Chrome ».
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/CriOS\//.test(ua)) return 'Chrome (iOS)'
  if (/FxiOS\//.test(ua)) return 'Firefox (iOS)'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'inconnu'
}

/**
 * Moyens de communication activés par l'utilisateur.
 *
 * Distinct de ce que l'appareil *sait* faire : on peut vouloir couper le
 * Bluetooth alors qu'il est disponible, pour vérifier que le repli fonctionne,
 * ou parce qu'il vide la batterie. Le sélecteur de transport ne proposera que
 * l'intersection des deux.
 */
const PREFS_KEY = 'ttd.transports'

/** Tous coupés serait un piège : on interdit l'ensemble vide. */
const FALLBACK: TransportKind = 'ws'

export function enabledTransports(): Set<TransportKind> {
  const raw = globalThis.localStorage?.getItem(PREFS_KEY)
  if (!raw) return new Set(ALL_TRANSPORTS)
  try {
    const list = JSON.parse(raw) as TransportKind[]
    const set = new Set(list.filter((k) => ALL_TRANSPORTS.includes(k)))
    return set.size > 0 ? set : new Set([FALLBACK])
  } catch {
    // Réglage illisible : on repart de tout activé plutôt que de bloquer.
    return new Set(ALL_TRANSPORTS)
  }
}

export const ALL_TRANSPORTS: readonly TransportKind[] = ['local', 'ws', 'webrtc', 'ble', 'nearby']

export function setTransportEnabled(kind: TransportKind, enabled: boolean): Set<TransportKind> {
  const set = enabledTransports()
  if (enabled) set.add(kind)
  else set.delete(kind)
  // Ne jamais tout couper : l'utilisateur se retrouverait sans aucun moyen de
  // jouer en réseau, sans que rien n'explique pourquoi.
  if (set.size === 0) set.add(FALLBACK)
  globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify([...set]))
  return set
}

export function isTransportEnabled(kind: TransportKind): boolean {
  return enabledTransports().has(kind)
}
