export type Unsubscribe = () => void

type Listener<T> = (payload: T) => void

/**
 * Émetteur d'événements typé, minimal.
 *
 * Le socle vise le navigateur autant que le natif : pas de dépendance à
 * `EventEmitter` de Node, et pas de `EventTarget` non plus, dont l'enveloppe
 * `CustomEvent` coûte une allocation par message reçu.
 */
export class Emitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener as Listener<never>)
    return () => void set.delete(listener as Listener<never>)
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event)
    if (!set) return
    // Copie : un écouteur qui se désabonne pendant l'émission ne doit pas
    // décaler l'itération et faire sauter le suivant.
    for (const listener of [...set]) {
      ;(listener as Listener<Events[K]>)(payload)
    }
  }

  removeAll(): void {
    this.#listeners.clear()
  }
}
