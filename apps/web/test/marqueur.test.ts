import { describe, expect, it } from 'vitest'
import { untag } from '../src/device.js'

/**
 * Le marqueur de plateforme voyage dans le nom annoncé, seul champ commun aux
 * deux plateformes. Sa lecture doit être robuste : elle s'applique à des noms
 * saisis par des humains, qui contiennent tout et n'importe quoi.
 */
describe('marqueur de plateforme', () => {
  it('reconnaît les trois plateformes', () => {
    expect(untag('a~Koko')).toEqual({ platform: 'android', name: 'Koko' })
    expect(untag('i~Ada')).toEqual({ platform: 'ios', name: 'Ada' })
    expect(untag('w~Chrome')).toEqual({ platform: 'web', name: 'Chrome' })
  })

  it('rend le nom intact quand aucun marqueur n’est présent', () => {
    // Cas réel : un pair d'une version antérieure, ou un appareil tiers.
    expect(untag('S24 Ultra de jacques')).toEqual({
      platform: 'inconnu',
      name: 'S24 Ultra de jacques',
    })
  })

  it('ne prend pas un tilde plus loin dans le nom pour un marqueur', () => {
    // « Ada~Home » ne doit pas devenir la plateforme « A » et le nom « da~Home ».
    expect(untag('Ada~Home')).toEqual({ platform: 'inconnu', name: 'Ada~Home' })
  })

  it('ignore un marqueur inconnu plutôt que d’inventer', () => {
    expect(untag('z~Machin')).toEqual({ platform: 'inconnu', name: 'z~Machin' })
  })

  it('accepte un nom vide après le marqueur', () => {
    expect(untag('a~')).toEqual({ platform: 'android', name: '' })
  })

  it('tolère une chaîne vide', () => {
    expect(untag('')).toEqual({ platform: 'inconnu', name: '' })
  })

  it('accepte un marqueur en majuscule', () => {
    expect(untag('I~Ada').platform).toBe('ios')
  })
})
