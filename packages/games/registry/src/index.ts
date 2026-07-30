import type { TransportCaps } from '@ttd/core'
import { type GamePlugin, isPlayableOn, unplayableReason } from '@ttd/game-sdk'
import { esquivePlugin } from '@ttd/game-esquive/plugin'

/**
 * Le catalogue.
 *
 * **Seul endroit du dépôt qui connaît la liste des jeux.** L'application
 * n'importe aucun jeu directement : elle lit ce catalogue et se sert du
 * contrat `GamePlugin`. Ajouter un mini-jeu revient donc à écrire son paquet
 * et à l'inscrire ici — une ligne — sans toucher au lobby, au rendu ni au
 * réseau.
 *
 * L'ordre est celui de l'affichage. Le premier sert de choix par défaut.
 */
export const CATALOGUE: readonly GamePlugin[] = [esquivePlugin as GamePlugin]

export const DEFAULT_GAME_ID: string = CATALOGUE[0]!.game.meta.id

export function gameById(id: string): GamePlugin | undefined {
  return CATALOGUE.find((plugin) => plugin.game.meta.id === id)
}

export interface Resolution {
  readonly plugin: GamePlugin
  /**
   * `false` si l'identifiant demandé était inconnu.
   *
   * L'appelant doit le signaler : un pair plus récent peut lancer un jeu que
   * cette version n'a pas. Retomber sur un jeu connu garde la partie jouable,
   * mais jouer à autre chose que ce qui a été annoncé, sans le dire, serait
   * incompréhensible pour le joueur — et les deux camps simuleraient des jeux
   * différents, ce que le contrôle d'empreinte signalerait aussitôt.
   */
  readonly exact: boolean
}

/** Plugin demandé, ou le premier du catalogue à défaut. */
export function resolveGame(id: string): Resolution {
  const found = gameById(id)
  return found ? { plugin: found, exact: true } : { plugin: CATALOGUE[0]!, exact: false }
}

export interface GameOffer {
  readonly plugin: GamePlugin
  /** Le lien courant peut-il porter ce jeu ? */
  readonly playable: boolean
  /** Pourquoi pas, le cas échéant, formulé pour le joueur. */
  readonly reason?: string
}

/**
 * Catalogue confronté à ce que le lien sait faire.
 *
 * Le lobby grise ce qui ne passera pas plutôt que de laisser lancer une partie
 * injouable : un jeu temps réel ne tient pas dans le débit d'un lien BLE, et
 * s'en apercevoir après le lancement est bien pire que de le lire avant.
 */
export function offers(caps: TransportCaps): GameOffer[] {
  return CATALOGUE.map((plugin) => ({
    plugin,
    playable: isPlayableOn(plugin.game.meta, caps),
    reason: unplayableReason(plugin.game.meta, caps),
  }))
}
