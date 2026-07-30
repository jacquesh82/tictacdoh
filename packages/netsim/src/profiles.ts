import type { TransportCaps } from '@ttd/core'

export interface SimProfile {
  readonly name: string
  readonly caps: TransportCaps
  /** Aller simple, en millisecondes. Le RTT observé vaut le double. */
  readonly latencyMs: number
  /** Amplitude de la variation aléatoire autour de la latence. */
  readonly jitterMs: number
  /**
   * Probabilité qu'un message disparaisse.
   *
   * Réservée aux profils qui annoncent `reliable: false`. Un lien fiable ne
   * perd pas de messages silencieusement — il se coupe, ce qui se simule avec
   * `SimNetwork.cut()`. Mélanger les deux modèles produirait des tests qui
   * passent sur un comportement qui n'existe pas.
   */
  readonly lossRate: number
}

/**
 * Bluetooth Low Energy — le profil de référence du socle.
 *
 * C'est le seul chemin hors-ligne entre iOS et Android, donc la contrainte qui
 * dimensionne tout le reste. Les chiffres sont volontairement pessimistes :
 * mieux vaut un socle qui tient sur un mauvais lien qu'un socle calibré sur un
 * banc d'essai.
 */
export const BLE_PROFILE: SimProfile = {
  name: 'ble',
  caps: {
    kind: 'ble',
    maxPayloadBytes: 180,
    throughputBytesPerSec: 1500,
    rttHintMs: 60,
    maxPeers: 4,
    canAdvertise: true,
    canDiscover: true,
    reliable: true,
    ordered: true,
    requiresInternet: false,
  },
  latencyMs: 30,
  jitterMs: 15,
  lossRate: 0,
}

/** Wi-Fi local, via WebRTC ou Nearby. Confortable. */
export const WIFI_PROFILE: SimProfile = {
  name: 'wifi',
  caps: {
    kind: 'webrtc',
    maxPayloadBytes: 16 * 1024,
    throughputBytesPerSec: 1024 * 1024,
    rttHintMs: 10,
    maxPeers: 4,
    canAdvertise: false,
    canDiscover: false,
    reliable: true,
    ordered: true,
    requiresInternet: false,
  },
  latencyMs: 5,
  jitterMs: 3,
  lossRate: 0,
}

/** Réseau mobile via le relay : latence élevée et très variable. */
export const CELLULAR_PROFILE: SimProfile = {
  name: '4g',
  caps: {
    kind: 'ws',
    maxPayloadBytes: 64 * 1024,
    throughputBytesPerSec: 128 * 1024,
    rttHintMs: 90,
    maxPeers: 4,
    canAdvertise: false,
    canDiscover: false,
    reliable: true,
    ordered: true,
    requiresInternet: true,
  },
  latencyMs: 45,
  jitterMs: 40,
  lossRate: 0,
}

/**
 * Lien dégradé qui perd des messages.
 *
 * Annonce `reliable: false`, ce qui a une conséquence voulue : `Channel` y
 * refuse la fragmentation. Un keyframe ne peut donc pas y passer, et seules
 * les petites trames temps réel circulent — exactement le régime dans lequel
 * on veut vérifier que la redondance des inputs suffit.
 */
export const LOSSY_PROFILE: SimProfile = {
  name: 'lossy',
  caps: {
    kind: 'sim',
    maxPayloadBytes: 180,
    throughputBytesPerSec: 1500,
    rttHintMs: 120,
    maxPeers: 4,
    canAdvertise: true,
    canDiscover: true,
    reliable: false,
    ordered: true,
    requiresInternet: false,
  },
  latencyMs: 60,
  jitterMs: 40,
  lossRate: 0.15,
}

export const PROFILES = {
  ble: BLE_PROFILE,
  wifi: WIFI_PROFILE,
  '4g': CELLULAR_PROFILE,
  lossy: LOSSY_PROFILE,
} as const

export type ProfileName = keyof typeof PROFILES
