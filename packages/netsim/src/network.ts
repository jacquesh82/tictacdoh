import { MemoryLink, type PeerId, Rng, TransportError } from '@ttd/core'
import type { SimProfile } from './profiles.js'

/** Objet que le réseau simulé fait avancer à chaque pas : session, canal. */
export interface Pumpable {
  pump(nowMs: number): unknown
}

interface InFlight {
  at: number
  to: MemoryLink
  payload: Uint8Array
  seq: number
}

export interface SimNetworkOptions {
  readonly profile: SimProfile
  /** Graine du hasard. Fixée par défaut pour que les tests soient rejouables. */
  readonly seed?: number
}

export interface SimStats {
  sent: number
  delivered: number
  lost: number
  bytes: number
}

/**
 * Réseau simulé, à horloge virtuelle et hasard déterministe.
 *
 * Rend testable sans matériel ce qui autrement n'apparaîtrait qu'en phase 9 :
 * une partie à quatre sous les 1500 o/s d'un lien BLE, la perte de l'hôte en
 * pleine manche, l'arrivée d'un joueur en cours de partie.
 *
 * Le temps n'avance que sur appel explicite à `advance()`. Aucun `setTimeout`,
 * aucune microtâche : un test qui échoue échoue toujours de la même façon, ce
 * qui compte plus qu'on ne le croit sur du code réseau.
 */
export class SimNetwork {
  readonly profile: SimProfile
  readonly stats: SimStats = { sent: 0, delivered: 0, lost: 0, bytes: 0 }

  readonly #rng: Rng
  readonly #queue: InFlight[] = []
  readonly #pumpables = new Set<Pumpable>()
  readonly #lastDeliveryAt = new Map<MemoryLink, number>()
  readonly #cut = new Set<PeerId>()

  #clock = 0
  #seq = 0

  constructor(options: SimNetworkOptions) {
    this.profile = options.profile
    this.#rng = new Rng(options.seed ?? 0x5eed)

    if (this.profile.caps.reliable && this.profile.lossRate > 0) {
      throw new TransportError(
        `profil « ${this.profile.name} » incohérent : un lien fiable ne perd pas de messages, il se coupe`,
        this.profile.caps.kind,
      )
    }
  }

  now(): number {
    return this.#clock
  }

  /** Enregistre un objet à faire avancer à chaque pas de temps. */
  register(...pumpables: Pumpable[]): void {
    for (const pumpable of pumpables) this.#pumpables.add(pumpable)
  }

  /** Crée un lien entre deux pairs, aux caractéristiques du profil. */
  pair(aId: PeerId, bId: PeerId): [MemoryLink, MemoryLink] {
    return MemoryLink.pair(aId, bId, this.profile.caps, (to, payload) => {
      this.#schedule(to, payload)
    })
  }

  #schedule(to: MemoryLink, payload: Uint8Array): void {
    this.stats.sent++

    // La MTU n'est pas un conseil : un transport réel refuse ou tronque. On
    // échoue bruyamment pour que le bug soit imputé à l'appelant.
    if (payload.length > this.profile.caps.maxPayloadBytes) {
      throw new TransportError(
        `message de ${payload.length} o au-delà de la MTU de ${this.profile.caps.maxPayloadBytes} o`,
        this.profile.caps.kind,
      )
    }

    if (this.#cut.has(to.ownerId)) {
      this.stats.lost++
      return
    }

    if (this.profile.lossRate > 0 && this.#rng.nextBelow(10_000) < this.profile.lossRate * 10_000) {
      this.stats.lost++
      return
    }

    const jitter = this.profile.jitterMs > 0 ? this.#rng.nextBelow(this.profile.jitterMs * 2 + 1) - this.profile.jitterMs : 0
    let at = this.#clock + Math.max(0, this.profile.latencyMs + jitter)

    // Un profil qui annonce `ordered` doit le tenir : la gigue ne doit pas
    // faire doubler un message par le suivant, sinon on testerait un
    // comportement qu'aucun de nos transports réels n'a.
    if (this.profile.caps.ordered) {
      const last = this.#lastDeliveryAt.get(to)
      if (last !== undefined && at < last) at = last
      this.#lastDeliveryAt.set(to, at)
    }

    this.#queue.push({ at, to, payload, seq: this.#seq++ })
  }

  /**
   * Fait avancer le temps.
   *
   * À chaque pas : on remet les messages échus, puis on fait avancer les objets
   * enregistrés. Dans cet ordre, pour qu'un message reçu puisse déclencher une
   * réponse dans le même pas plutôt qu'au suivant.
   */
  advance(durationMs: number, stepMs = 10): void {
    const target = this.#clock + durationMs
    while (this.#clock < target) {
      this.#clock = Math.min(target, this.#clock + stepMs)
      this.#deliverDue()
      for (const pumpable of this.#pumpables) pumpable.pump(this.#clock)
      // Un envoi déclenché par le pump peut être échu si la latence est nulle.
      this.#deliverDue()
    }
  }

  #deliverDue(): void {
    if (this.#queue.length === 0) return
    // Tri par date puis par ordre d'émission : deux messages échus au même
    // instant se remettent dans l'ordre où ils sont partis.
    this.#queue.sort((a, b) => a.at - b.at || a.seq - b.seq)

    while (this.#queue.length > 0 && this.#queue[0]!.at <= this.#clock) {
      const item = this.#queue.shift()!
      if (item.to.closed) continue
      this.stats.delivered++
      this.stats.bytes += item.payload.length
      item.to.accept(item.payload)
    }
  }

  /**
   * Coupe la remise vers un pair, sans fermer le lien : c'est le passage en
   * tunnel ou l'éloignement hors de portée, où l'application ne l'apprend
   * qu'au bout d'un moment.
   */
  cut(peerId: PeerId): void {
    this.#cut.add(peerId)
  }

  restore(peerId: PeerId): void {
    this.#cut.delete(peerId)
  }

  /** Messages encore en vol. */
  get inFlight(): number {
    return this.#queue.length
  }
}
