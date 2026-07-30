/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 *
 * Toute la réplication du socle repose sur le fait que chaque pair simule la
 * même chose à partir des mêmes inputs. Un `Math.random` dans la simulation
 * casserait cette égalité au premier tick. Ce générateur est donc le seul
 * hasard autorisé côté jeu, et il n'opère qu'en entiers 32 bits non signés :
 * aucun flottant, donc aucune divergence possible entre plateformes.
 */
export class Rng {
  #state: number

  constructor(seed: number) {
    this.#state = seed >>> 0
  }

  /** Entier non signé sur 32 bits. */
  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  /** Entier dans [0, bound). Rejette les tirages biaisés plutôt que d'utiliser un modulo. */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) throw new RangeError(`borne invalide: ${bound}`)
    // Le modulo brut favorise les petites valeurs quand 2^32 n'est pas un
    // multiple de la borne. On rejette la queue pour rester uniforme — au
    // même coût pour tous les pairs, donc toujours déterministe.
    const limit = Math.floor(0x1_0000_0000 / bound) * bound
    let draw = this.nextUint32()
    while (draw >= limit) draw = this.nextUint32()
    return draw % bound
  }

  /** Mélange en place (Fisher-Yates). Même graine, même ordre, sur tous les pairs. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextBelow(i + 1)
      const a = items[i]!
      items[i] = items[j]!
      items[j] = a
    }
    return items
  }

  /** État courant, pour capturer le hasard dans un keyframe. */
  get state(): number {
    return this.#state
  }

  set state(value: number) {
    this.#state = value >>> 0
  }
}

/** Graine entière dérivée d'une chaîne (FNV-1a 32 bits). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
