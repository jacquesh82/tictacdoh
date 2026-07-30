import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // Le socle simule des réseaux lents (profil BLE) : certains tests d'intégration
    // font tourner une partie complète et dépassent le défaut de 5 s.
    testTimeout: 20_000,
  },
})
