// The verifier's one file, twelve tables:
//
//   sessions       for each check session that gave a stamp: the SHA-256 of its id, the stamp number it
//                  was signed for, and which check it was (`face` or `id`), so a session gives its stamp
//                  to one stamp number only, and once its hour is over is known as used
//   stamps         for each stamp number: the first stamp the face key signed for it, and every stamp
//                  the ID key signed for it, each as its facts and its signature (r8, s), so a lost
//                  stamp is handed back
//   to_delete      for each session that gave a stamp, until its hour is over: its id, which check it
//                  was, when it was first signed, and whether Didit keeps its face (one whose stamp
//                  number's face Didit held none of, `faces`), so it is signed again only within the
//                  hour after; then the sweep deletes the session in Didit, keeping its face template
//                  or not; it goes once Didit has deleted the session
//   opened         for each session the verifier opened that gave no stamp and is not yet deleted in
//                  Didit: its id, which check it was, when it opened, and `try`: for an ID session which
//                  of its payment's tries it was, with the SHA-256 of that payment while it is not used
//                  up, so it is stamped only with that payment, its refusal ends the payment only when it
//                  was the last try; for a face session, 1 once it counted as its stamp number's free
//                  try, so it counts once. The sweep asks Didit about it every minute, and deletes
//                  it in Didit, face and all, a day after it opened; it goes then, or moves to
//                  `to_delete` once it gives a stamp
//   refused        for each opened session Didit refused (Declined or In Review), or that the verifier
//                  could not sign for want of a face: its id, the code the app is told (codes.ts), the
//                  SHA-256 of the `vendor_data` Didit holds it under beside its id (`ownerOf`), and
//                  whether Didit has deleted it, so the sweep deletes it in Didit at once, face and all,
//                  and the app still gets its code when it asks, for that stamp number only; it goes
//                  with its `opened` row, a day after the session opened
//   face_tries     for each stamp number a face session of which Didit finished without giving it a
//                  stamp: how many such sessions, so it opens no face session after FACE_TRIES
//   gifts          each stamp number given its face stamp's gift (gift.ts), with a hash of the buy it
//                  was given for, so a person gets one, and the same buy asked again gets the same
//                  ticket
//   id_gifts       the same, for the ID stamp's gift
//   payments       each payment (stripe.ts) that opened an ID session: the SHA-256 of its Checkout
//                  Session's id, how many sessions it opened, whether it is used up (`stamped`: it
//                  gave a stamp, or its hold was cancelled), and when it opened its first, so it opens
//                  at most ID_TRIES and gives one stamp; it goes 30 days after (server.ts)
//   fingerprints   for each ID stamp, its scrambled copy (fingerprint.ts): its first name, first last
//                  name, birth date, personal number, ID type and country, each scrambled on its own,
//                  beside its stamp number's keyed hash, the `vendor_data` its Didit user is under, for
//                  good, so no other stamp number gets an ID stamp for the same person; one row for the
//                  same details twice
//   faces          each stamp number's hash whose face Didit holds, and until when: five years after
//                  the template was kept, when the sweep deletes its Didit user; so a stamp number keeps
//                  one template, and the scrambled copy knows whether a face is there to compare
//   deletions      each stamp number's hash whose face its person asked to delete: when it runs, 28
//                  days after the ask, and when it ran, so the app can say so; it goes 90 days after it
//                  ran
//
// Nothing else: no face, no embedding, no name, no birth date, no document, none of the list beside a
// stamp, of a gift only a hash of its buy, and of a payment nothing of who paid or with what, no
// amount, and nothing beside a stamp number. A session id is kept as its hash; in clear only in
// `to_delete`, `opened` and `refused`, with a time in the first two, for a day at most, so then the
// file names no Didit session. A payment sits beside the sessions it opened only there, and only until
// it is used up. The stamp number links `sessions`, `stamps`, `face_tries` and the gifts: the hashes of
// the sessions signed for it, face and ID; its keyed hash, which takes the verifier's secret to make,
// links `fingerprints`, `faces` and `deletions`. Deleted bytes are overwritten (`secure_delete`).

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { type StampSignature, fromBytes32, toBytes32 } from '@foundationforest/proofs'

import type { Check } from './didit.ts'
import { COLUMNS, type Fingerprint } from './fingerprint.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

/**
 * What the file keeps of whose a refused session is: the SHA-256 of its `vendor_data` and its id, so
 * it tells the stamp number the session was opened for from any other, and no two rows tell they are
 * one stamp number's.
 */
export function ownerOf(vendorData: string, sessionId: string): Uint8Array {
  return createHash('sha256').update(vendorData, 'utf8').update(Uint8Array.of(0)).update(sessionId, 'utf8').digest()
}

/** What the file keeps of a payment's id: its SHA-256, so the file lists no payment. */
export function paymentHash(payment: string): Uint8Array {
  return createHash('sha256').update(payment, 'utf8').digest()
}

/** How many ID sessions one payment opens: the first try and two more. */
export const ID_TRIES = 3

/** How many face sessions Didit may finish without giving their stamp number a stamp before it opens no more: one free face check. */
export const FACE_TRIES = 1

export type Remembered = 'ok' | 'session_used' | 'not_paid' | 'payment_used'

/** What the file keeps of a stamp, beside its stamp number and key: its facts and its signature. */
export type KeptStamp = { facts: bigint; signature: StampSignature }

/** The stamps kept for a stamp number: the first face stamp, and every ID stamp. */
export type Kept = { face?: KeptStamp; id: KeptStamp[] }

/** A stamp as the file keeps it: its facts, and its signature as r8 (x then y) and s. */
function keptStamp(row: Record<string, unknown>): KeptStamp {
  const r8 = row.r8 as Uint8Array
  return {
    facts: fromBytes32(row.facts as Uint8Array),
    signature: { R8: [fromBytes32(r8.subarray(0, 32)), fromBytes32(r8.subarray(32))], S: fromBytes32(row.s as Uint8Array) },
  }
}

/** The stamps table's columns: one row a stamp, so a stamp number holds every ID stamp signed for it. */
const STAMPS = 'stamp_number BLOB NOT NULL, kind TEXT NOT NULL, facts BLOB NOT NULL, r8 BLOB NOT NULL, s BLOB NOT NULL, PRIMARY KEY (stamp_number, kind, facts)'

/** Whether Didit keeps a session's face when it is deleted; 1 for the rows of a file from before it was kept. */
const KEEP_FACE = 'keep_face INTEGER NOT NULL DEFAULT 1'

/**
 * The scrambled copies' columns, each a detail's scrambled bytes, or none for one the ID lacks, and
 * the stamp number's keyed hash; the details first, so a row is found by its first name, first last
 * name and birth date.
 */
const FINGERPRINTS = `${COLUMNS.map((column) => `${column} BLOB NOT NULL`).join(', ')}, owner BLOB NOT NULL, PRIMARY KEY (${COLUMNS.join(', ')}, owner)`

/** A stamp number's keyed hash as the file keeps it: the 32 bytes of its `vendor_data`'s hex. */
const owner = (vendorData: string) => Buffer.from(vendorData, 'hex')
const vendorDataOf = (row: Record<string, unknown>) => Buffer.from(row.owner as Uint8Array).toString('hex')

/** What became of a stamp number's ask to delete its face: when it runs, or when it ran. */
export type Deletion = { state: 'requested'; runsAt: number } | { state: 'done'; doneAt: number }

export class Store {
  readonly #db: DatabaseSync
  readonly #session: StatementSync
  readonly #addSession: StatementSync
  readonly #addStamp: StatementSync
  readonly #stamps: StatementSync
  readonly #stampsOf: StatementSync
  readonly #stampNumbers: StatementSync
  readonly #dropStamp: StatementSync
  /** Each check's gift: give one, and the buy one was given for. */
  readonly #gifts: Record<Check, { give: StatementSync; given: StatementSync }>
  readonly #signedAt: StatementSync
  readonly #addToDelete: StatementSync
  readonly #due: StatementSync
  readonly #deleted: StatementSync
  readonly #addOpened: StatementSync
  readonly #opener: StatementSync
  readonly #tryOf: StatementSync
  readonly #stale: StatementSync
  readonly #closed: StatementSync
  readonly #unlink: StatementSync
  readonly #payment: StatementSync
  readonly #addPayment: StatementSync
  readonly #tries: StatementSync
  readonly #stamped: StatementSync
  readonly #faceTries: StatementSync
  readonly #markTry: StatementSync
  readonly #addFaceTry: StatementSync
  readonly #refuse: StatementSync
  readonly #refusal: StatementSync
  readonly #toPoll: StatementSync
  readonly #toRefuse: StatementSync
  readonly #gone: StatementSync
  readonly #forgetRefusal: StatementSync
  readonly #addFingerprint: StatementSync
  readonly #holders: StatementSync
  readonly #face: StatementSync
  readonly #addFace: StatementSync
  readonly #dropFace: StatementSync
  readonly #facesEnded: StatementSync
  readonly #askDeletion: StatementSync
  readonly #deletion: StatementSync
  readonly #undo: StatementSync
  readonly #deletionsDue: StatementSync
  readonly #ran: StatementSync
  readonly #forgetDeletions: StatementSync
  readonly #forgetPayments: StatementSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    // `secure_delete` and `temp_store` last only as long as the connection, so they are set on every open.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = DELETE;
    `)
    this.#moveOn()
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, stamp_number BLOB NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS stamps (${STAMPS}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL, ${KEEP_FACE}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS opened (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, opened_at INTEGER NOT NULL, payment BLOB, try INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS refused (session_id TEXT PRIMARY KEY, code TEXT NOT NULL, owner BLOB NOT NULL, gone INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS face_tries (stamp_number BLOB PRIMARY KEY, tries INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS id_gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS payments (hash BLOB PRIMARY KEY, tries INTEGER NOT NULL, stamped INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fingerprints (${FINGERPRINTS}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS faces (owner BLOB PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS deletions (owner BLOB PRIMARY KEY, runs_at INTEGER NOT NULL, done_at INTEGER) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT stamp_number FROM sessions WHERE hash = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, stamp_number, kind) VALUES (?, ?, ?)')
    this.#addStamp = this.#db.prepare('INSERT OR IGNORE INTO stamps (stamp_number, kind, facts, r8, s) VALUES (?, ?, ?, ?, ?)')
    this.#stamps = this.#db.prepare('SELECT kind, facts, r8, s FROM stamps WHERE stamp_number = ? ORDER BY kind, facts')
    this.#stampsOf = this.#db.prepare('SELECT stamp_number, facts, r8, s FROM stamps WHERE kind = ?')
    this.#stampNumbers = this.#db.prepare('SELECT DISTINCT stamp_number FROM stamps')
    this.#dropStamp = this.#db.prepare('DELETE FROM stamps WHERE stamp_number = ? AND kind = ? AND facts = ?')
    const gifts = (table: string) => ({ give: this.#db.prepare(`INSERT OR IGNORE INTO ${table} (stamp_number, buy) VALUES (?, ?)`), given: this.#db.prepare(`SELECT buy FROM ${table} WHERE stamp_number = ?`) })
    this.#gifts = { face: gifts('gifts'), id: gifts('id_gifts') }
    this.#signedAt = this.#db.prepare('SELECT signed_at FROM to_delete WHERE session_id = ?')
    this.#addToDelete = this.#db.prepare('INSERT OR IGNORE INTO to_delete (session_id, kind, signed_at, keep_face) VALUES (?, ?, ?, ?)')
    this.#due = this.#db.prepare('SELECT session_id, kind, keep_face FROM to_delete WHERE signed_at <= ? ORDER BY signed_at')
    this.#deleted = this.#db.prepare('DELETE FROM to_delete WHERE session_id = ?')
    // An ID session's try: how many its payment has opened, this one among them.
    this.#addOpened = this.#db.prepare('INSERT OR IGNORE INTO opened (session_id, kind, opened_at, payment, try) VALUES (?, ?, ?, ?, (SELECT tries FROM payments WHERE hash = ?))')
    this.#opener = this.#db.prepare('SELECT payment FROM opened WHERE session_id = ?')
    this.#tryOf = this.#db.prepare('SELECT try FROM opened WHERE session_id = ?')
    this.#stale = this.#db.prepare('SELECT o.session_id, o.kind, r.gone FROM opened o LEFT JOIN refused r ON r.session_id = o.session_id WHERE o.opened_at <= ? ORDER BY o.opened_at')
    this.#closed = this.#db.prepare('DELETE FROM opened WHERE session_id = ?')
    this.#unlink = this.#db.prepare('UPDATE opened SET payment = NULL WHERE payment = ?')
    this.#payment = this.#db.prepare('SELECT tries, stamped FROM payments WHERE hash = ?')
    this.#addPayment = this.#db.prepare('INSERT INTO payments (hash, tries, stamped, at) VALUES (?, 1, 0, ?)')
    this.#tries = this.#db.prepare('UPDATE payments SET tries = tries + ? WHERE hash = ? AND stamped = 0')
    // Used up, a payment opens no more sessions, and the file forgets how many it took.
    this.#stamped = this.#db.prepare(`UPDATE payments SET stamped = 1, tries = ${ID_TRIES} WHERE hash = ?`)
    this.#faceTries = this.#db.prepare('SELECT tries FROM face_tries WHERE stamp_number = ?')
    // A face session counts once, and only while it is opened and gave no stamp.
    this.#markTry = this.#db.prepare("UPDATE opened SET try = 1 WHERE session_id = ? AND kind = 'face' AND try IS NULL")
    this.#addFaceTry = this.#db.prepare('INSERT INTO face_tries (stamp_number, tries) VALUES (?, 1) ON CONFLICT (stamp_number) DO UPDATE SET tries = tries + 1')
    // Only a session opened and giving no stamp is refused, and its first code stays.
    this.#refuse = this.#db.prepare('INSERT OR IGNORE INTO refused (session_id, code, owner, gone) SELECT session_id, ?, ?, 0 FROM opened WHERE session_id = ?')
    this.#refusal = this.#db.prepare('SELECT code, owner FROM refused WHERE session_id = ?')
    this.#toPoll = this.#db.prepare('SELECT session_id, kind FROM opened WHERE session_id NOT IN (SELECT session_id FROM refused) ORDER BY opened_at')
    this.#toRefuse = this.#db.prepare('SELECT r.session_id, o.kind FROM refused r JOIN opened o ON o.session_id = r.session_id WHERE r.gone = 0 ORDER BY o.opened_at')
    this.#gone = this.#db.prepare('UPDATE refused SET gone = 1 WHERE session_id = ?')
    this.#forgetRefusal = this.#db.prepare('DELETE FROM refused WHERE session_id = ?')
    this.#addFingerprint = this.#db.prepare(`INSERT OR IGNORE INTO fingerprints (${COLUMNS.join(', ')}, owner) VALUES (${COLUMNS.map(() => '?').join(', ')}, ?)`)
    // The rule: the first name, the first last name and the birth date, and not the country.
    this.#holders = this.#db.prepare('SELECT DISTINCT owner FROM fingerprints WHERE first_name = ? AND last_name = ? AND birth = ?')
    this.#face = this.#db.prepare('SELECT until FROM faces WHERE owner = ?')
    this.#addFace = this.#db.prepare('INSERT OR IGNORE INTO faces (owner, until) VALUES (?, ?)')
    this.#dropFace = this.#db.prepare('DELETE FROM faces WHERE owner = ?')
    this.#facesEnded = this.#db.prepare('SELECT owner FROM faces WHERE until <= ? ORDER BY until')
    // Asked while one waits, the first stays; asked after one ran, it waits again.
    this.#askDeletion = this.#db.prepare('INSERT INTO deletions (owner, runs_at, done_at) VALUES (?, ?, NULL) ON CONFLICT (owner) DO UPDATE SET runs_at = excluded.runs_at, done_at = NULL WHERE done_at IS NOT NULL')
    this.#deletion = this.#db.prepare('SELECT runs_at, done_at FROM deletions WHERE owner = ?')
    this.#undo = this.#db.prepare('DELETE FROM deletions WHERE owner = ? AND done_at IS NULL')
    this.#deletionsDue = this.#db.prepare('SELECT owner FROM deletions WHERE done_at IS NULL AND runs_at <= ? ORDER BY runs_at')
    this.#ran = this.#db.prepare('UPDATE deletions SET done_at = ? WHERE owner = ? AND done_at IS NULL')
    this.#forgetDeletions = this.#db.prepare('DELETE FROM deletions WHERE done_at <= ?')
    this.#forgetPayments = this.#db.prepare('DELETE FROM payments WHERE at <= ?')
  }

  /**
   * A file an earlier version wrote, moved to this one's tables: `stamps` keyed by its stamp number,
   * key and facts, as it holds every ID stamp, its rows copied; `to_delete` with `keep_face`, 1 for
   * every row, as every session that gave a stamp kept its face then; `payments` with when, now for
   * every row; and an earlier `fingerprints`, of keyed hashes of a name and a birth date, dropped.
   */
  #moveOn(): void {
    const sql = (table: string) => this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql as string | undefined
    const stamps = sql('stamps')
    if (stamps !== undefined && !stamps.includes('PRIMARY KEY (stamp_number, kind, facts)')) {
      this.#db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE stamps RENAME TO stamps_before;
        CREATE TABLE stamps (${STAMPS}) WITHOUT ROWID;
        INSERT INTO stamps (stamp_number, kind, facts, r8, s) SELECT stamp_number, kind, facts, r8, s FROM stamps_before;
        DROP TABLE stamps_before;
        COMMIT;
      `)
    }
    const toDelete = sql('to_delete')
    if (toDelete !== undefined && !toDelete.includes('keep_face')) this.#db.exec(`ALTER TABLE to_delete ADD COLUMN ${KEEP_FACE}`)
    // A payment kept before it had a time: counted from now, so none goes before its 30 days.
    const payments = sql('payments')
    if (payments !== undefined && !payments.includes(' at ')) this.#db.exec(`ALTER TABLE payments ADD COLUMN at INTEGER NOT NULL DEFAULT ${Math.floor(Date.now())}`)
    // An earlier version's table of the same name, of keyed hashes of a name and a birth date.
    if (sql('fingerprints')?.includes('first_name') === false) this.#db.exec('DROP TABLE fingerprints')
  }

  /** Whether this session gave a stamp. */
  holds(sessionId: string): boolean {
    return this.#session.get(sessionHash(sessionId)) !== undefined
  }

  /**
   * Whether a stamp for `stampNumber` may be signed from this session: the session gave no other stamp
   * number, and, if it gave this one, was first signed after `since` (within its hour, and not yet
   * deleted); for a session that gave no stamp yet, the payment, if one is asked, is not used up and
   * is the one that opened the session.
   */
  check(input: { sessionId: string; stampNumber: bigint; since: number; payment?: Uint8Array }): Remembered {
    const kept = this.#session.get(sessionHash(input.sessionId))
    if (kept !== undefined && fromBytes32(kept.stamp_number as Uint8Array) !== input.stampNumber) return 'session_used'
    if (kept) {
      // The same stamp number again: only within the session's hour, while Didit still has it.
      const signedAt = this.#signedAt.get(input.sessionId)?.signed_at as number | undefined
      if (signedAt === undefined || signedAt <= input.since) return 'session_used'
    } else if (input.payment) {
      const paid = this.#payment.get(input.payment)
      if (!paid) return 'not_paid'
      if (paid.stamped) return 'payment_used'
      const opener = this.opener(input.sessionId)
      if (!opener || !Buffer.from(opener).equals(Buffer.from(input.payment))) return 'not_paid'
    }
    return 'ok'
  }

  /**
   * `check`, and when it passes, the session and its stamps kept with the stamp number, the session
   * moved from `opened` to `to_delete`, and the payment used up, in one transaction. `face` is the
   * face stamp an ID check signs from its selfie beside its ID stamp, kept only if the stamp number
   * holds none. `vendorData` is the stamp number's keyed hash: when Didit holds no face of it, this
   * session's is kept, till `faceUntil`; an ID stamp's scrambled copy, `fingerprint`, is kept beside it. Two requests can
   * both pass every check before this while each waits for Didit; only the first to get here keeps
   * anything, and the second is checked against it. A session sent again within its hour uses no
   * payment.
   */
  remember(input: {
    sessionId: string
    stampNumber: bigint
    vendorData: string
    kind: Check
    since: number
    signedAt: number
    faceUntil: number
    stamp: KeptStamp
    face?: KeptStamp
    fingerprint?: Fingerprint
    payment?: Uint8Array
  }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const again = this.holds(input.sessionId)
      const outcome = this.check(input)
      if (outcome === 'ok') {
        // The payment is only marked, and loses its sessions: nothing ties it to the stamp number.
        if (input.payment && !again) this.useUp(input.payment)
        const number = toBytes32(input.stampNumber)
        this.#addSession.run(sessionHash(input.sessionId), number, input.kind)
        const held = this.stamps(input.stampNumber)
        const add = (kind: Check, { facts, signature }: KeptStamp) =>
          this.#addStamp.run(number, kind, toBytes32(facts), Buffer.concat([toBytes32(signature.R8[0]), toBytes32(signature.R8[1])]), toBytes32(signature.S))
        // The first face stamp stays: a later check for that number, by anyone who knows it, never
        // changes the face stamp handed back, and any face stamp gives the same verification. Every ID
        // stamp is kept, one for each document checked.
        const firstFace = !held.face && (input.kind === 'face' || input.face !== undefined)
        if (input.kind === 'id') add('id', input.stamp)
        if (firstFace) add('face', input.kind === 'face' ? input.stamp : input.face!)
        // Didit keeps one face template a stamp number, of either check: this session's when it holds
        // none, as after a face deleted, or one whose years are over. The first signing's time and
        // choice stay: a session signed again within its hour gets no more time.
        const keepFace = !again && !this.faceKept(input.vendorData)
        if (keepFace) this.#addFace.run(owner(input.vendorData), input.faceUntil)
        if (input.fingerprint) this.#addFingerprint.run(...COLUMNS.map((column) => input.fingerprint![column]), owner(input.vendorData))
        this.#addToDelete.run(input.sessionId, input.kind, input.signedAt, keepFace ? 1 : 0)
        this.#closed.run(input.sessionId)
      }
      this.#db.exec(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      // Left open, the transaction would make every later write fail.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Whether Didit holds a face of the stamp number under this `vendor_data`: one kept, its years not over, and not deleted. */
  faceKept(vendorData: string): boolean {
    return this.#face.get(owner(vendorData)) !== undefined
  }

  /** The `vendor_data` of each stamp number whose scrambled copy matches this one: its first name, first last name and birth date. */
  holders(fingerprint: Fingerprint): string[] {
    return this.#holders.all(fingerprint.first_name, fingerprint.last_name, fingerprint.birth).map(vendorDataOf)
  }

  /** The stamp numbers, by `vendor_data`, whose face template's years are over at `at`. */
  facesEnded(at: number): string[] {
    return this.#facesEnded.all(at).map(vendorDataOf)
  }

  /** Didit holds no face of this stamp number any more: its user is deleted. */
  faceGone(vendorData: string): void {
    this.#dropFace.run(owner(vendorData))
  }

  /** The person asks to delete their face, to run at `runsAt`: when it runs, the first such time while one waits. */
  askDeletion(vendorData: string, runsAt: number): number {
    this.#askDeletion.run(owner(vendorData), runsAt)
    return this.#deletion.get(owner(vendorData))!.runs_at as number
  }

  /** The person no longer asks: whether a deletion was waiting. */
  undoDeletion(vendorData: string): boolean {
    return Number(this.#undo.run(owner(vendorData)).changes) === 1
  }

  /** What became of this stamp number's ask to delete its face, if it asked and it did not go. */
  deletion(vendorData: string): Deletion | undefined {
    const row = this.#deletion.get(owner(vendorData))
    if (!row) return undefined
    return row.done_at === null ? { state: 'requested', runsAt: row.runs_at as number } : { state: 'done', doneAt: row.done_at as number }
  }

  /** The stamp numbers, by `vendor_data`, whose face deletion is due at `at`, the oldest first. */
  deletionsDue(at: number): string[] {
    return this.#deletionsDue.all(at).map(vendorDataOf)
  }

  /** The face deleted, at `at`: Didit holds none of it, and the deletion has run. */
  faceDeleted(vendorData: string, at: number): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#dropFace.run(owner(vendorData))
      this.#ran.run(at, owner(vendorData))
      this.#db.exec('COMMIT')
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Forgets each deletion that ran at `deletionsBefore` or earlier, and each payment first used at `paymentsBefore` or earlier. */
  forget(deletionsBefore: number, paymentsBefore: number): void {
    this.#forgetDeletions.run(deletionsBefore)
    this.#forgetPayments.run(paymentsBefore)
  }

  /** Every stamp number that holds a stamp, of either key. */
  stampNumbers(): bigint[] {
    return this.#stampNumbers.all().map((r) => fromBytes32(r.stamp_number as Uint8Array))
  }

  /** The stamps kept for this stamp number: the first face stamp signed for it, and every ID stamp. */
  stamps(stampNumber: bigint): Kept {
    const kept: Kept = { id: [] }
    for (const row of this.#stamps.all(toBytes32(stampNumber))) {
      if (row.kind === 'id') kept.id.push(keptStamp(row))
      else kept.face ??= keptStamp(row)
    }
    return kept
  }

  /**
   * Forgets each stamp kept for this check that `signed` says its key did not sign, so that stamp
   * number's next check keeps a new one; how many it forgot.
   */
  dropUnsigned(kind: Check, signed: (stampNumber: bigint, stamp: KeptStamp) => boolean): number {
    let dropped = 0
    for (const row of this.#stampsOf.all(kind)) {
      if (signed(fromBytes32(row.stamp_number as Uint8Array), keptStamp(row))) continue
      this.#dropStamp.run(row.stamp_number as Uint8Array, kind, row.facts as Uint8Array)
      dropped++
    }
    return dropped
  }

  /** How many of this stamp number's face sessions Didit finished without giving it a stamp. */
  faceTries(stampNumber: bigint): number {
    return (this.#faceTries.get(toBytes32(stampNumber))?.tries as number | undefined) ?? 0
  }

  /** A face session Didit finished that gave this stamp number no stamp: one of its tries, once a session. */
  faceTry(sessionId: string, stampNumber: bigint): void {
    if (Number(this.#markTry.run(sessionId).changes) === 1) this.#addFaceTry.run(toBytes32(stampNumber))
  }

  /** A session the verifier opened, at `at`; for an ID session, after its try was taken, with the payment that opened it. */
  opened(sessionId: string, kind: Check, at: number, payment?: Uint8Array): void {
    this.#addOpened.run(sessionId, kind, at, payment ?? null, payment ?? null)
  }

  /** Whether this session took its payment's last try: the newest the payment can open. */
  lastTry(sessionId: string): boolean {
    return this.#tryOf.get(sessionId)?.try === ID_TRIES
  }

  /** The payment that opened this session, while it is not used up. */
  opener(sessionId: string): Uint8Array | undefined {
    return (this.#opener.get(sessionId)?.payment as Uint8Array | null | undefined) ?? undefined
  }

  /** The sessions first signed at `before` or earlier and not yet deleted in Didit, oldest first, each with whether Didit keeps its face. */
  due(before: number): { sessionId: string; kind: Check; keepFace: boolean }[] {
    return this.#due.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check, keepFace: r.keep_face === 1 }))
  }

  /**
   * The sessions opened at `before` or earlier that gave no stamp, oldest first, each with whether
   * Didit has already deleted it, as a refused one.
   */
  stale(before: number): { sessionId: string; kind: Check; gone: boolean }[] {
    return this.#stale.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check, gone: r.gone === 1 }))
  }

  /** The sessions opened that gave no stamp and Didit has not refused, oldest first: those the sweep asks Didit about. */
  undecided(): { sessionId: string; kind: Check }[] {
    return this.#toPoll.all().map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** A refusal of an opened session, by its code and its `vendor_data` at Didit; the first one stays. */
  refuse(sessionId: string, code: string, vendorData: string): void {
    this.#refuse.run(code, ownerOf(vendorData, sessionId), sessionId)
  }

  /** The code a session was refused with, if it was, and whether it was opened under this `vendor_data`. */
  refusal(sessionId: string, vendorData: string): { code: string; theirs: boolean } | undefined {
    const row = this.#refusal.get(sessionId)
    return row && { code: row.code as string, theirs: Buffer.from(row.owner as Uint8Array).equals(Buffer.from(ownerOf(vendorData, sessionId))) }
  }

  /** The refused sessions not yet deleted in Didit, oldest first. */
  refusedNotGone(): { sessionId: string; kind: Check }[] {
    return this.#toRefuse.all().map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** A refused session Didit has deleted: kept, with its code, till its day. */
  gone(sessionId: string): void {
    this.#gone.run(sessionId)
  }

  /** Forgets a session's id and time, once Didit has deleted it. */
  deleted(sessionId: string): void {
    this.#deleted.run(sessionId)
    this.#closed.run(sessionId)
    this.#forgetRefusal.run(sessionId)
  }

  /** Whether this payment opened a session. */
  knowsPayment(payment: Uint8Array): boolean {
    return this.#payment.get(payment) !== undefined
  }

  /** How many more sessions this payment may open: none once it is used up. */
  triesLeft(payment: Uint8Array): number {
    const paid = this.#payment.get(payment)
    return !paid || paid.stamped ? 0 : ID_TRIES - (paid.tries as number)
  }

  /** The payment used up: no more sessions, no stamp, and no longer beside the sessions it opened. */
  useUp(payment: Uint8Array): void {
    this.#stamped.run(payment)
    this.#unlink.run(payment)
  }

  /**
   * One of the payment's tries, for a session about to open, at `at`: `ok`, or `payment_used` once it
   * gave its stamp or opened ID_TRIES sessions. The first try keeps the payment, as paid, and when.
   */
  takeTry(payment: Uint8Array, at: number): 'ok' | 'payment_used' {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const paid = this.#payment.get(payment)
      let outcome: 'ok' | 'payment_used' = 'ok'
      if (!paid) this.#addPayment.run(payment, at)
      else if (paid.stamped || (paid.tries as number) >= ID_TRIES) outcome = 'payment_used'
      else this.#tries.run(1, payment)
      this.#db.exec('COMMIT')
      return outcome
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** A try back, for a session Didit did not open. */
  giveBackTry(payment: Uint8Array): void {
    this.#tries.run(-1, payment)
  }

  /** Marks this stamp number's gift from this check given for this buy: `given` the first time, `again` for the same buy, `other` for another. */
  giveGift(stampNumber: bigint, check: Check, buy: Uint8Array): 'given' | 'again' | 'other' {
    const { give, given } = this.#gifts[check]
    if (Number(give.run(toBytes32(stampNumber), buy).changes) === 1) return 'given'
    const kept = given.get(toBytes32(stampNumber))?.buy as Uint8Array | undefined
    return kept && Buffer.from(kept).equals(Buffer.from(buy)) ? 'again' : 'other'
  }

  close(): void {
    this.#db.close()
  }
}
