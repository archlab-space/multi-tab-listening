import { Pool, type PoolConfig } from 'pg'

/** The Postgres connection shape every service in this workspace uses. */
export interface DbConfig {
  user: string
  host: string
  database: string
  password: string
  port: number
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 5432
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `DB_PORT must be an integer between 1 and 65535, got: ${raw}`,
    )
  }
  return port
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    // Matches the user docker-compose.yml creates. The previous default of
    // 'postgres' is a role that does not exist in that container, so omitting
    // DB_USER failed with a confusing "role does not exist" rather than
    // working out of the box.
    user: env.DB_USER ?? 'app_user',
    host: env.DB_HOST ?? 'localhost',
    database: env.DB_NAME ?? 'multi_tab_listening',
    password: env.DB_PASSWORD ?? '',
    port: parsePort(env.DB_PORT),
  }
}

/**
 * Pool tuning both services had arrived at independently, so it belongs here
 * rather than being restated at each call site.
 */
const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
} satisfies PoolConfig

export function createPool(
  config: DbConfig = loadDbConfig(),
  overrides: PoolConfig = {},
): Pool {
  return new Pool({ ...POOL_DEFAULTS, ...config, ...overrides })
}
