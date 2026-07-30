import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { relayAdvice, setRelayUrl } from '../src/app-config.js'

/**
 * Stockage en mémoire.
 *
 * Ces modules lisent `globalThis.localStorage`, absent sous Node. Un stub
 * plutôt qu'un environnement DOM complet : on teste une logique de message,
 * pas un navigateur, et jsdom coûterait plusieurs secondes par exécution.
 */
function stubLocalStorage(): void {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  })
}

/**
 * Le conseil doit distinguer les causes.
 *
 * Un serveur éteint, une adresse absente et un certificat non reconnu
 * produisent le même échec côté JavaScript : les navigateurs masquent
 * délibérément la cause d'un rejet TLS. Le message est donc la seule chose qui
 * oriente l'utilisateur, et se tromper de conseil lui fait perdre son temps
 * sur la mauvaise piste.
 */
describe('relayAdvice', () => {
  beforeAll(stubLocalStorage)

  beforeEach(() => {
    globalThis.localStorage.clear()
  })

  it('signale un certificat probablement non reconnu en wss local', () => {
    setRelayUrl('wss://192.168.1.188:8787')
    const message = relayAdvice('connexion refusée')
    expect(message).toMatch(/certificat non reconnu/)
    // Et il dit que l'application ne peut pas trancher à la place du système.
    expect(message).toMatch(/ne peut pas accorder cette confiance/)
  })

  it('ne parle pas de certificat en clair', () => {
    setRelayUrl('ws://192.168.1.188:8787')
    expect(relayAdvice('connexion refusée')).not.toMatch(/certificat/)
  })

  it('ne parle pas de certificat vers une adresse publique', () => {
    // Là, un certificat valide est possible : l'échec a une autre cause.
    setRelayUrl('wss://relay.tictacdoh.app')
    expect(relayAdvice('connexion refusée')).not.toMatch(/certificat/)
  })

  it('reconnaît les trois plages privées et le .local', () => {
    for (const hote of ['10.0.0.5', '192.168.1.1', '172.20.3.4', 'salon.local']) {
      setRelayUrl(`wss://${hote}:8787`)
      expect(relayAdvice('échec'), hote).toMatch(/certificat non reconnu/)
    }
  })

  it('ne prend pas 172.15 ou 172.32 pour du privé', () => {
    // La plage privée s'arrête à 172.16–172.31 : déborder ferait donner un
    // mauvais conseil sur des adresses publiques.
    for (const hote of ['172.15.0.1', '172.32.0.1']) {
      setRelayUrl(`wss://${hote}:8787`)
      expect(relayAdvice('échec'), hote).not.toMatch(/certificat/)
    }
  })

  it('nomme toujours le relay visé', () => {
    setRelayUrl('ws://192.168.1.50:9000')
    expect(relayAdvice('échec')).toMatch(/ws:\/\/192\.168\.1\.50:9000/)
  })
})
