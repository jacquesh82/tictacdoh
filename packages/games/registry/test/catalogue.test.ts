import { describe, expect, it } from 'vitest'
import type { Fx, GamePlugin, Paint, Painter } from '@ttd/game-sdk'
import { assertNoFloats, definePlugin, fieldAspect, seatColor } from '@ttd/game-sdk'
import { PROFILES } from '@ttd/netsim'
import { CATALOGUE, DEFAULT_GAME_ID, gameById, offers, resolveGame } from '../src/index.js'

/** Surface d'essai : enregistre les appels au lieu de dessiner. */
class FakePainter implements Painter {
  readonly calls: string[] = []

  fillField(color: string): void {
    this.calls.push(`fillField:${color}`)
  }
  strokeField(color: string): void {
    this.calls.push(`strokeField:${color}`)
  }
  fillRect(cx: Fx, cy: Fx, w: Fx, h: Fx, style: Paint): void {
    this.calls.push(`fillRect:${cx},${cy},${w},${h},${style.color}`)
  }
  circle(cx: Fx, cy: Fx, r: Fx, style: Paint): void {
    this.calls.push(`circle:${cx},${cy},${r},${style.color}`)
  }
  line(x1: Fx, y1: Fx, x2: Fx, y2: Fx, color: string): void {
    this.calls.push(`line:${x1},${y1},${x2},${y2},${color}`)
  }
  text(cx: Fx, cy: Fx, content: string, size: Fx, color: string): void {
    this.calls.push(`text:${cx},${cy},${content},${size},${color}`)
  }
}

describe('catalogue', () => {
  it('n’expose que des identifiants distincts', () => {
    const ids = CATALOGUE.map((plugin) => plugin.game.meta.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('propose un jeu par défaut qui existe', () => {
    expect(gameById(DEFAULT_GAME_ID)).toBeDefined()
  })

  it('retombe sur un jeu connu quand l’identifiant est inconnu', () => {
    // Cas réel : un pair d'une version plus récente lance un jeu que
    // celle-ci n'a pas. Bloquer serait pire, mais il faut pouvoir le dire.
    const { plugin, exact } = resolveGame('jeu-du-futur')
    expect(exact).toBe(false)
    expect(plugin).toBe(CATALOGUE[0])
  })

  it('signale un identifiant connu comme exact', () => {
    expect(resolveGame(DEFAULT_GAME_ID).exact).toBe(true)
  })

  it('confronte le catalogue aux capacités du lien', () => {
    for (const offer of offers(PROFILES.wifi.caps)) {
      expect(offer.playable, `${offer.plugin.game.meta.id} en Wi-Fi`).toBe(true)
      expect(offer.reason).toBeUndefined()
    }
    // Le budget BLE est la contrainte de référence du socle : si un jeu n'y
    // tient pas, le lobby doit l'annoncer plutôt que de le laisser lancer.
    for (const offer of offers(PROFILES.ble.caps)) {
      if (!offer.playable) expect(offer.reason).toMatch(/débit/)
    }
  })
})

describe.each(CATALOGUE.map((plugin) => [plugin.game.meta.id, plugin] as const))(
  'plugin « %s »',
  (_id, plugin: GamePlugin) => {
    const meta = plugin.game.meta

    it('déclare un terrain de rapport exploitable', () => {
      expect(plugin.field.width).toBeGreaterThan(0)
      expect(plugin.field.height).toBeGreaterThan(0)
      const aspect = fieldAspect(plugin.field)
      expect(Number.isFinite(aspect)).toBe(true)
      expect(aspect).toBeGreaterThan(0)
    })

    it('tient ses actions dans le budget d’input annoncé', () => {
      let used = 0
      for (const action of plugin.actions) {
        expect(used & action.bit, `bit ${action.bit} réutilisé`).toBe(0)
        used |= action.bit
      }
      expect(used).toBeLessThan(2 ** (meta.inputBytes * 8))
    })

    it('câble une touche par siège jouable', () => {
      // Une action sans touche pour le siège 3 rendrait le jeu à quatre
      // injouable sur un écran partagé, sans que rien ne le signale.
      for (const action of plugin.actions) {
        expect(action.keysBySeat.length, `« ${action.label} »`).toBeGreaterThanOrEqual(
          meta.maxPlayers,
        )
        for (const keys of action.keysBySeat.slice(0, meta.maxPlayers)) {
          expect(keys.length).toBeGreaterThan(0)
        }
      }
    })

    it('n’attribue jamais la même touche à deux sièges', () => {
      const vus = new Map<string, string>()
      for (const action of plugin.actions) {
        action.keysBySeat.slice(0, meta.maxPlayers).forEach((keys, seat) => {
          for (const key of keys) {
            const proprietaire = `siège ${seat}, ${action.label}`
            expect(vus.get(key), `touche « ${key} » déjà prise par ${vus.get(key)}`).toBeUndefined()
            vus.set(key, proprietaire)
          }
        })
      }
    })

    it('dessine sans lire l’écran ni modifier l’état', () => {
      const seats = Array.from({ length: meta.maxPlayers }, (_, i) => i)
      const state = plugin.game.create(seats, 1234)
      const avant = JSON.stringify(state)

      const painter = new FakePainter()
      plugin.render(painter, state, { localSeat: 0, color: seatColor })

      expect(painter.calls.length).toBeGreaterThan(0)
      // Le rendu lit l'état ; s'il le modifiait, les pairs divergeraient selon
      // qu'ils affichent la partie ou non — un onglet en arrière-plan suffirait.
      expect(JSON.stringify(state)).toBe(avant)
    })

    it('dessine aussi sans joueur local', () => {
      const state = plugin.game.create([0, 1], 7)
      const painter = new FakePainter()
      expect(() => plugin.render(painter, state, { color: seatColor })).not.toThrow()
    })

    it('crée un état sans flottant, quel que soit le nombre de joueurs', () => {
      for (let n = meta.minPlayers; n <= meta.maxPlayers; n++) {
        const seats = Array.from({ length: n }, (_, i) => i)
        expect(() => assertNoFloats(plugin.game.create(seats, 99)), `à ${n} joueurs`).not.toThrow()
      }
    })
  },
)

describe('definePlugin', () => {
  const base = CATALOGUE[0]!

  it('refuse deux actions sur le même bit', () => {
    expect(() =>
      definePlugin({
        ...base,
        actions: [
          { bit: 1, label: 'A', keysBySeat: [['a']] },
          { bit: 1, label: 'B', keysBySeat: [['b']] },
        ],
      }),
    ).toThrow(/réutilisé/)
  })

  it('refuse une action qui n’est pas un bit unique', () => {
    expect(() =>
      definePlugin({ ...base, actions: [{ bit: 3, label: 'A', keysBySeat: [['a']] }] }),
    ).toThrow(/bit unique/)
  })

  it('refuse des actions au-delà du budget d’input', () => {
    // Un bit hors budget serait tronqué à l'encodage : l'action resterait sans
    // effet chez les autres joueurs, et la désync serait indétectable à l'œil.
    expect(() =>
      definePlugin({ ...base, actions: [{ bit: 2 ** 9, label: 'Trop', keysBySeat: [['a']] }] }),
    ).toThrow(/dépassent/)
  })

  it('refuse un terrain de dimension nulle', () => {
    expect(() => definePlugin({ ...base, field: { width: 0, height: 10 } })).toThrow(/nulle/)
  })
})
