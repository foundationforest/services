// The issuer's one file: the session ids already used, the commitments waiting for a batch, and
// the list with its roots.
//
// The session ids and the waiting commitments are two tables that share nothing. Neither has a
// timestamp or a row number, so nothing in them says which session brought which commitment, and
// each keeps its rows in key order. A commitment leaves the queue once it is on the list; what
// stays of a session is a hash of its id, which is all that refusing a second use needs.
//
// The list and its roots are public: the issuer publishes both (list.ts). The list keeps each
// commitment once, in list order, which within a batch is shuffled. A root is kept with the size
// of the list it is the root of, the time its batch ran, and, once it is written on chain
// (chain.ts), that transaction's signature. A batch moves commitments from the queue to the list
// and adds their root in one transaction, so a failure changes nothing.
//
// Deleting a row is not enough to take it out of the file: SQLite leaves deleted bytes in free
// space, and page rebuilds can leave stale copies of rows that moved, in insertion order. So deleted
// bytes are overwritten (`secure_delete`), and `compact` rewrites the whole file from what it holds
// now (`VACUUM`); the batch runs it after every flush. The rollback journal is deleted after each
// commit, and VACUUM's working copy stays in memory.

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { fromBytes32, toBytes32 } from '../../forest/registry/client/src/field.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

export type Accepted = 'queued' | 'session_used' | 'commitment_queued'

/** One root of the list: the root of its first `size` commitments, made by a batch at `time` (ms since 1970). */
export type Root = { root: bigint; size: number; time: number }

export class Store {
  readonly #db: DatabaseSync
  readonly #isUsed: StatementSync
  readonly #isQueued: StatementSync
  readonly #use: StatementSync
  readonly #enqueue: StatementSync
  readonly #queued: StatementSync
  readonly #count: StatementSync
  readonly #remove: StatementSync
  readonly #members: StatementSync
  readonly #roots: StatementSync
  readonly #list: StatementSync
  readonly #root: StatementSync
  readonly #unwritten: StatementSync
  readonly #written: StatementSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS queue (commitment BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS list (position INTEGER PRIMARY KEY, commitment BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS roots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL, chain TEXT);
    `)
    // A file from before roots went on chain: its roots are written too, oldest first.
    if (!this.#db.prepare('SELECT name FROM pragma_table_info(?)').all('roots').some((c) => c.name === 'chain')) {
      this.#db.exec('ALTER TABLE roots ADD COLUMN chain TEXT')
    }
    this.#isUsed = this.#db.prepare('SELECT 1 FROM used_sessions WHERE hash = ?')
    this.#isQueued = this.#db.prepare('SELECT 1 FROM queue WHERE commitment = ?')
    this.#use = this.#db.prepare('INSERT OR IGNORE INTO used_sessions (hash) VALUES (?)')
    this.#enqueue = this.#db.prepare('INSERT OR IGNORE INTO queue (commitment) VALUES (?)')
    this.#queued = this.#db.prepare('SELECT commitment FROM queue')
    this.#count = this.#db.prepare('SELECT count(*) AS n FROM queue')
    this.#remove = this.#db.prepare('DELETE FROM queue WHERE commitment = ?')
    this.#members = this.#db.prepare('SELECT commitment FROM list ORDER BY position')
    this.#roots = this.#db.prepare('SELECT size, root, time FROM roots ORDER BY size')
    this.#list = this.#db.prepare('INSERT INTO list (position, commitment) VALUES (?, ?)')
    this.#root = this.#db.prepare('INSERT INTO roots (size, root, time) VALUES (?, ?, ?)')
    this.#unwritten = this.#db.prepare('SELECT size, root, time FROM roots WHERE chain IS NULL ORDER BY size')
    this.#written = this.#db.prepare('UPDATE roots SET chain = ? WHERE size = ? AND chain IS NULL')
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

  /** The list, in order. */
  members(): bigint[] {
    return this.#members.all().map((row) => fromBytes32(row.commitment as Uint8Array))
  }

  /** Every root the list has had, oldest first. */
  roots(): Root[] {
    return this.#roots.all().map((row) => ({
      root: fromBytes32(row.root as Uint8Array),
      size: Number(row.size),
      time: Number(row.time),
    }))
  }

  /** The roots not yet written on chain, oldest first. */
  unwritten(): Root[] {
    return this.#unwritten.all().map((row) => ({
      root: fromBytes32(row.root as Uint8Array),
      size: Number(row.size),
      time: Number(row.time),
    }))
  }

  /** The root of the first `size` commitments is on chain, in the transaction `signature`. */
  written(size: number, signature: string): void {
    this.#written.run(signature, size)
  }

  /**
   * One batch, all or nothing: `added` onto the end of the list, in the order given; the list's new
   * root (with anything added, and only then); and every commitment in `done` out of the queue (the
   * added ones, and any found already listed).
   */
  append(added: bigint[], root: Root | undefined, done: bigint[]): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (added.length) {
        if (!root) throw new Error('commitments added with no root')
        const start = root.size - added.length
        added.forEach((c, i) => this.#list.run(start + i, toBytes32(c)))
        this.#root.run(root.size, toBytes32(root.root), root.time)
      }
      for (const c of done) this.#remove.run(toBytes32(c))
      this.#db.exec('COMMIT')
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Rewrite the file from its live rows only. */
  compact(): void {
    this.#db.exec('VACUUM')
  }

  close(): void {
    this.#db.close()
  }
}
