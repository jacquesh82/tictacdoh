import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { RelayServer, type TlsMaterial } from './server.js'

/**
 * Certificat, si les deux chemins sont fournis.
 *
 * Les deux ou aucun : un certificat sans clé donne une erreur au démarrage
 * bien moins parlante que ce message.
 */
function readTls(): TlsMaterial | undefined {
  const cert = process.env['TLS_CERT']
  const key = process.env['TLS_KEY']
  if (!cert && !key) return undefined
  if (!cert || !key) {
    console.error('TLS_CERT et TLS_KEY vont ensemble : fournissez les deux, ou aucun.')
    process.exit(2)
  }
  try {
    return { cert: readFileSync(cert), key: readFileSync(key) }
  } catch (error) {
    console.error(`certificat illisible : ${(error as Error).message}`)
    process.exit(2)
  }
}

/**
 * Adresses par lesquelles un téléphone peut joindre ce serveur.
 *
 * `localhost` ne sert à rien depuis un mobile — c'est le piège dans lequel on
 * tombe systématiquement. Afficher les adresses réelles évite d'aller les
 * chercher ailleurs.
 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const cartes of Object.values(networkInterfaces())) {
    for (const carte of cartes ?? []) {
      if (carte.family === 'IPv4' && !carte.internal) out.push(carte.address)
    }
  }
  return out
}

const port = Number(process.env['PORT'] ?? 8787)
const tls = readTls()
const relay = new RelayServer(tls ? { tls } : {})
const bound = await relay.listen(port)
const scheme = relay.secure ? 'wss' : 'ws'

console.log(`relay tictacdoh à l'écoute sur ${scheme}://localhost:${bound}`)
for (const adresse of lanAddresses()) {
  console.log(`  depuis un téléphone : ${scheme}://${adresse}:${bound}`)
}
if (!relay.secure) {
  console.log(
    '  en clair — acceptable sur un réseau local, à proscrire dès que le relay est exposé.\n' +
      '  Pour chiffrer : TLS_CERT=cert.pem TLS_KEY=key.pem npm run relay',
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0))
  })
}
