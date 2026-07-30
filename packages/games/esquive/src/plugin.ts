import { type GamePlugin, definePlugin } from '@ttd/game-sdk'
import {
  type EsquiveState,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  INPUT_LEFT,
  INPUT_RIGHT,
  OBSTACLE_HALF_HEIGHT,
  OBSTACLE_HALF_WIDTH,
  PLAYER_HALF_WIDTH,
  PLAYER_Y,
  esquive,
} from './index.js'

/**
 * Esquive, sous forme de plugin.
 *
 * Le rendu vit ici plutôt que dans l'application, et c'est ce qui compte : il
 * lit les mêmes constantes que les collisions. Quand il était de l'autre côté,
 * l'application importait `OBSTACLE_HALF_WIDTH` pour dessiner à la bonne
 * taille — un couplage qui tenait tant qu'il n'y avait qu'un jeu, et qui
 * aurait obligé à modifier l'app pour en ajouter un second.
 */
export const esquivePlugin: GamePlugin<EsquiveState> = definePlugin<EsquiveState>({
  game: esquive,

  field: { width: FIELD_WIDTH, height: FIELD_HEIGHT },

  pitch: 'Des blocs tombent, vous glissez de gauche à droite. Le dernier debout gagne.',

  actions: [
    {
      bit: INPUT_LEFT,
      label: 'Gauche',
      // Une rangée par siège, de gauche à droite sur le clavier, pour que
      // quatre personnes tiennent devant le même écran. Les variantes AZERTY
      // et QWERTY d'une même position sont listées ensemble.
      keysBySeat: [['arrowleft'], ['q', 'a'], ['f'], ['j']],
      touchZone: { x: 0, y: 0, width: 0.5, height: 1 },
    },
    {
      bit: INPUT_RIGHT,
      label: 'Droite',
      keysBySeat: [['arrowright'], ['d'], ['h'], ['l']],
      touchZone: { x: 0.5, y: 0, width: 0.5, height: 1 },
    },
  ],

  render(painter, state, view) {
    painter.fillField('rgba(127,142,168,0.05)')
    painter.strokeField('rgba(127,142,168,0.45)')

    // Ligne de sol : marque la hauteur exacte où se jouent les collisions.
    // Sans elle, le joueur ne sait pas où son carré sera touché.
    const groundY = PLAYER_Y + PLAYER_HALF_WIDTH
    painter.line(0, groundY, FIELD_WIDTH, groundY, 'rgba(127,142,168,0.28)')

    // Dimensions tirées de la simulation, jamais recopiées : un obstacle
    // dessiné plus petit que sa boîte de collision ferait perdre des joueurs
    // sans qu'ils comprennent pourquoi.
    for (const obstacle of state.obstacles) {
      painter.fillRect(obstacle.x, obstacle.y, OBSTACLE_HALF_WIDTH * 2, OBSTACLE_HALF_HEIGHT * 2, {
        color: '#7f8ea8',
      })
    }

    const size = PLAYER_HALF_WIDTH * 2
    for (const player of state.players) {
      const local = player.seat === view.localSeat && player.alive
      painter.fillRect(player.x, PLAYER_Y, size, size, {
        color: view.color(player.seat),
        alpha: player.alive ? 1 : 0.22,
        // Repère du joueur local : à quatre carrés de teintes proches, on perd
        // le sien de vue en une seconde.
        ...(local ? { outline: '#ffffff' } : {}),
      })
    }
  },
})
