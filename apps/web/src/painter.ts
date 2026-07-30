import type { Fx, GamePlugin, Paint, Painter } from '@ttd/game-sdk'
import { fieldAspect, fxToNumber, seatColor } from '@ttd/game-sdk'

// Réexporté pour que les couleurs de siège restent les mêmes dans le terrain,
// dans le lobby et dans les résultats.
export { seatColor }

/**
 * `Painter` posé sur un canevas 2D.
 *
 * Tout ce qui dépend de l'écran est ici : densité de pixels, mise à l'échelle,
 * centrage. Les jeux n'en savent rien — ils dessinent en unités de terrain, ce
 * qui est la condition pour qu'ils s'affichent identiquement d'un appareil à
 * l'autre.
 */
export class CanvasPainter implements Painter {
  readonly #ctx: CanvasRenderingContext2D
  readonly #scale: number
  readonly #fieldW: number
  readonly #fieldH: number

  private constructor(ctx: CanvasRenderingContext2D, scale: number, width: number, height: number) {
    this.#ctx = ctx
    this.#scale = scale
    this.#fieldW = width
    this.#fieldH = height
  }

  /**
   * Prépare le canevas pour une image et rend la surface de dessin.
   *
   * `undefined` si le contexte 2D est indisponible — ce qui arrive sur un
   * canevas détaché du document, pendant un changement d'écran.
   */
  static frame(canvas: HTMLCanvasElement, plugin: GamePlugin): CanvasPainter | undefined {
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    // Plafonné à 2 : au-delà, le coût de remplissage double sans gain visible,
    // et les téléphones récents annoncent volontiers 3 ou 4.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr
      canvas.height = height * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // Échelle uniforme sur les deux axes : le terrain garde sa forme quelle
    // que soit celle de l'écran. Une échelle par axe l'étirerait, et un
    // appareil allongé offrirait alors plus de place pour manœuvrer.
    const fieldW = fxToNumber(plugin.field.width)
    const fieldH = fxToNumber(plugin.field.height)
    const scale = Math.min(width / fieldW, height / fieldH)
    return new CanvasPainter(ctx, scale, fieldW * scale, fieldH * scale)
  }

  #px(value: Fx): number {
    return fxToNumber(value) * this.#scale
  }

  #apply(style: Paint): void {
    this.#ctx.globalAlpha = style.alpha ?? 1
    this.#ctx.fillStyle = style.color
  }

  fillField(color: string): void {
    this.#ctx.globalAlpha = 1
    this.#ctx.fillStyle = color
    this.#ctx.fillRect(0, 0, this.#fieldW, this.#fieldH)
  }

  strokeField(color: string): void {
    this.#ctx.globalAlpha = 1
    this.#ctx.strokeStyle = color
    this.#ctx.lineWidth = 1
    // Décalage d'un demi-pixel : sans lui, un trait d'un pixel tombe à cheval
    // sur deux et s'affiche flou.
    this.#ctx.strokeRect(0.5, 0.5, this.#fieldW - 1, this.#fieldH - 1)
  }

  fillRect(cx: Fx, cy: Fx, width: Fx, height: Fx, style: Paint): void {
    const w = this.#px(width)
    const h = this.#px(height)
    const x = this.#px(cx) - w / 2
    const y = this.#px(cy) - h / 2
    this.#apply(style)
    this.#ctx.fillRect(x, y, w, h)
    if (style.outline) {
      this.#ctx.globalAlpha = 1
      this.#ctx.strokeStyle = style.outline
      this.#ctx.lineWidth = Math.max(1.5, this.#scale * 0.4)
      this.#ctx.strokeRect(x - 2, y - 2, w + 4, h + 4)
    }
    this.#ctx.globalAlpha = 1
  }

  circle(cx: Fx, cy: Fx, radius: Fx, style: Paint): void {
    this.#apply(style)
    this.#ctx.beginPath()
    this.#ctx.arc(this.#px(cx), this.#px(cy), this.#px(radius), 0, Math.PI * 2)
    this.#ctx.fill()
    if (style.outline) {
      this.#ctx.globalAlpha = 1
      this.#ctx.strokeStyle = style.outline
      this.#ctx.lineWidth = Math.max(1.5, this.#scale * 0.4)
      this.#ctx.stroke()
    }
    this.#ctx.globalAlpha = 1
  }

  line(x1: Fx, y1: Fx, x2: Fx, y2: Fx, color: string): void {
    this.#ctx.globalAlpha = 1
    this.#ctx.strokeStyle = color
    this.#ctx.lineWidth = 1
    this.#ctx.beginPath()
    this.#ctx.moveTo(this.#px(x1), this.#px(y1))
    this.#ctx.lineTo(this.#px(x2), this.#px(y2))
    this.#ctx.stroke()
  }

  text(cx: Fx, cy: Fx, content: string, size: Fx, color: string): void {
    this.#ctx.globalAlpha = 1
    this.#ctx.fillStyle = color
    this.#ctx.font = `${this.#px(size)}px system-ui, sans-serif`
    this.#ctx.textAlign = 'center'
    this.#ctx.textBaseline = 'middle'
    this.#ctx.fillText(content, this.#px(cx), this.#px(cy))
  }
}

/**
 * Transmet au CSS le rapport du terrain déclaré par le jeu.
 *
 * Recopier la valeur dans la feuille de style l'aurait figée sur un seul jeu :
 * le suivant, de forme différente, se serait affiché déformé sans que rien ne
 * le signale.
 */
export function applyFieldAspect(canvas: HTMLCanvasElement, plugin: GamePlugin): void {
  canvas.style.setProperty('--field-aspect', String(fieldAspect(plugin.field)))
}

/** Dessine un état. Le rendu lit l'état, il ne le modifie jamais. */
export function drawGame(
  canvas: HTMLCanvasElement,
  plugin: GamePlugin,
  state: unknown,
  localSeat: number | undefined,
): void {
  const painter = CanvasPainter.frame(canvas, plugin)
  if (!painter) return
  plugin.render(painter, state, {
    ...(localSeat === undefined ? {} : { localSeat }),
    color: seatColor,
  })
}
