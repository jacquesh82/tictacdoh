import { type Seat, type TickInputs, type TransportCaps, netRateFor, redundancyFor } from '@ttd/core'

/** Rythme du jeu. Détermine s'il est jouable sur un lien donné. */
export type GamePace = 'turnBased' | 'realtime'

export interface MiniGameMeta {
  readonly id: string
  readonly name: string
  readonly minPlayers: number
  readonly maxPlayers: number
  /** Cadence de simulation, en hertz. */
  readonly tickRate: number
  /** Octets d'input par joueur et par tick. Chaque octet se paie sur BLE. */
  readonly inputBytes: number
  readonly pace: GamePace
  /** Durée indicative d'une manche, en secondes. */
  readonly durationSec: number
}

export interface GameResult {
  /** Sièges classés, du premier au dernier. */
  readonly ranking: readonly Seat[]
  readonly reason: string
}

/**
 * Un mini-jeu.
 *
 * **Règle dure : `tick` doit être déterministe.** Mêmes état et mêmes inputs
 * doivent donner exactement le même état suivant, sur toutes les plateformes.
 * Concrètement : virgule fixe (`fx`), `Rng` seedé, et jamais `Math.random`,
 * `Date.now` ni de flottant dans la simulation. Le socle transmet des inputs,
 * pas des états — un jeu non déterministe diverge silencieusement, et le
 * contrôle d'empreinte ne fait alors que constater les dégâts.
 */
export interface MiniGame<S> {
  readonly meta: MiniGameMeta

  /** État initial. `seed` est partagé par tous les pairs. */
  create(seats: readonly Seat[], seed: number): S

  /** Avance d'un tick. Muté en place, pour éviter d'allouer 30 fois par seconde. */
  tick(state: S, inputs: TickInputs): void

  /** Résultat si la manche est finie, `null` sinon. */
  isOver(state: S): GameResult | null

  /**
   * Empreinte de l'état, sur 32 bits.
   *
   * Sert à détecter une divergence entre pairs. Doit couvrir tout ce que
   * `tick` lit — un champ oublié ici, c'est une désync qui passe inaperçue.
   */
  hash(state: S): number

  /** Sérialise pour un keyframe. */
  encode(state: S): Uint8Array
  decode(bytes: Uint8Array): S
}

/**
 * Ce mini-jeu est-il jouable sur ce lien ?
 *
 * Le lobby s'en sert pour griser ce qui ne passera pas plutôt que de laisser
 * un joueur lancer une partie injouable. Un jeu temps réel demande un débit
 * qu'un lien BLE n'a pas — mieux vaut le dire avant.
 */
export function isPlayableOn(meta: MiniGameMeta, caps: TransportCaps): boolean {
  if (meta.pace === 'turnBased') return true
  return estimatedBytesPerSec(meta, caps) <= caps.throughputBytesPerSec * 0.7
}

/**
 * Débit qu'un mini-jeu consommerait sur ce lien, en octets par seconde.
 *
 * Dérivé des mêmes fonctions que le netcode — et non d'une formule parallèle.
 * Une seconde estimation finirait par diverger de ce que le réseau fait
 * vraiment, et le lobby grisserait alors des jeux parfaitement jouables (ou
 * pire, en laisserait passer qui ne le sont pas).
 *
 * Compte le lien le plus chargé, celui de l'hôte, qui parle à tous les autres.
 */
export function estimatedBytesPerSec(meta: MiniGameMeta, caps: TransportCaps): number {
  const netRate = netRateFor(caps)
  const redundancy = redundancyFor(caps)
  const others = Math.max(1, meta.maxPlayers - 1)

  // En-têtes : 1 octet de type, ~2 de numéro de tick, 1 de compteur, 1 de
  // masque de sièges pour le lot diffusé.
  const batchBytes = 5 + redundancy * meta.maxPlayers * meta.inputBytes
  const inputBytes = 4 + redundancy * meta.inputBytes
  return (batchBytes + inputBytes) * others * netRate
}

/** Raison lisible pour laquelle un jeu est indisponible, si c'est le cas. */
export function unplayableReason(meta: MiniGameMeta, caps: TransportCaps): string | undefined {
  if (isPlayableOn(meta, caps)) return undefined
  return `« ${meta.name} » demande plus de débit que le lien ${caps.kind} n’en offre`
}

/** Combinaison d'empreintes, façon FNV-1a. */
export function hashCombine(hash: number, value: number): number {
  let out = hash ^ (value | 0)
  out = Math.imul(out, 0x01000193) >>> 0
  return out
}

export const HASH_SEED = 0x811c9dc5

/** Empreinte d'une suite d'entiers. */
export function hashInts(values: Iterable<number>): number {
  let hash = HASH_SEED
  for (const value of values) hash = hashCombine(hash, value)
  return hash >>> 0
}

/**
 * Vérifie qu'un état de jeu ne contient aucun flottant.
 *
 * Écrit après avoir trouvé `x: 33333,333…` dans une partie réelle : le
 * placement initial divisait la largeur du terrain par le nombre de joueurs, et
 * seul le cas à quatre tombait juste. Rien ne l'avait signalé, parce qu'un
 * flottant reste parfaitement déterministe *au sein d'un même moteur* — la
 * divergence n'apparaît qu'entre V8 sur Android et JavaScriptCore sur iOS,
 * c'est-à-dire exactement le cas que le socle doit couvrir.
 *
 * À appeler dans les tests de chaque mini-jeu, pour chaque nombre de joueurs.
 *
 * @returns les chemins fautifs, vide si l'état est sain.
 */
export function findFloats(state: unknown, path = 'state'): string[] {
  const faults: string[] = []
  const seen = new Set<unknown>()

  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) faults.push(`${at} = ${value}`)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`))
      return
    }
    for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`)
  }

  walk(state, path)
  return faults
}

/** Variante levante, pour un usage direct en test. */
export function assertNoFloats(state: unknown): void {
  const faults = findFloats(state)
  if (faults.length > 0) {
    throw new Error(
      `état non déterministe — flottant(s) détecté(s) : ${faults.join(', ')}. ` +
        `Toute la simulation doit rester en virgule fixe : deux moteurs JavaScript ` +
        `différents divergeraient.`,
    )
  }
}
