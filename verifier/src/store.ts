// The verifier's one file, five tables:
//
//   sessions       for each check session that gave a stamp: the SHA-256 of its id, the stamp number it
//                  was signed for, and which check it was (`face` or `id`), so a session gives its stamp
//                  to one stamp number only, and once its hour is over, is known as used
//   to_delete      for each session signed and not yet deleted in Didit: its id, which check it was,
//                  and when it was first signed, so it is signed again only within the hour after, and
//                  the sweep deletes it in Didit once the hour is over; it goes once Didit has
//                  deleted the session
//   fingerprints   for each person the ID check signed: their fingerprint (facts.ts), and the stamp
//                  number it was signed for, so a person seen again is signed again only for that one
//   id_payments    the transaction signature of each payment that opened an ID check, with the
//                  reference it named (public in that transaction) and whether Didit answered that it
//                  opened the session, so one payment opens one, for its own payment id only, and a
//                  session deleted once its stamp was signed is not opened again
//   gifts          each stamp number given its welcome gift (gift.ts), with a hash of the buy it was
//                  given for, so a person gets one, and the same buy asked again gets the same ticket
//
// Nothing else: no face, no embedding, no name, no birth date, no document, and of a gift only a hash
// of its buy. A session id is kept as its hash; in clear, and with a time, only in `to_delete`, until
// Didit has deleted the session, so then the file names no Didit session and holds no time.
// The stamp number links the tables: a person's fingerprint sits next to the same stamp number as the
// hashes of the sessions signed for it, face sessions included. Deleted bytes are overwritten
// (`secure_delete`).

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { fromBytes32, toBytes32 } from '@foundationforest/stamp'
import { base58 } from '@foundationforest/records'

import type { Check } from './didit.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

export type Remembered = 'ok' | 'session_used' | 'duplicate_document'

export class Store {
  readonly #db: DatabaseSync
  readonly #session: StatementSync
  readonly #fingerprint: StatementSync
  readonly #addSession: StatementSync
  readonly #addFingerprint: StatementSync
  readonly #pay: StatementSync
  readonly #paidFor: StatementSync
  readonly #open: StatementSync
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
      CREATE TABLE IF NOT EXISTS to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fingerprints (fingerprint BLOB PRIMARY KEY, stamp_number BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS id_payments (signature BLOB PRIMARY KEY, reference TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT stamp_number FROM sessions WHERE hash = ?')
    this.#fingerprint = this.#db.prepare('SELECT stamp_number FROM fingerprints WHERE fingerprint = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, stamp_number, kind) VALUES (?, ?, ?)')
    this.#addFingerprint = this.#db.prepare('INSERT OR IGNORE INTO fingerprints (fingerprint, stamp_number) VALUES (?, ?)')
    this.#pay = this.#db.prepare('INSERT OR IGNORE INTO id_payments (signature, reference) VALUES (?, ?)')
    this.#paidFor = this.#db.prepare('SELECT reference, opened FROM id_payments WHERE signature = ?')
    this.#open = this.#db.prepare('UPDATE id_payments SET opened = 1 WHERE signature = ?')
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
   * `check`, and when it passes, the session and the fingerprint kept with the stamp number, in one
   * transaction. Two requests can both pass every check before this while each waits for Didit; only
   * the first to get here keeps anything, and the second is checked against it.
   */
  remember(input: { sessionId: string; stampNumber: bigint; kind: Check; since: number; signedAt: number; fingerprint?: Uint8Array }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const outcome = this.check(input)
      if (outcome === 'ok') {
        const number = toBytes32(input.stampNumber)
        this.#addSession.run(sessionHash(input.sessionId), number, input.kind)
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

  /** Whom this payment, by its transaction's signature (base58), opened a check for: its reference; undefined if unused. */
  paymentFor(signature: string): string | undefined {
    return this.#paidFor.get(base58.decode(signature))?.reference as string | undefined
  }

  /** Marks a payment used for `reference`: true if it was free, or already used for that reference. It is never given back. */
  usePayment(signature: string, reference: string): boolean {
    this.#pay.run(base58.decode(signature), reference)
    return this.paymentFor(signature) === reference
  }

  /** The sessions first signed at `before` or earlier and not yet deleted in Didit, oldest first. */
  due(before: number): { sessionId: string; kind: Check }[] {
    return this.#due.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** Forgets a session's id and time, once Didit has deleted it. */
  deleted(sessionId: string): void {
    this.#deleted.run(sessionId)
  }

  /** Whether Didit answered that it opened this payment's session. */
  opened(signature: string): boolean {
    return this.#paidFor.get(base58.decode(signature))?.opened === 1
  }

  /** Marks that Didit answered that it opened this payment's session. */
  markOpened(signature: string): void {
    this.#open.run(base58.decode(signature))
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
