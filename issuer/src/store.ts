// The issuer's one file, four tables:
//
//   sessions       for each check session that gave a note: the SHA-256 of its id, the note number it
//                  was signed for, and which check it was (`face` or `id`), so a session gives its note
//                  to one note number only, and once Didit has deleted it, is known as used
//   fingerprints   for each person the ID check signed: their fingerprint (notes.ts), and the note
//                  number it was signed for, so a person seen again is signed again only for that one
//   id_payments    the transaction signature of each payment that opened an ID check, with the
//                  reference it named (public in that transaction) and whether Didit answered that it
//                  opened the session, so one payment opens one, for its own payment id only, and a
//                  session deleted once its note was signed is not opened again
//   gifts          each note number given its welcome gift (gift.ts), with a hash of the buy it was
//                  given for, so a person gets one, and the same buy asked again gets the same ticket
//
// Nothing else: no face, no embedding, no name, no birth date, no document, no time, and of a gift
// only a hash of its buy. A session id is kept only as its hash, so the file names no Didit session.
// The note number links the tables: a person's fingerprint sits next to the same note number as the
// hashes of the sessions signed for it, face sessions included. Deleted bytes are overwritten
// (`secure_delete`).

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { fromBytes32, toBytes32 } from '@foundationforest/note'
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

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, note_number BLOB NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fingerprints (fingerprint BLOB PRIMARY KEY, note_number BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS id_payments (signature BLOB PRIMARY KEY, reference TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS gifts (note_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT note_number FROM sessions WHERE hash = ?')
    this.#fingerprint = this.#db.prepare('SELECT note_number FROM fingerprints WHERE fingerprint = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, note_number, kind) VALUES (?, ?, ?)')
    this.#addFingerprint = this.#db.prepare('INSERT OR IGNORE INTO fingerprints (fingerprint, note_number) VALUES (?, ?)')
    this.#pay = this.#db.prepare('INSERT OR IGNORE INTO id_payments (signature, reference) VALUES (?, ?)')
    this.#paidFor = this.#db.prepare('SELECT reference, opened FROM id_payments WHERE signature = ?')
    this.#open = this.#db.prepare('UPDATE id_payments SET opened = 1 WHERE signature = ?')
    this.#give = this.#db.prepare('INSERT OR IGNORE INTO gifts (note_number, buy) VALUES (?, ?)')
    this.#given = this.#db.prepare('SELECT buy FROM gifts WHERE note_number = ?')
  }

  /** Whether this session gave a note. */
  holds(sessionId: string): boolean {
    return this.#session.get(sessionHash(sessionId)) !== undefined
  }

  /**
   * Whether a note for `noteNumber` may be signed from this session: the session gave no other note
   * number, and the person's fingerprint, if there is one, was signed for no other.
   */
  check(input: { sessionId: string; noteNumber: bigint; fingerprint?: Uint8Array }): Remembered {
    const other = (kept: Record<string, unknown> | undefined) => kept !== undefined && fromBytes32(kept.note_number as Uint8Array) !== input.noteNumber
    if (other(this.#session.get(sessionHash(input.sessionId)))) return 'session_used'
    if (input.fingerprint && other(this.#fingerprint.get(input.fingerprint))) return 'duplicate_document'
    return 'ok'
  }

  /**
   * `check`, and when it passes, the session and the fingerprint kept with the note number, in one
   * transaction. Two requests can both pass every check before this while each waits for Didit; only
   * the first to get here keeps anything, and the second is checked against it.
   */
  remember(input: { sessionId: string; noteNumber: bigint; kind: Check; fingerprint?: Uint8Array }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const outcome = this.check(input)
      if (outcome === 'ok') {
        const number = toBytes32(input.noteNumber)
        this.#addSession.run(sessionHash(input.sessionId), number, input.kind)
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

  /** Whether Didit answered that it opened this payment's session. */
  opened(signature: string): boolean {
    return this.#paidFor.get(base58.decode(signature))?.opened === 1
  }

  /** Marks that Didit answered that it opened this payment's session. */
  markOpened(signature: string): void {
    this.#open.run(base58.decode(signature))
  }

  /** Marks this note number's gift given for this buy: `given` the first time, `again` for the same buy, `other` for another. */
  giveGift(noteNumber: bigint, buy: Uint8Array): 'given' | 'again' | 'other' {
    if (Number(this.#give.run(toBytes32(noteNumber), buy).changes) === 1) return 'given'
    const kept = this.#given.get(toBytes32(noteNumber))?.buy as Uint8Array | undefined
    return kept && Buffer.from(kept).equals(Buffer.from(buy)) ? 'again' : 'other'
  }

  close(): void {
    this.#db.close()
  }
}
