import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // One database serves every package, so tests inside a file must not race
    // each other either.
    fileParallelism: false,
    // This service runs under Bun, which loads .env on its own. vitest runs
    // under Node, and config.ts reads the database credentials at import
    // time, so they have to be in the environment before that happens.
    setupFiles: ['dotenv/config'],
  },
})
