/** Erreur de sérialisation / désérialisation. */
export class WireError extends Error {
  override readonly name = 'WireError'

  constructor(message: string) {
    super(message)
  }
}

export function fail(message: string): never {
  throw new WireError(message)
}
