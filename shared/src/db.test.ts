import { describe, expect, it } from 'vitest'
import { createPool, loadDbConfig } from './db.js'

describe('loadDbConfig', () => {
  it('reads every field from the environment', () => {
    expect(
      loadDbConfig({
        DB_USER: 'someone',
        DB_HOST: 'db.example.com',
        DB_NAME: 'somedb',
        DB_PASSWORD: 'secret',
        DB_PORT: '6543',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      user: 'someone',
      host: 'db.example.com',
      database: 'somedb',
      password: 'secret',
      port: 6543,
    })
  })

  it('applies the same defaults the services used before', () => {
    expect(loadDbConfig({} as NodeJS.ProcessEnv)).toEqual({
      user: 'postgres',
      host: 'localhost',
      database: 'discord_monitor',
      password: '',
      port: 5432,
    })
  })

  it('rejects a port that is not a number', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: 'not-a-port' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })

  it('rejects a port outside the valid range', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })
})

describe('createPool', () => {
  it('builds a pool from the given config', async () => {
    const pool = createPool({
      user: 'discord_user',
      host: 'localhost',
      database: 'discord_monitor',
      password: 'defaultpassword123',
      port: 5432,
    })
    try {
      const result = await pool.query('SELECT 1 AS one')
      expect(result.rows[0]).toEqual({ one: 1 })
    } finally {
      await pool.end()
    }
  })
})
