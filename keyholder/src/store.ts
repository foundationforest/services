// The key holder's one file: the assistants registered with it, and one connection per grant. A
// connection is a profile's address and whether the grant went through; the keys its app handed
// over are in the key store (keys.ts), not here. Nothing about who asked, and no network address.
// Tokens and codes are kept as their SHA-256, so the file holds none of them.
//
//   clients       an assistant's OAuth registration, as it sent it (RFC 7591)
//   connections   one per grant: the profile its keys are for, the assistant it was made for, and
//                 the authorization waiting on the person (the PKCE challenge, the redirect, the
//                 state) until the profile's permissions record lists every key
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
  /** 128 random bits, base64url: the one thing the person's page and their app's link carry. */
  id: string
  clientId: string
  /** The profile the grants are for; null until the app hands them over. */
  profile: string | null
  /** Whether the profile's permissions record listed every key, and the grant went through. */
  granted: boolean
  pending: Pending | null
  /** Milliseconds since 1970: until when an ungranted connection may still be granted. */
  expires: number
}

export const CODE_MS = 10 * 60_000
export const ACCESS_MS = 60 * 60_000
export const REFRESH_MS = 90 * 86_400_000
/** How long a person has to hand over the keys and list them. */
export const GRANT_MS = 60 * 60_000

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    const fresh = path !== ':memory:' && !existsSync(path)
    this.db = new DatabaseSync(path)
    if (fresh) chmodSync(path, 0o600)
    // What is deleted is written over in the file, not just marked free.
    this.db.exec('PRAGMA secure_delete = ON')
    // A file from before the key holder kept each connection's write key in the clear (`access_key`,
    // or `writer_key` before forest's 3 October words). Those connections end: the table goes, with
    // its codes and tokens, and the file is rebuilt so no key stays in it.
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('connections')").all().map((c) => c.name as string)
    if (columns.includes('access_key') || columns.includes('writer_key')) {
      this.db.exec('DROP TABLE connections; DROP TABLE IF EXISTS codes; DROP TABLE IF EXISTS tokens; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, info TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, profile TEXT,
        granted INTEGER NOT NULL DEFAULT 0, pending TEXT, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, connection TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, connection TEXT NOT NULL, expires INTEGER NOT NULL);
    `)
  }

  client(id: string): unknown | undefined {
    const row = this.db.prepare('SELECT info FROM clients WHERE id = ?').get(id)
    return row ? JSON.parse(row.info as string) : undefined
  }

  addClient(id: string, info: unknown): void {
    this.db.prepare('INSERT INTO clients (id, info) VALUES (?, ?)').run(id, JSON.stringify(info))
  }

  /** A new connection, waiting for the person, for an hour. */
  open(clientId: string, pending: Pending, now: number): string {
    const id = randomBytes(16).toString('base64url')
    this.db.prepare('INSERT INTO connections (id, client, pending, expires) VALUES (?, ?, ?, ?)').run(id, clientId, JSON.stringify(pending), now + GRANT_MS)
    return id
  }

  connection(id: string): Connection | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
    if (!row) return null
    return {
      id: row.id as string,
      clientId: row.client as string,
      profile: (row.profile as string | null) ?? null,
      granted: row.granted === 1,
      pending: row.pending ? (JSON.parse(row.pending as string) as Pending) : null,
      expires: Number(row.expires),
    }
  }

  /** The profile the app's grants are for. Once only: true the first time, false after. */
  take(id: string, profile: string): boolean {
    return Number(this.db.prepare('UPDATE connections SET profile = ? WHERE id = ? AND profile IS NULL AND granted = 0').run(profile, id).changes) === 1
  }

  /** The grant went through: the authorization it waited on is spent, and a code is made for it. */
  grant(id: string, now: number): string {
    const code = secret()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE connections SET granted = 1 WHERE id = ?').run(id)
      this.db.prepare('INSERT INTO codes (hash, connection, expires) VALUES (?, ?, ?)').run(hash(code), id, now + CODE_MS)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
    return code
  }

  /** The connection a code is for, while it is good. The code is not spent: exchanging it is. */
  codeConnection(code: string, now: number): Connection | null {
    const row = this.db.prepare('SELECT connection, expires FROM codes WHERE hash = ?').get(hash(code))
    if (!row || Number(row.expires) <= now) return null
    return this.connection(row.connection as string)
  }

  /** Spend a code: true once, false after. */
  spendCode(code: string): boolean {
    return Number(this.db.prepare('DELETE FROM codes WHERE hash = ?').run(hash(code)).changes) === 1
  }

  /** A new access token and refresh token for a connection. */
  issue(connection: string, now: number): { access: string; refresh: string } {
    const access = secret()
    const refresh = secret()
    const add = this.db.prepare('INSERT INTO tokens (hash, kind, connection, expires) VALUES (?, ?, ?, ?)')
    add.run(hash(access), 'access', connection, now + ACCESS_MS)
    add.run(hash(refresh), 'refresh', connection, now + REFRESH_MS)
    return { access, refresh }
  }

  /** The connection a token is for, while it is good, and when it ends. */
  token(token: string, kind: 'access' | 'refresh', now: number): { connection: Connection; expires: number } | null {
    const row = this.db.prepare('SELECT connection, expires FROM tokens WHERE hash = ? AND kind = ?').get(hash(token), kind)
    if (!row || Number(row.expires) <= now) return null
    const connection = this.connection(row.connection as string)
    return connection ? { connection, expires: Number(row.expires) } : null
  }

  /** Spend a refresh token, or forget any token: true when it was there. */
  drop(token: string): boolean {
    return Number(this.db.prepare('DELETE FROM tokens WHERE hash = ?').run(hash(token)).changes) === 1
  }

  /**
   * Forget the codes and tokens past their time, and name the connections that are over: never
   * granted within the hour, or granted with no code or token left, so nothing can use their keys
   * again. The caller drops their keys, then ends each.
   */
  prune(now: number): string[] {
    this.db.prepare('DELETE FROM codes WHERE expires <= ?').run(now)
    this.db.prepare('DELETE FROM tokens WHERE expires <= ?').run(now)
    return this.db
      .prepare(
        `SELECT id FROM connections WHERE (granted = 0 AND expires <= ?)
           OR (granted = 1
             AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.connection = connections.id)
             AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.connection = connections.id))`,
      )
      .all(now)
      .map((r) => r.id as string)
  }

  /** End a connection: it, its codes and its tokens go. Its keys are the key store's to drop. */
  end(id: string): void {
    this.db.prepare('DELETE FROM codes WHERE connection = ?').run(id)
    this.db.prepare('DELETE FROM tokens WHERE connection = ?').run(id)
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }
}
