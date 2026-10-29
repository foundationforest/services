// The verifier's one file, five tables:
//
//   sessions       for each check session that gave a stamp: the SHA-256 of its id, the stamp number it
//                  was signed for, and which check it was (`face` or `id`), so a session gives its stamp
//                  to one stamp number only, and once its hour is over, is known as used
//   stamps         for each stamp number and key (`face` or `id`): the first stamp that key signed for
//                  it, as its facts and its signature (r8, s), so a lost stamp is handed back
//   to_delete      for each session signed and not yet deleted in Didit: its id, which check it was,
//                  and when it was first signed, so it is signed again only within the hour after, and
//                  the sweep deletes it in Didit once the hour is over; it goes once Didit has
//                  deleted the session
//   fingerprints   for each person the ID check signed: their fingerprint (facts.ts), and the stamp
//                  number it was signed for, so a person seen again is signed again only for that one
//   gifts          each stamp number given its welcome gift (gift.ts), with a hash of the buy it was
//                  given for, so a person gets one, and the same buy asked again gets the same ticket
//
// Nothing else: no face, no embedding, no name, no birth date, no document, none of the fields beside a
// stamp, and of a gift only a hash of its buy. A session id is kept as its hash; in clear, and with a time, only in `to_delete`, until
// Didit has deleted the session, so then the file names no Didit session and holds no time.
// The stamp number links the tables: a person's fingerprint sits next to the same stamp number as the
// hashes of the sessions signed for it, face sessions included. Deleted bytes are overwritten
// (`secure_delete`).

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { type StampSignature, fromBytes32, toBytes32 } from '@foundationforest/verification'

import type { Check } from './didit.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

export type Remembered = 'ok' | 'session_used' | 'duplicate_document'

/** What the file keeps of a stamp, beside its stamp number and key: its facts and its signature. */
export type KeptStamp = { facts: bigint; signature: StampSignature }

export class Store {
  readonly #db: DatabaseSync
  readonly #session: StatementSync
  readonly #fingerprint: StatementSync
  readonly #addSession: StatementSync
  readonly #addFingerprint: StatementSync
  readonly #addStamp: StatementSync
  readonly #stamps: StatementSync
  readonly #give: StatementSync
  readonly #given: StatementSync
  readonly #signedAt: StatementSync
  readonly #addToDelete: StatementSync
  readonly #due: StatementSync
  readonly #deleted: StatementSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, stamp_number BLOB NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS stamps (stamp_number BLOB NOT NULL, kind TEXT NOT NULL, facts BLOB NOT NULL, r8 BLOB NOT NULL, s BLOB NOT NULL, PRIMARY KEY (stamp_number, kind)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fingerprints (fingerprint BLOB PRIMARY KEY, stamp_number BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT stamp_number FROM sessions WHERE hash = ?')
    this.#fingerprint = this.#db.prepare('SELECT stamp_number FROM fingerprints WHERE fingerprint = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, stamp_number, kind) VALUES (?, ?, ?)')
    this.#addFingerprint = this.#db.prepare('INSERT OR IGNORE INTO fingerprints (fingerprint, stamp_number) VALUES (?, ?)')
    this.#addStamp = this.#db.prepare('INSERT OR IGNORE INTO stamps (stamp_number, kind, facts, r8, s) VALUES (?, ?, ?, ?, ?)')
    this.#stamps = this.#db.prepare('SELECT kind, facts, r8, s FROM stamps WHERE stamp_number = ?')
    this.#give = this.#db.prepare('INSERT OR IGNORE INTO gifts (stamp_number, buy) VALUES (?, ?)')
    this.#given = this.#db.prepare('SELECT buy FROM gifts WHERE stamp_number = ?')
    this.#signedAt = this.#db.prepare('SELECT signed_at FROM to_delete WHERE session_id = ?')
    this.#addToDelete = this.#db.prepare('INSERT OR IGNORE INTO to_delete (session_id, kind, signed_at) VALUES (?, ?, ?)')
    this.#due = this.#db.prepare('SELECT session_id, kind FROM to_delete WHERE signed_at <= ? ORDER BY signed_at')
    this.#deleted = this.#db.prepare('DELETE FROM to_delete WHERE session_id = ?')
  }

  /** Whether this session gave a stamp. */
  holds(sessionId: string): boolean {
    return this.#session.get(sessionHash(sessionId)) !== undefined
  }

  /**
   * Whether a stamp for `stampNumber` may be signed from this session: the session gave no other stamp
   * number, and, if it gave this one, was first signed after `since` (within its hour, and not yet
   * deleted); and the person's fingerprint, if there is one, was signed for no other.
   */
  check(input: { sessionId: string; stampNumber: bigint; since: number; fingerprint?: Uint8Array }): Remembered {
    const other = (kept: Record<string, unknown> | undefined) => kept !== undefined && fromBytes32(kept.stamp_number as Uint8Array) !== input.stampNumber
    const kept = this.#session.get(sessionHash(input.sessionId))
    if (other(kept)) return 'session_used'
    if (kept) {
      // The same stamp number again: only within the session's hour, while Didit still has it.
      const signedAt = this.#signedAt.get(input.sessionId)?.signed_at as number | undefined
      if (signedAt === undefined || signedAt <= input.since) return 'session_used'
    }
    if (input.fingerprint && other(this.#fingerprint.get(input.fingerprint))) return 'duplicate_document'
    return 'ok'
  }

  /**
   * `check`, and when it passes, the session, the stamp and the fingerprint kept with the stamp
   * number, in one transaction. Two requests can both pass every check before this while each waits
   * for Didit; only the first to get here keeps anything, and the second is checked against it.
   */
  remember(input: { sessionId: string; stampNumber: bigint; kind: Check; since: number; signedAt: number; stamp: KeptStamp; fingerprint?: Uint8Array }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const outcome = this.check(input)
      if (outcome === 'ok') {
        const number = toBytes32(input.stampNumber)
        this.#addSession.run(sessionHash(input.sessionId), number, input.kind)
        // The first stamp a key signs for a stamp number stays: a later check for that number, by
        // anyone who knows it, never changes the stamp handed back. Any of them gives the same verification.
        const { facts, signature } = input.stamp
        this.#addStamp.run(number, input.kind, toBytes32(facts), Buffer.concat([toBytes32(signature.R8[0]), toBytes32(signature.R8[1])]), toBytes32(signature.S))
        // The first signing's time stays: a session signed again within its hour gets no more time.
        this.#addToDelete.run(input.sessionId, input.kind, input.signedAt)
        if (input.fingerprint) this.#addFingerprint.run(input.fingerprint, number)
      }
      this.#db.exec(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      // Left open, the transaction would make every later write fail.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** The stamps kept for this stamp number, by key: the first each key signed for it. */
  stamps(stampNumber: bigint): Partial<Record<Check, KeptStamp>> {
    const kept: Partial<Record<Check, KeptStamp>> = {}
    for (const row of this.#stamps.all(toBytes32(stampNumber))) {
      const r8 = row.r8 as Uint8Array
      kept[row.kind as Check] = {
        facts: fromBytes32(row.facts as Uint8Array),
        signature: { R8: [fromBytes32(r8.subarray(0, 32)), fromBytes32(r8.subarray(32))], S: fromBytes32(row.s as Uint8Array) },
      }
    }
    return kept
  }

  /** The sessions first signed at `before` or earlier and not yet deleted in Didit, oldest first. */
  due(before: number): { sessionId: string; kind: Check }[] {
    return this.#due.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** Forgets a session's id and time, once Didit has deleted it. */
  deleted(sessionId: string): void {
    this.#deleted.run(sessionId)
  }

  /** Marks this stamp number's gift given for this buy: `given` the first time, `again` for the same buy, `other` for another. */
  giveGift(stampNumber: bigint, buy: Uint8Array): 'given' | 'again' | 'other' {
    if (Number(this.#give.run(toBytes32(stampNumber), buy).changes) === 1) return 'given'
    const kept = this.#given.get(toBytes32(stampNumber))?.buy as Uint8Array | undefined
    return kept && Buffer.from(kept).equals(Buffer.from(buy)) ? 'again' : 'other'
  }

  close(): void {
    this.#db.close()
  }
}
