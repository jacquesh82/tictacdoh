/**
 * Arithmétique en virgule fixe.
 *
 * Toute la réplication du socle repose sur le fait que chaque pair simule
 * exactement la même chose à partir des mêmes inputs. Les flottants ne le
 * garantissent pas : l'ordre d'évaluation, les registres étendus et les
 * fonctions transcendantes diffèrent d'un moteur et d'un processeur à l'autre.
 * Un iPhone et un Android divergeraient au bout de quelques centaines de ticks,
 * silencieusement.
 *
 * Les valeurs sont des entiers en millièmes : `1500` vaut 1,5. L'échelle est
 * choisie pour que `a * b` reste dans l'entier sûr — au-delà de 2^53, la
 * multiplication perdrait des bits et le déterminisme avec.
 */

/** Nombre en virgule fixe. Un entier, exprimé en millièmes. */
export type Fx = number

export const FX_SCALE = 1000
export const FX_ONE: Fx = FX_SCALE

/**
 * Magnitude maximale admise.
 *
 * `mul` calcule `a * b` avant de diviser : les deux facteurs doivent tenir sous
 * la racine de 2^53 pour que le produit reste exact.
 */
export const FX_MAX: Fx = 67_108_864 // 2^26

export function fx(value: number): Fx {
  return Math.round(value * FX_SCALE)
}

/** Conversion vers un flottant. **Rendu et affichage uniquement.** */
export function fxToNumber(value: Fx): number {
  return value / FX_SCALE
}

export function fxFromInt(value: number): Fx {
  return value * FX_SCALE
}

/** Partie entière, arrondie vers le bas y compris pour les négatifs. */
export function fxFloor(value: Fx): number {
  return Math.floor(value / FX_SCALE)
}

export function fxRound(value: Fx): number {
  return Math.round(value / FX_SCALE)
}

export function fxMul(a: Fx, b: Fx): Fx {
  // `a * b` est exact tant que les deux tiennent sous 2^26, et la division par
  // une puissance de dix suivie de Math.round est spécifiée au bit près : deux
  // moteurs JavaScript donnent le même résultat.
  return Math.round((a * b) / FX_SCALE)
}

export function fxDiv(a: Fx, b: Fx): Fx {
  if (b === 0) throw new RangeError('division par zéro en virgule fixe')
  return Math.round((a * FX_SCALE) / b)
}

export function fxAbs(value: Fx): Fx {
  return value < 0 ? -value : value
}

export function fxClamp(value: Fx, min: Fx, max: Fx): Fx {
  return value < min ? min : value > max ? max : value
}

export function fxSqrt(value: Fx): Fx {
  if (value < 0) throw new RangeError('racine d’un nombre négatif en virgule fixe')
  // Math.sqrt est correctement arrondi par la norme IEEE-754, donc identique
  // partout. C'est l'une des rares fonctions non triviales sur lesquelles on
  // peut compter d'un moteur à l'autre.
  return Math.round(Math.sqrt(value * FX_SCALE))
}

/** Garde-fou de développement : signale une valeur sortie du domaine sûr. */
export function fxAssertSafe(value: Fx, label = 'valeur'): Fx {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} n’est pas un entier en virgule fixe: ${value}`)
  }
  if (value > FX_MAX || value < -FX_MAX) {
    throw new RangeError(`${label} hors du domaine sûr (±2^26): ${value}`)
  }
  return value
}
