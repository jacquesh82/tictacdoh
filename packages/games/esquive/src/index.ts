import type { Seat, TickInputs } from '@ttd/core'
import {
  type Fx,
  type GameResult,
  type MiniGame,
  type MiniGameMeta,
  Rng,
  fx,
  fxClamp,
  hashCombine,
  HASH_SEED,
} from '@ttd/game-sdk'
import { Reader, Writer } from '@ttd/wire'

/**
 * « Esquive » — mini-jeu de validation du socle.
 *
 * Choisi pour être le cas *dur* : temps réel, 1 à 4 joueurs, une décision par
 * tick. Il sollicite la boucle de tick, le flux d'inputs, le budget de bande
 * passante, l'équité du délai et la rotation d'hôte. Un jeu au tour par tour
 * aurait été plus rapide à écrire, mais il n'aurait rien prouvé : quelques
 * messages par partie passent sur n'importe quel transport.
 *
 * Règles : des blocs tombent, on se déplace latéralement, le dernier debout
 * gagne. Toute la simulation est en virgule fixe et en hasard seedé.
 */

/** Largeur du terrain, en unités de jeu. */
export const FIELD_WIDTH: Fx = fx(100)

/**
 * Hauteur du terrain. Les joueurs sont en bas.
 *
 * Format portrait, et non carré : la cible est le téléphone, où un terrain
 * carré n'occupait que 45 % de l'écran. Étirer le rendu à la forme de l'écran
 * aurait été plus simple, mais un appareil allongé aurait alors offert plus
 * d'espace pour esquiver — un avantage matériel dans une partie multijoueur.
 * La forme du terrain est donc la même pour tout le monde, et c'est l'affichage
 * qui s'y adapte.
 */
export const FIELD_HEIGHT: Fx = fx(180)

/** Rapport largeur/hauteur, pour dimensionner la surface d'affichage. */
export const FIELD_ASPECT = 100 / 180

/**
 * Demi-largeur d'un joueur et hauteur de sa ligne.
 *
 * Exportées parce que le rendu doit s'en servir : une position d'affichage
 * codée séparément finit par diverger de celle des collisions, et le joueur
 * est alors touché ailleurs qu'où on le voit.
 */
export const PLAYER_HALF_WIDTH: Fx = fx(3)
export const PLAYER_Y: Fx = FIELD_HEIGHT - fx(6)
const PLAYER_SPEED: Fx = fx(1.4)

export const OBSTACLE_HALF_WIDTH: Fx = fx(4)
export const OBSTACLE_HALF_HEIGHT: Fx = fx(3)
// Vitesses proportionnées à la hauteur du terrain : la durée de chute — et
// donc le temps de réaction laissé au joueur — reste celle d'avant le passage
// au format portrait.
const OBSTACLE_BASE_SPEED: Fx = fx(1.98)
/** Accélération par tranche de 100 ticks, pour que la manche finisse. */
const OBSTACLE_SPEED_RAMP: Fx = fx(0.63)

const SPAWN_INTERVAL_START = 22
const SPAWN_INTERVAL_MIN = 7

/** Bits de l'octet d'input. Un seul octet suffit : c'est tout le budget BLE. */
export const INPUT_LEFT = 0b0000_0001
export const INPUT_RIGHT = 0b0000_0010

export interface EsquivePlayer {
  seat: Seat
  x: Fx
  alive: boolean
  /** Tick de l'élimination. Sert à classer les perdants entre eux. */
  diedAtTick: number
}

export interface Obstacle {
  x: Fx
  y: Fx
}

export interface EsquiveState {
  tick: number
  players: EsquivePlayer[]
  obstacles: Obstacle[]
  /** État du générateur, capturé pour que les keyframes soient exacts. */
  rngState: number
  nextSpawnTick: number
}

export const ESQUIVE_META: MiniGameMeta = {
  id: 'esquive',
  name: 'Esquive',
  minPlayers: 1,
  maxPlayers: 4,
  tickRate: 30,
  inputBytes: 1,
  pace: 'realtime',
  durationSec: 60,
}

function spawnInterval(tick: number): number {
  // Le rythme se resserre : sans cela une partie à quatre bons joueurs ne
  // finirait jamais, et une manche de Mario Party dure une minute.
  const reduced = SPAWN_INTERVAL_START - Math.floor(tick / 120)
  return Math.max(SPAWN_INTERVAL_MIN, reduced)
}

function obstacleSpeed(tick: number): Fx {
  return OBSTACLE_BASE_SPEED + Math.floor(tick / 100) * OBSTACLE_SPEED_RAMP
}

function overlaps(player: EsquivePlayer, obstacle: Obstacle): boolean {
  if (obstacle.y + OBSTACLE_HALF_HEIGHT < PLAYER_Y - PLAYER_HALF_WIDTH) return false
  if (obstacle.y - OBSTACLE_HALF_HEIGHT > PLAYER_Y + PLAYER_HALF_WIDTH) return false
  const dx = player.x - obstacle.x
  const reach = PLAYER_HALF_WIDTH + OBSTACLE_HALF_WIDTH
  return dx > -reach && dx < reach
}

export const esquive: MiniGame<EsquiveState> = {
  meta: ESQUIVE_META,

  create(seats, seed) {
    const rng = new Rng(seed)
    // `Math.round` n'est pas cosmétique : `FIELD_WIDTH / 3` vaut
    // 33333,333… et introduirait un flottant dans l'état. Toute la simulation
    // s'appuie ensuite dessus, et deux moteurs JavaScript différents — V8 sur
    // Android, JavaScriptCore sur iOS — finissent par diverger. C'est
    // exactement le cas iOS/Android que le socle doit couvrir.
    const divisor = seats.length > 1 ? seats.length + 1 : 2
    const spread = Math.round(FIELD_WIDTH / divisor)
    return {
      tick: 0,
      players: seats.map((seat, index) => ({
        seat,
        x: seats.length > 1 ? spread * (index + 1) : spread,
        alive: true,
        diedAtTick: -1,
      })),
      obstacles: [],
      rngState: rng.state,
      nextSpawnTick: SPAWN_INTERVAL_START,
    }
  },

  tick(state, inputs: TickInputs) {
    state.tick++

    // Le générateur est repris à son état exact puis remis dans l'état : c'est
    // ce qui permet à un keyframe de restaurer aussi le hasard à venir.
    const rng = new Rng(0)
    rng.state = state.rngState

    for (const player of state.players) {
      if (!player.alive) continue
      const input = inputs[player.seat]?.[0] ?? 0
      let dx = 0
      if (input & INPUT_LEFT) dx -= PLAYER_SPEED
      if (input & INPUT_RIGHT) dx += PLAYER_SPEED
      player.x = fxClamp(player.x + dx, PLAYER_HALF_WIDTH, FIELD_WIDTH - PLAYER_HALF_WIDTH)
    }

    if (state.tick >= state.nextSpawnTick) {
      const usable = FIELD_WIDTH - 2 * OBSTACLE_HALF_WIDTH
      state.obstacles.push({
        x: OBSTACLE_HALF_WIDTH + rng.nextBelow(usable + 1),
        y: 0,
      })
      state.nextSpawnTick = state.tick + spawnInterval(state.tick)
    }

    const speed = obstacleSpeed(state.tick)
    for (const obstacle of state.obstacles) obstacle.y += speed

    for (const player of state.players) {
      if (!player.alive) continue
      for (const obstacle of state.obstacles) {
        if (!overlaps(player, obstacle)) continue
        player.alive = false
        player.diedAtTick = state.tick
        break
      }
    }

    // Filtrage après collision : un obstacle sorti du terrain doit avoir eu sa
    // chance de toucher au tick où il passe.
    state.obstacles = state.obstacles.filter((o) => o.y - OBSTACLE_HALF_HEIGHT <= FIELD_HEIGHT)
    state.rngState = rng.state
  },

  isOver(state) {
    const alive = state.players.filter((p) => p.alive)
    if (state.players.length > 1 && alive.length > 1) return null
    if (state.players.length === 1 && alive.length === 1) return null

    const ranking = [...state.players]
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1
        // Entre deux éliminés, le plus tardif est mieux classé.
        return b.diedAtTick - a.diedAtTick
      })
      .map((p) => p.seat)

    const result: GameResult = {
      ranking,
      reason: alive.length === 1 ? 'dernier survivant' : 'tout le monde est touché',
    }
    return result
  },

  hash(state) {
    // Doit couvrir tout ce que `tick` lit. Un champ oublié ici, et une désync
    // passe inaperçue jusqu'à ce que deux joueurs voient des parties
    // différentes.
    let hash = hashCombine(HASH_SEED, state.tick)
    hash = hashCombine(hash, state.rngState)
    hash = hashCombine(hash, state.nextSpawnTick)
    for (const player of state.players) {
      hash = hashCombine(hash, player.seat)
      hash = hashCombine(hash, player.x)
      hash = hashCombine(hash, player.alive ? 1 : 0)
      hash = hashCombine(hash, player.diedAtTick)
    }
    for (const obstacle of state.obstacles) {
      hash = hashCombine(hash, obstacle.x)
      hash = hashCombine(hash, obstacle.y)
    }
    return hash >>> 0
  },

  encode(state) {
    const w = new Writer(128)
    w.varuint(state.tick)
    w.u32(state.rngState)
    w.varuint(state.nextSpawnTick)
    w.u8(state.players.length)
    for (const player of state.players) {
      w.u8(player.seat)
      w.varint(player.x)
      w.bool(player.alive)
      w.varint(player.diedAtTick)
    }
    w.varuint(state.obstacles.length)
    for (const obstacle of state.obstacles) {
      w.varint(obstacle.x)
      w.varint(obstacle.y)
    }
    return w.finish()
  },

  decode(bytes) {
    const r = new Reader(bytes)
    const tick = r.varuint()
    const rngState = r.u32()
    const nextSpawnTick = r.varuint()

    const playerCount = r.u8()
    const players: EsquivePlayer[] = []
    for (let i = 0; i < playerCount; i++) {
      players.push({
        seat: r.u8(),
        x: r.varint(),
        alive: r.bool(),
        diedAtTick: r.varint(),
      })
    }

    const obstacleCount = r.varuint()
    const obstacles: Obstacle[] = []
    for (let i = 0; i < obstacleCount; i++) {
      obstacles.push({ x: r.varint(), y: r.varint() })
    }

    return { tick, players, obstacles, rngState, nextSpawnTick }
  },
}

/** Assemble un octet d'input à partir des touches enfoncées. */
export function encodeInput(left: boolean, right: boolean): Uint8Array {
  return new Uint8Array([(left ? INPUT_LEFT : 0) | (right ? INPUT_RIGHT : 0)])
}
