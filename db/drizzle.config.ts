import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { loadDbConfig } from 'shared/db'

// The repo-root .env, not this package's — deliberately the same file docker
// compose reads when it creates the container. One DB_PASSWORD governs both
// the password the database is created with and the password the migrator
// connects with, so the two cannot drift apart.
loadEnv({ path: new URL('../.env', import.meta.url) })

const config = loadDbConfig()

export default defineConfig({
  dialect: 'postgresql',
  // The schema lives in `shared` because it is the contract between the
  // services, not a private detail of this tooling package.
  schema: '../shared/src/schema.ts',
  out: './migrations',
  dbCredentials: {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: false,
  },
})
