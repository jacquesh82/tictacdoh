import { describe, expect, it } from 'vitest'
import {
  PATH_LOSS_EXPONENT,
  TX_POWER_AT_ONE_METER,
  estimateDistance,
  smoothRssi,
} from '../src/distance.js'

describe('estimateDistance', () => {
  it('rend un mètre pour le RSSI de référence', () => {
    // C'est la définition même de `TX_POWER_AT_ONE_METER` : si ce cas dérive,
    // toutes les autres distances sont décalées d'un facteur constant.
    const e = estimateDistance(TX_POWER_AT_ONE_METER + 0.0001)
    expect(e.meters).toBeCloseTo(1, 3)
  })

  it('éloigne quand le signal faiblit', () => {
    const proche = estimateDistance(-60)
    const loin = estimateDistance(-90)
    expect(loin.meters).toBeGreaterThan(proche.meters)
  })

  it('encadre l’estimation par des bornes cohérentes', () => {
    for (const rssi of [-50, -65, -75, -88, -100]) {
      const e = estimateDistance(rssi)
      expect(e.min, `rssi ${rssi}`).toBeLessThanOrEqual(e.meters)
      expect(e.max, `rssi ${rssi}`).toBeGreaterThanOrEqual(e.meters)
    }
  })

  it('ne prétend pas à une précision qu’il n’a pas', () => {
    // L'écart entre les bornes doit rester visible : des bornes resserrées
    // laisseraient croire à une mesure fiable, ce que le RSSI n'est pas.
    const e = estimateDistance(-80)
    expect(e.max / e.min).toBeGreaterThan(2)
  })

  it('ne rend jamais zéro, même collé à l’émetteur', () => {
    // Une distance nulle ferait diviser par zéro chez l'appelant.
    const e = estimateDistance(-20)
    expect(e.meters).toBeGreaterThan(0)
  })

  it('dégrade la confiance avec le signal', () => {
    expect(estimateDistance(-55).confidence).toBe('bonne')
    expect(estimateDistance(-80).confidence).toBe('moyenne')
    expect(estimateDistance(-95).confidence).toBe('faible')
  })

  it('annonce l’inutilisable plutôt qu’une fausse distance', () => {
    expect(estimateDistance(-100).label).toMatch(/hors de portée/)
  })

  it('donne des paliers qui progressent avec la distance', () => {
    const paliers = [-55, -70, -80].map((r) => estimateDistance(r).label)
    expect(new Set(paliers).size).toBeGreaterThan(1)
  })

  it('respecte un txPower fourni par le matériel', () => {
    // Un émetteur plus puissant à un mètre doit donner une distance plus
    // grande pour le même RSSI reçu.
    const defaut = estimateDistance(-70)
    const puissant = estimateDistance(-70, { txPower: -45 })
    expect(puissant.meters).toBeGreaterThan(defaut.meters)
  })

  it('rapproche quand l’exposant monte', () => {
    const libre = estimateDistance(-80, { pathLossExponent: 2 })
    const encombre = estimateDistance(-80, { pathLossExponent: 3.5 })
    expect(encombre.meters).toBeLessThan(libre.meters)
    expect(PATH_LOSS_EXPONENT).toBeGreaterThan(2)
  })
})

describe('smoothRssi', () => {
  it('rend undefined sans échantillon', () => {
    expect(smoothRssi([])).toBeUndefined()
  })

  it('moyenne simplement quand les mesures sont rares', () => {
    expect(smoothRssi([-60, -70])).toBeCloseTo(-65, 6)
  })

  it('écarte une mesure aberrante', () => {
    // Cas réel : une annonce reçue en pleine atténuation fait chuter le RSSI
    // de 30 dB sur une seule trame. Sans élagage, la distance affichée double.
    const stable = [-65, -66, -64, -65, -66, -64, -65, -65]
    const avecAberration = [...stable.slice(0, 7), -120]
    const ecart = Math.abs(smoothRssi(avecAberration)! - smoothRssi(stable)!)
    expect(ecart).toBeLessThan(3)
  })

  it('suit un déplacement réel', () => {
    // À l'inverse, un éloignement franc doit bien se voir : le lissage ne doit
    // pas être si agressif qu'il masque un vrai mouvement.
    const pres = smoothRssi([-55, -56, -54, -55, -56, -55])!
    const loin = smoothRssi([-85, -86, -84, -85, -86, -85])!
    expect(pres - loin).toBeGreaterThan(25)
  })
})
