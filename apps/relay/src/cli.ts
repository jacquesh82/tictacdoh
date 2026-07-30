import { RelayServer } from './server.js'

const port = Number(process.env['PORT'] ?? 8787)
const relay = new RelayServer()
const bound = await relay.listen(port)
console.log(`relay tictacdoh à l'écoute sur ws://localhost:${bound}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0))
  })
}
