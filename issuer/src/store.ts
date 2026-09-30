// The issuer's one file: the session ids already used, and the commitments waiting for a batch.
//
// Two tables that share nothing. Neither has a timestamp or a row number, so nothing in them says
// which session brought which commitment, and each keeps its rows in key order. A commitment leaves
// the file once it is on the list; what stays is a hash of every session id ever used, which is all
// that refusing a second use needs.
//
// Deleting a row is not enough to take it out of the file: SQLite leaves deleted bytes in free
// space, and page rebuilds can leave stale copies of rows that moved, in insertion order. So deleted
// bytes are overwritten (`secure_delete`), and `compact` rewrites the whole file from what it holds
// now (`VACUUM`); the batch runs it after every flush. The rollback journal is deleted after each
// commit, and VACUUM's working copy stays in memory.

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { fromBytes32, toBytes32 } from '../../registry/client/src/field.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

export type Accepted = 'queued' | 'session_used' | 'commitment_queued'

export class Store {
  readonly #db: DatabaseSync
  readonly #isUsed: StatementSync
  readonly #isQueued: StatementSync
  readonly #use: StatementSync
  readonly #enqueue: StatementSync
  readonly #queued: StatementSync
  readonly #count: StatementSync
  readonly #remove: StatementSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS queue (commitment BLOB PRIMARY KEY) WITHOUT ROWID;
    `)
    this.#isUsed = this.#db.prepare('SELECT 1 FROM used_sessions WHERE hash = ?')
    this.#isQueued = this.#db.prepare('SELECT 1 FROM queue WHERE commitment = ?')
    this.#use = this.#db.prepare('INSERT OR IGNORE INTO used_sessions (hash) VALUES (?)')
    this.#enqueue = this.#db.prepare('INSERT OR IGNORE INTO queue (commitment) VALUES (?)')
    this.#queued = this.#db.prepare('SELECT commitment FROM queue')
    this.#count = this.#db.prepare('SELECT count(*) AS n FROM queue')
    this.#remove = this.#db.prepare('DELETE FROM queue WHERE commitment = ?')
  }

  isUsed(sessionId: string): boolean {
    return this.#isUsed.get(sessionHash(sessionId)) !== undefined
  }

  isQueued(commitment: bigint): boolean {
    return this.#isQueued.get(toBytes32(commitment)) !== undefined
  }

  /**
   * Mark the session used and queue the commitment, both or neither. The keys decide: two requests
   * carrying one session can both pass every check before this, while each waits for Didit, and
   * only the first to get here queues anything.
   */
  accept(sessionId: string, commitment: bigint): Accepted {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      let outcome: Accepted = 'queued'
      if (Number(this.#use.run(sessionHash(sessionId)).changes) !== 1) outcome = 'session_used'
      else if (Number(this.#enqueue.run(toBytes32(commitment)).changes) !== 1) outcome = 'commitment_queued'
      this.#db.exec(outcome === 'queued' ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      // Left open, the transaction would make every later write and VACUUM fail.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Every commitment waiting, in key order, which is no order anyone chose. */
  queued(): bigint[] {
    return this.#queued.all().map((row) => fromBytes32(row.commitment as Uint8Array))
  }

  count(): number {
    return Number((this.#count.get() as { n: number | bigint }).n)
  }

  remove(commitment: bigint): void {
    this.#remove.run(toBytes32(commitment))
  }

  /** Rewrite the file from its live rows only. */
  compact(): void {
    this.#db.exec('VACUUM')
  }

  close(): void {
    this.#db.close()
  }
}
