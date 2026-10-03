// The connections service's one file: the assistants registered with it, and one connection per
// grant. A connection is a profile's address and the access key made for it; nothing about who
// asked, and no network address. Tokens and codes are kept as their SHA-256, so the file holds
// none of them.
//
//   clients       an assistant's OAuth registration, as it sent it (RFC 7591)
//   connections   one access key per grant: the profile it writes for, its private key, the
//                 assistant it was made for, and the authorization waiting on the person (the
//                 PKCE challenge, the redirect, the state) until the profile's permissions record
//                 lists the key
//   codes         a one-time code for a connection, for ten minutes
//   tokens        access tokens (an hour) and refresh tokens (90 days), each for one connection

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const hash = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex')
/** A random secret: 32 bytes, base64url. */
export const secret = () => randomBytes(32).toString('base64url')

export type Pending = {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string | null
  scopes: string[]
  resource: string | null
}

export type Connection = {
  id: string
  clientId: string
  /** The profile's address; null until the person names it. */
  profile: string | null
  /** The access key's 32 private bytes; made when the person names the profile. */
  accessKey: Uint8Array | null
  /** Whether the profile's permissions record listed the key, and the grant went through. */
  granted: boolean
  pending: Pending | null
  /** Milliseconds since 1970: until when an ungranted connection may still be granted. */
  expires: number
}

export const CODE_MS = 10 * 60_000
export const ACCESS_MS = 60 * 60_000
export const REFRESH_MS = 90 * 86_400_000
/** How long a person has to name the profile and add the access key. */
export const GRANT_MS = 60 * 60_000

export class Store {
  readonly #db: DatabaseSync

  constructor(path: string) {
    const fresh = path !== ':memory:' && !existsSync(path)
    this.#db = new DatabaseSync(path)
    if (fresh) chmodSync(path, 0o600)
    // A file written before forest's 3 October words names the key `writer_key`: the same column,
    // under today's name.
    const columns = this.#db.prepare("SELECT name FROM pragma_table_info('connections')").all().map((c) => c.name as string)
    if (columns.includes('writer_key')) this.#db.exec('ALTER TABLE connections RENAME COLUMN writer_key TO access_key')
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, info TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, profile TEXT, access_key BLOB,
        granted INTEGER NOT NULL DEFAULT 0, pending TEXT, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, connection TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, connection TEXT NOT NULL, expires INTEGER NOT NULL);
    `)
  }

  client(id: string): unknown | undefined {
    const row = this.#db.prepare('SELECT info FROM clients WHERE id = ?').get(id)
    return row ? JSON.parse(row.info as string) : undefined
  }

  addClient(id: string, info: unknown): void {
    this.#db.prepare('INSERT INTO clients (id, info) VALUES (?, ?)').run(id, JSON.stringify(info))
  }

  /** A new connection, waiting for the person: its id is the one random thing their page carries. */
  open(clientId: string, pending: Pending, now: number): string {
    const id = secret()
    this.#db.prepare('INSERT INTO connections (id, client, pending, expires) VALUES (?, ?, ?, ?)').run(id, clientId, JSON.stringify(pending), now + GRANT_MS)
    return id
  }

  connection(id: string): Connection | null {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
    if (!row) return null
    return {
      id: row.id as string,
      clientId: row.client as string,
      profile: (row.profile as string | null) ?? null,
      accessKey: row.access_key ? new Uint8Array(row.access_key as Uint8Array) : null,
      granted: row.granted === 1,
      pending: row.pending ? (JSON.parse(row.pending as string) as Pending) : null,
      expires: Number(row.expires),
    }
  }

  /** The profile the person named, and the access key made for it. Once only. */
  name(id: string, profile: string, accessKey: Uint8Array): void {
    this.#db.prepare('UPDATE connections SET profile = ?, access_key = ? WHERE id = ? AND profile IS NULL AND granted = 0').run(profile, accessKey, id)
  }

  /** The grant went through: the authorization it waited on is spent, and a code is made for it. */
  grant(id: string, now: number): string {
    const code = secret()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('UPDATE connections SET granted = 1 WHERE id = ?').run(id)
      this.#db.prepare('INSERT INTO codes (hash, connection, expires) VALUES (?, ?, ?)').run(hash(code), id, now + CODE_MS)
      this.#db.exec('COMMIT')
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
    return code
  }

  /** The connection a code is for, while it is good. The code is not spent: exchanging it is. */
  codeConnection(code: string, now: number): Connection | null {
    const row = this.#db.prepare('SELECT connection, expires FROM codes WHERE hash = ?').get(hash(code))
    if (!row || Number(row.expires) <= now) return null
    return this.connection(row.connection as string)
  }

  /** Spend a code: true once, false after. */
  spendCode(code: string): boolean {
    return Number(this.#db.prepare('DELETE FROM codes WHERE hash = ?').run(hash(code)).changes) === 1
  }

  /** A new access token and refresh token for a connection. */
  issue(connection: string, now: number): { access: string; refresh: string } {
    const access = secret()
    const refresh = secret()
    const add = this.#db.prepare('INSERT INTO tokens (hash, kind, connection, expires) VALUES (?, ?, ?, ?)')
    add.run(hash(access), 'access', connection, now + ACCESS_MS)
    add.run(hash(refresh), 'refresh', connection, now + REFRESH_MS)
    return { access, refresh }
  }

  /** The connection a token is for, while it is good, and when it ends. */
  token(token: string, kind: 'access' | 'refresh', now: number): { connection: Connection; expires: number } | null {
    const row = this.#db.prepare('SELECT connection, expires FROM tokens WHERE hash = ? AND kind = ?').get(hash(token), kind)
    if (!row || Number(row.expires) <= now) return null
    const connection = this.connection(row.connection as string)
    return connection ? { connection, expires: Number(row.expires) } : null
  }

  /** Spend a refresh token, or forget any token: true when it was there. */
  drop(token: string): boolean {
    return Number(this.#db.prepare('DELETE FROM tokens WHERE hash = ?').run(hash(token)).changes) === 1
  }

  /**
   * Forget what has expired: codes, tokens, connections never granted, and granted ones with no code
   * or token left, whose access key nothing can use again. Returns how many rows went.
   */
  prune(now: number): number {
    let n = 0
    n += Number(this.#db.prepare('DELETE FROM codes WHERE expires <= ?').run(now).changes)
    n += Number(this.#db.prepare('DELETE FROM tokens WHERE expires <= ?').run(now).changes)
    n += Number(this.#db.prepare('DELETE FROM connections WHERE granted = 0 AND expires <= ?').run(now).changes)
    n += Number(
      this.#db
        .prepare(
          `DELETE FROM connections WHERE granted = 1
             AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.connection = connections.id)
             AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.connection = connections.id)`,
        )
        .run().changes,
    )
    return n
  }

  close(): void {
    this.#db.close()
  }
}
