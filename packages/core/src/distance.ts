/**
 * Estimation de distance à partir de la puissance reçue (RSSI).
 *
 * ## Ce que ça vaut, et ce que ça ne vaut pas
 *
 * Le modèle est celui de l'affaiblissement logarithmique :
 *
 *     RSSI = txPower − 10·n·log₁₀(d)   ⟹   d = 10^((txPower − RSSI) / 10n)
 *
 * Il est juste en champ libre et **faux dès qu'il y a un obstacle**. Un corps
 * humain entre les deux appareils coûte 10 à 20 dB, ce qui multiplie la
 * distance estimée par deux à dix. L'orientation de l'antenne, une poche, une
 * table métallique produisent le même genre d'écart.
 *
 * On ne rend donc jamais un nombre seul : `min` et `max` encadrent la valeur,
 * et `confidence` dit à quel point il faut s'en méfier. Afficher « 3,2 m »
 * laisserait croire à une précision qui n'existe pas — l'ordre de grandeur est
 * la seule chose réellement exploitable, et c'est suffisant pour répondre à la
 * seule question qui compte : ce joueur est-il dans la pièce ?
 */

/** RSSI typique à un mètre, en dBm. Valeur de référence du BLE. */
export const TX_POWER_AT_ONE_METER = -59

/**
 * Exposant d'affaiblissement.
 *
 * 2 en champ libre, 3 à 3,5 dans un intérieur meublé. On retient 2,7 : le socle
 * vise le salon, pas le hangar.
 */
export const PATH_LOSS_EXPONENT = 2.7

export type DistanceConfidence = 'bonne' | 'moyenne' | 'faible'

export interface DistanceEstimate {
  /** Estimation centrale, en mètres. */
  readonly meters: number
  /** Borne basse plausible, en mètres. */
  readonly min: number
  /** Borne haute plausible, en mètres. */
  readonly max: number
  readonly confidence: DistanceConfidence
  /** Formulation prête à afficher, qui n'exagère pas la précision. */
  readonly label: string
}

export interface DistanceOptions {
  /** RSSI mesuré à un mètre pour ce matériel, s'il est connu. */
  readonly txPower?: number
  readonly pathLossExponent?: number
}

/**
 * Distance estimée pour un RSSI donné.
 *
 * @param rssi puissance reçue, en dBm. Négatif ; plus proche de zéro = plus près.
 */
export function estimateDistance(rssi: number, options: DistanceOptions = {}): DistanceEstimate {
  const txPower = options.txPower ?? TX_POWER_AT_ONE_METER
  const n = options.pathLossExponent ?? PATH_LOSS_EXPONENT

  const meters = distanceFor(rssi, txPower, n)

  // L'incertitude vient surtout de l'exposant, qu'on ne connaît pas : on borne
  // en le faisant varier entre le champ libre et un intérieur chargé.
  //
  // Les bornes sont ensuite ordonnées par rapport à l'estimation centrale, et
  // non prises telles quelles : un exposant plus grand rapproche, donc l'ordre
  // s'inverse, et le plancher peut écraser l'estimation centrale sous une
  // borne — à signal très fort, on obtenait min > meters.
  const bornes = [
    distanceFor(rssi, txPower, 3.5),
    distanceFor(rssi, txPower, 2.0),
    meters,
  ]
  const min = Math.min(...bornes)
  const max = Math.max(...bornes)

  const confidence = confidenceFor(rssi)
  return { meters, min, max, confidence, label: label(meters, confidence) }
}

/** Plancher, en mètres. Une distance nulle ferait diviser par zéro plus haut. */
const MIN_METERS = 0.5

function distanceFor(rssi: number, txPower: number, n: number): number {
  // Le plancher s'applique *après* la formule, et non à la place : au RSSI de
  // référence exactement, la distance doit valoir un mètre, par définition.
  return Math.max(MIN_METERS, 10 ** ((txPower - rssi) / (10 * n)))
}

/**
 * Fiabilité, déduite du niveau de signal.
 *
 * Un signal fort est mesuré avec peu de bruit ; en dessous de −85 dBm la
 * mesure fluctue de plusieurs décibels d'un instant à l'autre, et la distance
 * qui en découle n'a plus de sens.
 */
function confidenceFor(rssi: number): DistanceConfidence {
  if (rssi >= -70) return 'bonne'
  if (rssi >= -85) return 'moyenne'
  return 'faible'
}

/**
 * Formulation par paliers.
 *
 * Des paliers plutôt qu'une valeur : ils correspondent à ce que la mesure
 * permet réellement d'affirmer, et à ce dont un joueur a besoin.
 */
function label(meters: number, confidence: DistanceConfidence): string {
  if (confidence === 'faible') return 'hors de portée utile'
  if (meters < 1) return 'à portée de main'
  if (meters < 3) return 'même table'
  if (meters < 10) return 'même pièce'
  if (meters < 25) return 'pièce voisine'
  return 'loin'
}

/**
 * Moyenne lissée d'une série de RSSI.
 *
 * Le RSSI saute de 5 à 10 dB d'une annonce à l'autre, à appareils immobiles.
 * Afficher la dernière valeur donnerait une distance qui danse. On écarte les
 * extrêmes avant de moyenner : une seule mesure aberrante suffirait sinon à
 * doubler l'estimation.
 */
export function smoothRssi(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined
  if (samples.length < 4) return samples.reduce((a, b) => a + b, 0) / samples.length

  const sorted = [...samples].sort((a, b) => a - b)
  const cut = Math.floor(sorted.length / 4)
  const kept = sorted.slice(cut, sorted.length - cut)
  return kept.reduce((a, b) => a + b, 0) / kept.length
}
