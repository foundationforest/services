// The issuer's one file: for each list, the session ids already used, the stamps waiting for a
// batch, and the list with its snapshots. The face list's four tables have plain names; the ID
// list's are the same four with `id_` in front, and a fifth, `id_payments`: the transaction
// signature of each payment that has opened an ID check, so one payment opens one. Each list is a
// `Store` of its own on the one file.
//
// The session ids and the waiting stamps are two tables that share nothing. Neither has a timestamp
// or a row number, so nothing in them says which session brought which stamp, and each keeps its
// rows in key order. A stamp leaves the queue once it is on the list; what stays of a session is a
// hash of its id, which is all that refusing a second use needs.
//
// The list and its snapshots are public: the issuer publishes both (list.ts). The list keeps each
// stamp once, in list order, which within a batch is shuffled. A snapshot is kept with the size of
// the list it is the root of and the time its batch ran; its signature is made again from the key
// whenever the file is published, since ed25519 signs the same bytes the same way. A batch moves
// stamps from the queue to the list and adds their snapshot in one transaction, so a failure changes
// nothing.
//
// Deleting a row is not enough to take it out of the file: SQLite leaves deleted bytes in free
// space, and page rebuilds can leave stale copies of rows that moved, in insertion order. So deleted
// bytes are overwritten (`secure_delete`), and `compact` rewrites the whole file from what it holds
// now (`VACUUM`); the batch runs it after every flush. The rollback journal is deleted after each
// commit, and VACUUM's working copy stays in memory.

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { base58 } from '../../forest/records/src/bytes.ts'
import { fromBytes32, toBytes32 } from '../../forest/registry/client/src/field.ts'
import type { Tier } from './didit.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

export type Accepted = 'queued' | 'session_used' | 'stamp_queued'

/** One snapshot of the list: the root of its first `size` stamps, made by a batch at `time` (ms since 1970). */
export type Snapshot = { root: bigint; size: number; time: number }

/**
 * A file written before the list moved off chain names things as it did then: `commitment` for a
 * stamp, `roots` for the snapshots, and a `notes` column for the batches it wrote on chain. The same
 * rows, under today's names; the notes, which only said where on chain a batch was, go.
 */
function renameOld(db: DatabaseSync): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name as string))
  const columns = (table: string) => db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name as string)
  if (tables.has('roots') && !tables.has('snapshots')) db.exec('ALTER TABLE roots RENAME TO snapshots')
  if (tables.has('roots') || tables.has('snapshots')) {
    const cols = columns('snapshots')
    if (cols.includes('notes')) db.exec('ALTER TABLE snapshots DROP COLUMN notes')
    if (cols.includes('chain')) db.exec('ALTER TABLE snapshots DROP COLUMN chain')
  }
  if (tables.has('list') && columns('list').includes('commitment')) db.exec('ALTER TABLE list RENAME COLUMN commitment TO stamp')
  if (tables.has('queue') && columns('queue').includes('commitment')) db.exec('ALTER TABLE queue RENAME COLUMN commitment TO stamp')
}

export class Store {
  readonly #db: DatabaseSync
  readonly #isUsed: StatementSync
  readonly #isQueued: StatementSync
  readonly #use: StatementSync
  readonly #enqueue: StatementSync
  readonly #queued: StatementSync
  readonly #count: StatementSync
  readonly #remove: StatementSync
  readonly #stamps: StatementSync
  readonly #snapshots: StatementSync
  readonly #list: StatementSync
  readonly #snapshot: StatementSync
  readonly #pay: StatementSync | undefined
  readonly #unpay: StatementSync | undefined
  readonly #isPaid: StatementSync | undefined

  /** The face list's tables, or with `tier` `id`, the ID list's, on the same file. */
  constructor(path: string, tier: Tier = 'face') {
    const t = tier === 'id' ? 'id_' : ''
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
    `)
    if (tier === 'face') renameOld(this.#db)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ${t}used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${t}queue (stamp BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${t}list (position INTEGER PRIMARY KEY, stamp BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ${t}snapshots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL);
    `)
    this.#isUsed = this.#db.prepare(`SELECT 1 FROM ${t}used_sessions WHERE hash = ?`)
    this.#isQueued = this.#db.prepare(`SELECT 1 FROM ${t}queue WHERE stamp = ?`)
    this.#use = this.#db.prepare(`INSERT OR IGNORE INTO ${t}used_sessions (hash) VALUES (?)`)
    this.#enqueue = this.#db.prepare(`INSERT OR IGNORE INTO ${t}queue (stamp) VALUES (?)`)
    this.#queued = this.#db.prepare(`SELECT stamp FROM ${t}queue`)
    this.#count = this.#db.prepare(`SELECT count(*) AS n FROM ${t}queue`)
    this.#remove = this.#db.prepare(`DELETE FROM ${t}queue WHERE stamp = ?`)
    this.#stamps = this.#db.prepare(`SELECT stamp FROM ${t}list ORDER BY position`)
    this.#snapshots = this.#db.prepare(`SELECT size, root, time FROM ${t}snapshots ORDER BY size`)
    this.#list = this.#db.prepare(`INSERT INTO ${t}list (position, stamp) VALUES (?, ?)`)
    this.#snapshot = this.#db.prepare(`INSERT INTO ${t}snapshots (size, root, time) VALUES (?, ?, ?)`)
    if (tier === 'id') {
      this.#db.exec('CREATE TABLE IF NOT EXISTS id_payments (signature BLOB PRIMARY KEY) WITHOUT ROWID')
      this.#pay = this.#db.prepare('INSERT OR IGNORE INTO id_payments (signature) VALUES (?)')
      this.#unpay = this.#db.prepare('DELETE FROM id_payments WHERE signature = ?')
      this.#isPaid = this.#db.prepare('SELECT 1 FROM id_payments WHERE signature = ?')
    }
  }

  isUsed(sessionId: string): boolean {
    return this.#isUsed.get(sessionHash(sessionId)) !== undefined
  }

  isQueued(stamp: bigint): boolean {
    return this.#isQueued.get(toBytes32(stamp)) !== undefined
  }

  /**
   * Mark the session used and queue the stamp, both or neither. The keys decide: two requests
   * carrying one session can both pass every check before this, while each waits for Didit, and
   * only the first to get here queues anything.
   */
  accept(sessionId: string, stamp: bigint): Accepted {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      let outcome: Accepted = 'queued'
      if (Number(this.#use.run(sessionHash(sessionId)).changes) !== 1) outcome = 'session_used'
      else if (Number(this.#enqueue.run(toBytes32(stamp)).changes) !== 1) outcome = 'stamp_queued'
      this.#db.exec(outcome === 'queued' ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      // Left open, the transaction would make every later write and VACUUM fail.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Every stamp waiting, in key order, which is no order anyone chose. */
  queued(): bigint[] {
    return this.#queued.all().map((row) => fromBytes32(row.stamp as Uint8Array))
  }

  count(): number {
    return Number((this.#count.get() as { n: number | bigint }).n)
  }

  /** The list, in order. */
  stamps(): bigint[] {
    return this.#stamps.all().map((row) => fromBytes32(row.stamp as Uint8Array))
  }

  /** Every snapshot the list has had, oldest first. */
  snapshots(): Snapshot[] {
    return this.#snapshots.all().map((row) => ({
      root: fromBytes32(row.root as Uint8Array),
      size: Number(row.size),
      time: Number(row.time),
    }))
  }

  /**
   * One batch, all or nothing: `added` onto the end of the list, in the order given; the list's new
   * snapshot (with anything added, and only then); and every stamp in `done` out of the queue (the
   * added ones, and any found already listed).
   */
  append(added: bigint[], snapshot: Snapshot | undefined, done: bigint[]): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (added.length) {
        if (!snapshot) throw new Error('stamps added with no snapshot')
        const start = snapshot.size - added.length
        added.forEach((s, i) => this.#list.run(start + i, toBytes32(s)))
        this.#snapshot.run(snapshot.size, toBytes32(snapshot.root), snapshot.time)
      }
      for (const s of done) this.#remove.run(toBytes32(s))
      this.#db.exec('COMMIT')
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Whether this payment, by its transaction's signature (base58), has opened a check. The ID list only. */
  isPaymentUsed(signature: string): boolean {
    return this.#isPaid!.get(base58.decode(signature)) !== undefined
  }

  /** Marks a payment used: true if it was not before. Checking and marking are one statement. */
  usePayment(signature: string): boolean {
    return Number(this.#pay!.run(base58.decode(signature)).changes) === 1
  }

  /** Gives a payment back, when the check it was to open could not be opened. */
  releasePayment(signature: string): void {
    this.#unpay!.run(base58.decode(signature))
  }

  /** Rewrite the file from its live rows only. */
  compact(): void {
    this.#db.exec('VACUUM')
  }

  close(): void {
    this.#db.close()
  }
}
