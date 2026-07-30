import type { TransportCaps, TransportKind } from '@ttd/core'
import { type MiniGameMeta, estimatedBytesPerSec, isPlayableOn } from '@ttd/game-sdk'

/** Résultat d'un sondage : ce transport est-il réellement utilisable, ici et maintenant ? */
export interface ProbeResult {
  /** Un correspondant a effectivement été atteint. */
  readonly reachable: boolean
  /** Aller-retour mesuré. Absent si non mesurable sans établir la session. */
  readonly rttMs?: number
  /** Nombre de correspondants trouvés. Zéro signifie « personne à portée ». */
  readonly peersFound?: number
  /** Raison lisible de l'indisponibilité, pour la page de diagnostic. */
  readonly reason?: string
}

/** Un transport candidat, avec de quoi vérifier qu'il marche vraiment. */
export interface TransportCandidate {
  readonly kind: TransportKind
  readonly caps: TransportCaps
  /**
   * Vérifie la joignabilité réelle.
   *
   * Sonder, et non se fier aux capacités déclarées : un appareil peut très bien
   * savoir faire du Bluetooth sans que personne ne soit à portée, ou avoir une
   * pile WebRTC parfaitement fonctionnelle derrière un NAT qui l'empêchera
   * d'aboutir. Les capacités disent ce qui est possible, le sondage dit ce qui
   * marche.
   */
  probe(): Promise<ProbeResult>
}

export interface ScoreOptions {
  /**
   * Mini-jeu visé. Un transport incapable de le porter est écarté quelle que
   * soit sa vitesse : mieux vaut un lien lent qui tient qu'un lien rapide qui
   * saccade.
   */
  readonly game?: MiniGameMeta
}

export interface TransportScore {
  readonly kind: TransportKind
  readonly caps: TransportCaps
  readonly probe: ProbeResult
  /**
   * Note finale, comparable uniquement entre transports utilisables.
   *
   * Elle peut être négative pour un transport parfaitement bon — la pénalité
   * d'infrastructure y suffit. C'est pourquoi l'utilisabilité est un champ à
   * part et non une valeur sentinelle : trier sur la seule note ferait passer
   * un transport injoignable devant un relay qui marche.
   */
  readonly score: number
  /** Explication en français, destinée à la page de diagnostic. */
  readonly reason: string
  readonly usable: boolean
}

/**
 * Pénalité appliquée à un transport qui dépend d'une infrastructure externe.
 *
 * C'est le cœur du classement, et le point sur lequel « fiable » se sépare de
 * « rapide ». Un relay est plus véloce qu'un lien Bluetooth, mais il suppose du
 * réseau mobile, un serveur en ligne et un opérateur qui répond. Dans une
 * soirée entre amis — le cas d'usage visé — ces trois conditions tombent
 * régulièrement, alors que deux téléphones posés sur la même table se parlent
 * toujours.
 */
const INFRASTRUCTURE_PENALTY = 1000

/** Prime au hors-ligne : rien à installer, rien à payer, rien qui tombe. */
const OFFLINE_BONUS = 800

/**
 * Note un transport.
 *
 * Trois portes successives, dans cet ordre : joignable, capable de porter le
 * jeu, puis seulement rapide. Inverser l'ordre reviendrait à choisir un lien
 * brillant sur le papier qui ne relie personne.
 */
export function scoreTransport(
  candidate: TransportCandidate,
  probe: ProbeResult,
  options: ScoreOptions = {},
): TransportScore {
  const base = { kind: candidate.kind, caps: candidate.caps, probe }

  if (!probe.reachable) {
    return {
      ...base,
      score: Number.NEGATIVE_INFINITY,
      usable: false,
      reason: probe.reason ?? 'aucun correspondant joignable',
    }
  }

  if (options.game && !isPlayableOn(options.game, candidate.caps)) {
    const needed = Math.round(estimatedBytesPerSec(options.game, candidate.caps))
    return {
      ...base,
      score: Number.NEGATIVE_INFINITY,
      usable: false,
      reason: `« ${options.game.name} » demande ~${needed} o/s, ce lien n’en offre que ${candidate.caps.throughputBytesPerSec}`,
    }
  }

  let score = 0
  const notes: string[] = []

  if (candidate.caps.requiresInternet) {
    score -= INFRASTRUCTURE_PENALTY
    notes.push('dépend d’Internet et du relay')
  } else {
    score += OFFLINE_BONUS
    notes.push('fonctionne hors ligne')
  }

  // Le débit compte, mais de façon logarithmique : passer de 1,5 à 15 ko/s
  // change tout, de 500 ko/s à 1 Mo/s ne change rien pour des mini-jeux dont
  // le trafic se compte en centaines d'octets par seconde.
  score += Math.log2(Math.max(1, candidate.caps.throughputBytesPerSec)) * 20

  const rtt = probe.rttMs ?? candidate.caps.rttHintMs
  score -= rtt
  notes.push(`~${Math.round(rtt)} ms`)

  if (!candidate.caps.reliable) {
    score -= 300
    notes.push('livraison non garantie')
  }

  return { ...base, score, usable: true, reason: notes.join(', ') }
}

/**
 * Sonde tous les candidats et les classe, du plus fiable au moins fiable.
 *
 * Les sondages partent en parallèle : les mener l'un après l'autre ferait
 * attendre le joueur pendant la somme de tous les délais d'expiration, ce qui
 * peut dépasser la dizaine de secondes rien qu'en Bluetooth.
 */
export async function rankTransports(
  candidates: readonly TransportCandidate[],
  options: ScoreOptions = {},
): Promise<TransportScore[]> {
  const probes = await Promise.all(
    candidates.map(async (candidate): Promise<ProbeResult> => {
      try {
        return await candidate.probe()
      } catch (error) {
        return { reachable: false, reason: (error as Error).message }
      }
    }),
  )

  return candidates
    .map((candidate, i) => scoreTransport(candidate, probes[i]!, options))
    // L'utilisabilité prime toujours sur la note : un transport injoignable
    // passe derrière, quel que soit l'écart de score entre les autres.
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.score - a.score)
}

export interface Selection {
  /** Le transport retenu, ou `undefined` si aucun ne convient. */
  readonly chosen: TransportScore | undefined
  /** Les suivants, dans l'ordre, prêts à servir de repli. */
  readonly fallbacks: TransportScore[]
  /** Tous les candidats notés, y compris les écartés. Pour le diagnostic. */
  readonly all: TransportScore[]
}

/**
 * Choisit le moyen de communication le plus fiable pour cette partie.
 *
 * Renvoie aussi la liste des replis : le choix n'est jamais définitif. Un lien
 * Bluetooth se dégrade quand on s'éloigne, un pair à pair tombe quand le
 * réseau change — on veut pouvoir descendre d'un cran sans tout recommencer.
 */
export async function selectTransport(
  candidates: readonly TransportCandidate[],
  options: ScoreOptions = {},
): Promise<Selection> {
  const all = await rankTransports(candidates, options)
  const usable = all.filter((entry) => entry.usable)
  return { chosen: usable[0], fallbacks: usable.slice(1), all }
}

/** Explication d'un choix, en une phrase, pour l'interface. */
export function explainSelection(selection: Selection): string {
  if (!selection.chosen) {
    const blockers = selection.all
      .map((entry) => `${entry.kind} : ${entry.reason}`)
      .join(' · ')
    return blockers.length > 0 ? `Aucun lien utilisable — ${blockers}` : 'Aucun lien utilisable'
  }
  const next = selection.fallbacks[0]
  const suffix = next ? `, repli sur ${next.kind}` : ', sans repli disponible'
  return `${selection.chosen.kind} retenu (${selection.chosen.reason})${suffix}`
}
