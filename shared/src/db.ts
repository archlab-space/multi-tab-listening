import { Pool } from 'pg'

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
    user: env.DB_USER ?? 'postgres',
    host: env.DB_HOST ?? 'localhost',
    database: env.DB_NAME ?? 'discord_monitor',
    password: env.DB_PASSWORD ?? '',
    port: parsePort(env.DB_PORT),
  }
}

export function createPool(config: DbConfig = loadDbConfig()): Pool {
  return new Pool(config)
}
