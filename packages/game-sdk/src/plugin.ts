import type { Seat } from '@ttd/core'
import type { Fx } from './fx.js'
import type { MiniGame, MiniGameMeta } from './minigame.js'

/**
 * Contrat de plugin d'un mini-jeu.
 *
 * `MiniGame` ne décrit que la simulation — ticker, hacher, sérialiser. C'est
 * volontaire : le netcode n'a pas à savoir à quoi ressemble un jeu. Mais du
 * coup, tout le reste (dessiner, câbler les touches, dimensionner la surface)
 * finissait dans l'application, qui connaissait alors les constantes internes
 * d'Esquive. Ajouter un deuxième jeu aurait voulu dire modifier l'app.
 *
 * Le plugin rassemble ce qui manquait. Un jeu devient un paquet autonome que
 * l'application charge sans rien savoir de lui.
 *
 * ## Ce que le plugin ne fait pas
 *
 * Il ne touche ni au DOM, ni au réseau, ni au canevas. Le rendu passe par
 * `Painter`, qui parle en unités de terrain : un jeu ne connaît donc jamais la
 * taille de l'écran, ce qui garantit qu'il s'affiche pareil partout et le rend
 * testable sans navigateur.
 */
export interface GamePlugin<S = unknown> {
  readonly game: MiniGame<S>

  /**
   * Dimensions du terrain, en unités de jeu.
   *
   * L'affichage s'y adapte, jamais l'inverse : c'est ce qui garantit qu'un
   * écran large n'offre pas plus d'espace de manœuvre qu'un écran étroit.
   */
  readonly field: Field

  /** Ce que le jeu propose, en une phrase, pour l'écran de choix. */
  readonly pitch: string

  /** Actions jouables. Le câblage clavier et tactile en découle. */
  readonly actions: readonly GameAction[]

  /** Dessine l'état. Ne doit jamais le modifier. */
  render(painter: Painter, state: S, view: GameView): void
}

export interface Field {
  readonly width: Fx
  readonly height: Fx
}

/** Rapport largeur/hauteur, pour dimensionner la surface d'affichage. */
export function fieldAspect(field: Field): number {
  return field.width / field.height
}

/**
 * Une action du jeu.
 *
 * Le jeu déclare ses actions ; l'application les câble. Sans cela, la table
 * des touches vivait dans l'application et parlait de « gauche » et « droite »
 * — deux notions qui n'ont aucun sens pour un jeu de rythme ou de quiz.
 */
export interface GameAction {
  /** Bit levé dans l'octet d'input quand l'action est active. */
  readonly bit: number

  /** Nom affiché dans l'aide-mémoire. */
  readonly label: string

  /**
   * Touches par siège, index = siège.
   *
   * Plusieurs sièges peuvent jouer sur le même clavier : chacun a donc ses
   * touches. Une seule table partagée ferait bouger les quatre joueurs
   * ensemble. Les variantes AZERTY/QWERTY d'une même position se listent
   * ensemble (`['q', 'a']`).
   */
  readonly keysBySeat: ReadonlyArray<readonly string[]>

  /**
   * Zone tactile déclenchant l'action, en fractions de la surface [0..1].
   *
   * Exprimée sur la surface de commande et non sur le terrain : en paysage le
   * terrain n'occupe qu'un quart de la largeur, et des zones calées dessus
   * deviendraient trop étroites pour être visées sans regarder.
   *
   * Absente si l'action n'est pas jouable au doigt.
   */
  readonly touchZone?: TouchZone
}

export interface TouchZone {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Ce que le rendu sait de la partie, en plus de l'état. */
export interface GameView {
  /** Siège du joueur devant cet écran. Absent en spectateur. */
  readonly localSeat?: Seat
  /** Couleur d'un siège. Commune à tous les jeux, pour rester reconnaissable. */
  color(seat: Seat): string
}

/**
 * Surface de dessin, en unités de terrain.
 *
 * Les coordonnées sont celles du jeu (`Fx`) : la mise à l'échelle, la densité
 * de pixels et le centrage sont l'affaire de l'implémentation. Un jeu qui
 * dessinerait en pixels serait à refaire pour chaque taille d'écran.
 *
 * L'ensemble est délibérément petit. Chaque primitive ajoutée devra être
 * implémentée par toute surface — y compris les fausses, en test.
 */
export interface Painter {
  /** Remplit le terrain entier. */
  fillField(color: string): void

  /** Trace le pourtour du terrain, aux dimensions exactes du jeu. */
  strokeField(color: string): void

  /** Rectangle centré sur (cx, cy). */
  fillRect(cx: Fx, cy: Fx, width: Fx, height: Fx, style: Paint): void

  circle(cx: Fx, cy: Fx, radius: Fx, style: Paint): void

  line(x1: Fx, y1: Fx, x2: Fx, y2: Fx, color: string): void

  /** Texte centré sur (cx, cy). `size` est une hauteur en unités de terrain. */
  text(cx: Fx, cy: Fx, content: string, size: Fx, color: string): void
}

export interface Paint {
  readonly color: string
  /** Opacité, 1 par défaut. */
  readonly alpha?: number
  /** Couleur du liseré, absent si aucun. Sert à marquer le joueur local. */
  readonly outline?: string
}

/**
 * Déclare un plugin.
 *
 * Vérifie ce qu'un plugin mal formé casserait silencieusement : des bits
 * d'action qui se recouvrent produiraient deux actions déclenchées par une
 * seule touche, et un terrain de dimension nulle donnerait une division par
 * zéro au moment de la mise à l'échelle.
 */
export function definePlugin<S>(plugin: GamePlugin<S>): GamePlugin<S> {
  if (plugin.field.width <= 0 || plugin.field.height <= 0) {
    throw new Error(`${plugin.game.meta.id} : terrain de dimension nulle ou négative`)
  }

  let used = 0
  for (const action of plugin.actions) {
    const bit = action.bit
    if (bit <= 0 || (bit & (bit - 1)) !== 0) {
      throw new Error(`${plugin.game.meta.id} : « ${action.label} » n'est pas un bit unique (${bit})`)
    }
    if ((used & bit) !== 0) {
      throw new Error(`${plugin.game.meta.id} : bit ${bit} réutilisé par « ${action.label} »`)
    }
    used |= bit
  }

  // Un input tient sur `inputBytes` octets sur le fil ; une action au-delà
  // serait tronquée à l'encodage et l'action resterait sans effet chez les
  // autres joueurs — une désync très difficile à diagnostiquer.
  const capacity = plugin.game.meta.inputBytes * 8
  if (used >= 2 ** capacity) {
    throw new Error(
      `${plugin.game.meta.id} : les actions dépassent ${capacity} bits ` +
        `(inputBytes = ${plugin.game.meta.inputBytes})`,
    )
  }

  return plugin
}

/** Métadonnées du jeu porté par un plugin. */
export function pluginMeta(plugin: GamePlugin): MiniGameMeta {
  return plugin.game.meta
}

const SEAT_COLORS = ['#5ac8fa', '#ffcc55', '#3ddc97', '#ff8fd0'] as const

/**
 * Couleur d'un siège, commune à tous les jeux.
 *
 * Garder la même d'un mini-jeu à l'autre permet de rester reconnaissable au
 * fil des manches, ce qui compte quand la partie enchaîne des jeux différents.
 */
export function seatColor(seat: Seat): string {
  return SEAT_COLORS[((seat % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length]!
}
