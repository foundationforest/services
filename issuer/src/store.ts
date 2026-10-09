// The issuer's one file, three tables:
//
//   sessions       for each check session that gave a note, and each earlier session Didit's face
//                  search found the same face in: the SHA-256 of its id, and the note number that face
//                  was signed for, so a face seen again is signed again only for the same note number
//   fingerprints   for each document that gave a note: its fingerprint (notes.ts), and the note number
//                  it was signed for, so a person seen again is signed again only for the same one
//   id_payments    the transaction signature of each payment that opened a document check, so one
//                  payment opens one
//
// Nothing else: no face, no embedding, no name, no document, no time, no row number. A session id is
// kept only as its hash, so the file names no Didit session. The note number links the two tables
// of notes: a document's fingerprint sits next to the same note number as the hashes of the
// sessions signed for it, its face-check sessions included. So the file does say which document
// went with which face-check sessions, and whoever also holds Didit's records of those sessions can
// tell which face.
//
// A file the issuer kept before notes, when it published lists, holds their tables: the lists, their
// snapshots, the stamps waiting and the sessions used. They are dropped at start, and the file
// rewritten (`VACUUM`), so none of their bytes stays. Deleted bytes are overwritten (`secure_delete`).

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { base58 } from '../../standard/records/src/bytes.ts'
import { fromBytes32, toBytes32 } from '../../standard/registry/client/src/field.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

/** The tables of the lists this issuer once published (and of the batches that filled them). */
const LIST_TABLES = ['used_sessions', 'queue', 'list', 'snapshots', 'roots', 'id_used_sessions', 'id_queue', 'id_list', 'id_snapshots']

export type Remembered = 'ok' | 'session_used' | 'duplicate_face' | 'duplicate_document'

export class Store {
  readonly #db: DatabaseSync
  readonly #session: StatementSync
  readonly #fingerprint: StatementSync
  readonly #addSession: StatementSync
  readonly #addFingerprint: StatementSync
  readonly #pay: StatementSync
  readonly #unpay: StatementSync
  readonly #isPaid: StatementSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
    `)
    const tables = new Set(this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name as string))
    const old = LIST_TABLES.filter((t) => tables.has(t))
    for (const table of old) this.#db.exec(`DROP TABLE ${table}`)
    if (old.length) this.#db.exec('VACUUM')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, note_number BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fingerprints (fingerprint BLOB PRIMARY KEY, note_number BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS id_payments (signature BLOB PRIMARY KEY) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT note_number FROM sessions WHERE hash = ?')
    this.#fingerprint = this.#db.prepare('SELECT note_number FROM fingerprints WHERE fingerprint = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, note_number) VALUES (?, ?)')
    this.#addFingerprint = this.#db.prepare('INSERT OR IGNORE INTO fingerprints (fingerprint, note_number) VALUES (?, ?)')
    this.#pay = this.#db.prepare('INSERT OR IGNORE INTO id_payments (signature) VALUES (?)')
    this.#unpay = this.#db.prepare('DELETE FROM id_payments WHERE signature = ?')
    this.#isPaid = this.#db.prepare('SELECT 1 FROM id_payments WHERE signature = ?')
  }

  /** The note number this session gave, if it gave one. */
  noteNumberOf(sessionId: string): bigint | undefined {
    const row = this.#session.get(sessionHash(sessionId))
    return row ? fromBytes32(row.note_number as Uint8Array) : undefined
  }

  /**
   * Whether a note for `noteNumber` may be signed from this session: the session gave no other note
   * number; no earlier session with the same face (`earlier`, Didit's face search) gave another; and
   * the document's fingerprint, if there is one, was signed for no other.
   */
  check(input: { sessionId: string; noteNumber: bigint; earlier?: string[]; fingerprint?: Uint8Array }): Remembered {
    const other = (row: Record<string, unknown> | undefined) => row !== undefined && fromBytes32(row.note_number as Uint8Array) !== input.noteNumber
    if (other(this.#session.get(sessionHash(input.sessionId)))) return 'session_used'
    if ((input.earlier ?? []).some((id) => other(this.#session.get(sessionHash(id))))) return 'duplicate_face'
    if (input.fingerprint && other(this.#fingerprint.get(input.fingerprint))) return 'duplicate_document'
    return 'ok'
  }

  /**
   * `check`, and when it passes, the session, the earlier sessions of the same face and the
   * fingerprint kept with the note number, all in one transaction. Two requests can both pass every
   * check before this while each waits for Didit; only the first to get here keeps anything, and the
   * second is checked against it. The earlier sessions are kept too, so an earlier session of this
   * face sent late, whose own search could not see this one, is refused for another note number.
   */
  remember(input: { sessionId: string; noteNumber: bigint; earlier?: string[]; fingerprint?: Uint8Array }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const outcome = this.check(input)
      if (outcome === 'ok') {
        const number = toBytes32(input.noteNumber)
        for (const id of [input.sessionId, ...(input.earlier ?? [])]) this.#addSession.run(sessionHash(id), number)
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

  /** Whether this payment, by its transaction's signature (base58), has opened a check. */
  isPaymentUsed(signature: string): boolean {
    return this.#isPaid.get(base58.decode(signature)) !== undefined
  }

  /** Marks a payment used: true if it was not before. Checking and marking are one statement. */
  usePayment(signature: string): boolean {
    return Number(this.#pay.run(base58.decode(signature)).changes) === 1
  }

  /** Gives a payment back, when the check it was to open could not be opened. */
  releasePayment(signature: string): void {
    this.#unpay.run(base58.decode(signature))
  }

  close(): void {
    this.#db.close()
  }
}
