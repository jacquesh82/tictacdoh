import { Emitter, type Netcode, type Session, type Unsubscribe } from '@ttd/core'
import type { GameResult, MiniGame } from './minigame.js'

export interface RuntimeEvents<S> extends Record<string, unknown> {
  /** Un tick vient d'être simulé. Le rendu peut lire l'état. */
  simulated: { tick: number; state: S }
  /** La manche est terminée. */
  finished: { result: GameResult; tick: number }
  /** L'état local a été remplacé par celui de l'hôte. */
  resynchronised: { tick: number }
}

export interface GameRuntimeOptions<S> {
  readonly game: MiniGame<S>
  readonly session: Session
  readonly netcode: Netcode
  readonly seed: number
}

/**
 * Fait tourner un mini-jeu au-dessus du netcode.
 *
 * Ne fait rien d'astucieux, et c'est voulu : à chaque tick confirmé par
 * l'hôte, il appelle `tick` du jeu. Toute l'intelligence réseau est en amont,
 * tout le gameplay en aval, et cette couche ne fait que les raccorder — c'est
 * ce qui permet d'ajouter un jeu au catalogue sans toucher au socle.
 */
export class GameRuntime<S> {
  readonly #events = new Emitter<RuntimeEvents<S>>()
  readonly #game: MiniGame<S>
  readonly #session: Session
  readonly #netcode: Netcode
  readonly #unsubscribes: Unsubscribe[] = []

  #state: S
  #finished: GameResult | undefined

  constructor(options: GameRuntimeOptions<S>) {
    this.#game = options.game
    this.#session = options.session
    this.#netcode = options.netcode

    const seats = options.session.roster.map((peer) => peer.seat).sort((a, b) => a - b)
    this.#state = options.game.create(seats, options.seed)

    this.#unsubscribes.push(
      options.netcode.on('tick', ({ tick, inputs }) => {
        if (this.#finished) return
        this.#game.tick(this.#state, inputs)
        // L'empreinte est calculée à chaque tick mais n'est transmise que
        // périodiquement : c'est le netcode qui décide de la cadence, pas le
        // jeu, parce que lui seul connaît le budget du lien.
        this.#netcode.recordStateHash(tick, this.#game.hash(this.#state))
        this.#events.emit('simulated', { tick, state: this.#state })

        const result = this.#game.isOver(this.#state)
        if (result) {
          this.#finished = result
          this.#netcode.stop()
          this.#events.emit('finished', { result, tick })
        }
      }),
    )

    this.#unsubscribes.push(
      options.netcode.on('keyframe', ({ tick, state }) => {
        this.#state = this.#game.decode(state)
        this.#events.emit('resynchronised', { tick })
      }),
    )

    // L'hôte répond aux divergences en renvoyant l'état complet. Continuer
    // sans cela laisserait un joueur voir une partie qui n'existe pas.
    this.#unsubscribes.push(
      options.netcode.on('keyframe-request', ({ to }) => {
        if (!this.#session.isHost) return
        this.#netcode.sendKeyframe(to, this.#netcode.simulatedTick, this.#game.encode(this.#state))
      }),
    )
  }

  get state(): S {
    return this.#state
  }

  /**
   * Tick simulé.
   *
   * Lu depuis le netcode plutôt que dans l'état du jeu : rien n'oblige un
   * mini-jeu à stocker son numéro de tick, et l'affichage ne peut donc pas
   * compter dessus.
   */
  get tick(): number {
    return this.#netcode.simulatedTick
  }

  get result(): GameResult | undefined {
    return this.#finished
  }

  on<K extends keyof RuntimeEvents<S>>(
    event: K,
    fn: (payload: RuntimeEvents<S>[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, fn)
  }

  dispose(): void {
    for (const off of this.#unsubscribes) off()
    this.#events.removeAll()
  }
}
