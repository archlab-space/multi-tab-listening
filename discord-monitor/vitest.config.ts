import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tests/` holds a Playwright spec, which vitest would otherwise collect
    // and fail on. Only src/ is ours.
    include: ['src/**/*.test.ts'],
    // One database serves every package, so tests inside a file must not race
    // each other either.
    fileParallelism: false,
    // The service loads .env through config.ts before touching the database;
    // tests construct Database directly, so they have to do it themselves.
    setupFiles: ['dotenv/config'],
  },
})
