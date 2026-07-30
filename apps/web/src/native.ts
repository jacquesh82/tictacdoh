import { Capacitor, registerPlugin } from '@capacitor/core'
import type { BleMeshPlugin } from '@ttd/transport-ble'
import type { NearbyPlugin } from '@ttd/transport-nearby'
import type { ProbeResult } from '@ttd/transport-select'

/**
 * Plugins natifs, vus depuis le TypeScript.
 *
 * `registerPlugin` rend un mandataire même sur le web : les appels y échouent
 * proprement au lieu de faire planter le chargement. C'est ce qui permet au
 * même code de tourner dans un navigateur et dans la coquille native.
 */
export const BleMesh = registerPlugin<BleMeshPlugin>('BleMesh')

/**
 * Transport « à proximité ».
 *
 * Un seul mandataire pour deux technologies qui ne se parlent pas : Nearby
 * Connections sur Android, MultipeerConnectivity sur iOS. Le TypeScript ne fait
 * pas la différence — c'est tout l'intérêt du contrat.
 */
export const Nearby = registerPlugin<NearbyPlugin>('Nearby')

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export function nativePlatform(): string {
  return Capacitor.getPlatform()
}

/**
 * Sonde le Bluetooth par le plugin natif.
 *
 * Contrairement au reste de la page de diagnostic, cette mesure ne vient pas
 * d'une simulation : elle traverse le pont Capacitor, atteint la pile
 * Bluetooth d'Android et rapporte son état réel. C'est le seul moyen de savoir
 * si le Bluetooth est allumé, si les permissions sont accordées, et si
 * l'appareil sait s'annoncer.
 */
export async function probeNativeBle(): Promise<ProbeResult> {
  if (!isNative()) {
    return { reachable: false, reason: 'Bluetooth natif indisponible hors de l’application' }
  }
  try {
    const status = await BleMesh.isAvailable()
    if (!status.available) {
      return { reachable: false, reason: status.reason ?? 'Bluetooth éteint' }
    }
    // Aucun correspondant n'est encore cherché : on rapporte que la pile
    // répond. La recherche d'hôtes à portée est une action explicite, elle
    // consomme de la batterie et ne doit pas se déclencher à l'affichage.
    return {
      reachable: true,
      peersFound: 0,
      rttMs: undefined,
      reason: status.canAdvertise
        ? 'pile Bluetooth prête, cet appareil peut héberger'
        : 'pile Bluetooth prête, mais cet appareil ne peut que rejoindre',
    }
  } catch (error) {
    return { reachable: false, reason: `plugin Bluetooth en erreur : ${(error as Error).message}` }
  }
}

/** État détaillé du plugin, pour l'affichage de diagnostic. */
export async function nativeBleStatus(): Promise<string> {
  if (!isNative()) return `plateforme « ${nativePlatform()} » : pas de pont natif`
  try {
    const status = await BleMesh.isAvailable()
    return `pont natif OK · disponible=${status.available} · peut héberger=${status.canAdvertise}${
      status.reason ? ` · ${status.reason}` : ''
    }`
  } catch (error) {
    return `pont natif en erreur : ${(error as Error).message}`
  }
}
