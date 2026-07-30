import type { GameAction, GamePlugin, TouchZone } from '@ttd/game-sdk'

export { applyFieldAspect, drawGame, seatColor } from './painter.js'

export interface InputSource {
  /** Octet d'input du joueur `index`, lu à chaque tick. */
  read(index: number): number
  /** Aide-mémoire des commandes, à afficher sous le terrain. */
  readonly help: string
  dispose(): void
}

function inZone(zone: TouchZone, fx: number, fy: number): boolean {
  return fx >= zone.x && fx < zone.x + zone.width && fy >= zone.y && fy < zone.y + zone.height
}

/**
 * Clavier et tactile, câblés depuis les actions déclarées par le jeu.
 *
 * Rien ici ne connaît de mini-jeu en particulier : ni « gauche », ni « saut »,
 * ni le moindre bit d'input. Le jeu déclare ses actions, cette fonction les
 * branche. C'est ce qui permet d'ajouter un jeu aux commandes différentes sans
 * revenir dans l'application.
 *
 * L'état des touches est *lu* à chaque tick plutôt que poussé sur événement :
 * le netcode réclame l'input à l'instant du tick, ce qui reste juste même si
 * l'affichage tourne plus vite ou plus lentement que la simulation.
 *
 * @param target surface qui capte le doigt. Passer la scène entière plutôt que
 *   le terrain : en paysage celui-ci n'occupe qu'un quart de la largeur, et les
 *   zones de commande deviendraient trop étroites pour être visées sans
 *   regarder.
 */
export function attachLocalInputs(
  target: HTMLElement,
  plugin: GamePlugin,
  playerCount: number,
): InputSource {
  const seats = Math.max(1, Math.min(plugin.game.meta.maxPlayers, playerCount))
  const held = new Set<string>()
  /** Actions maintenues par chaque doigt posé. */
  const touches = new Map<number, number>()

  // Table inverse touche → action, construite une fois : la parcourir à chaque
  // événement clavier coûterait un balayage complet des actions par frappe.
  const byKey = new Map<string, Array<{ action: GameAction; seat: number }>>()
  for (const action of plugin.actions) {
    action.keysBySeat.slice(0, seats).forEach((keys, seat) => {
      for (const key of keys) {
        const list = byKey.get(key) ?? []
        list.push({ action, seat })
        byKey.set(key, list)
      }
    })
  }

  const onKey = (event: KeyboardEvent, down: boolean) => {
    const key = event.key.toLowerCase()
    if (!byKey.has(key)) return
    event.preventDefault()
    if (down) held.add(key)
    else held.delete(key)
  }
  const keyDown = (event: KeyboardEvent) => onKey(event, true)
  const keyUp = (event: KeyboardEvent) => onKey(event, false)

  /** Bits déclenchés par un doigt posé à cet endroit. */
  const bitsAt = (event: PointerEvent): number => {
    const rect = target.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return 0
    const fx = (event.clientX - rect.left) / rect.width
    const fy = (event.clientY - rect.top) / rect.height
    let bits = 0
    for (const action of plugin.actions) {
      if (action.touchZone && inZone(action.touchZone, fx, fy)) bits |= action.bit
    }
    return bits
  }

  // Un appui commencé sur une surimpression — un bouton, un panneau — ne doit
  // pas être pris pour une commande de jeu.
  const surJeu = (event: PointerEvent): boolean =>
    !(event.target instanceof Element) || !event.target.closest('button, a, input, .sheet')

  const pointerDown = (event: PointerEvent) => {
    if (!surJeu(event)) return
    target.setPointerCapture(event.pointerId)
    touches.set(event.pointerId, bitsAt(event))
  }
  const pointerMove = (event: PointerEvent) => {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, bitsAt(event))
  }
  const pointerUp = (event: PointerEvent) => void touches.delete(event.pointerId)

  globalThis.addEventListener('keydown', keyDown)
  globalThis.addEventListener('keyup', keyUp)
  target.addEventListener('pointerdown', pointerDown)
  target.addEventListener('pointermove', pointerMove)
  target.addEventListener('pointerup', pointerUp)
  target.addEventListener('pointercancel', pointerUp)

  const seatHelp = (seat: number): string =>
    plugin.actions
      .map((action) => action.keysBySeat[seat]?.[0]?.replace('arrow', '') ?? '')
      .filter(Boolean)
      .join('/')

  const touchable = plugin.actions.filter((action) => action.touchZone).length > 0
  const help =
    Array.from({ length: seats }, (_, seat) => `Joueur ${seat + 1} : ${seatHelp(seat)}`)
      .filter((line) => !line.endsWith(': '))
      .join(' · ') + (touchable ? ' · au doigt, zones de l’écran pour le joueur 1' : '')

  return {
    help,
    read(index) {
      let bits = 0
      for (const [key, entries] of byKey) {
        if (!held.has(key)) continue
        for (const entry of entries) {
          if (entry.seat === index) bits |= entry.action.bit
        }
      }
      // Le tactile ne pilote que le premier joueur : sur un téléphone, il n'y
      // a qu'une personne devant l'écran.
      if (index === 0) {
        for (const touchBits of touches.values()) bits |= touchBits
      }
      return bits
    },
    dispose() {
      globalThis.removeEventListener('keydown', keyDown)
      globalThis.removeEventListener('keyup', keyUp)
      target.removeEventListener('pointerdown', pointerDown)
      target.removeEventListener('pointermove', pointerMove)
      target.removeEventListener('pointerup', pointerUp)
      target.removeEventListener('pointercancel', pointerUp)
    },
  }
}
