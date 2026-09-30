// Postgres: one pool, and the migrations in migrations/ applied in file order, each once.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { INDEX_ROOT } from './config.ts'

export type Db = pg.Pool

// Postgres `numeric` and `bigint` come back as strings, which is what an amount of base units
// should be: no rounding through a JavaScript number.
export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 })
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  )
  const dir = join(INDEX_ROOT, 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const name of files) {
    const done = await db.query('select 1 from schema_migrations where name = $1', [name])
    if (done.rowCount) continue
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query(readFileSync(join(dir, name), 'utf8'))
      await client.query('insert into schema_migrations (name) values ($1)', [name])
      await client.query('commit')
      applied.push(name)
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }
  return applied
}

export async function getCursor(db: Db, source: string): Promise<string | null> {
  const { rows } = await db.query('select value from cursors where source = $1', [source])
  return rows[0]?.value ?? null
}

export async function setCursor(db: Db, source: string, value: string): Promise<void> {
  await db.query(
    'insert into cursors (source, value) values ($1, $2) on conflict (source) do update set value = excluded.value',
    [source, value],
  )
}
