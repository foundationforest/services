// The verifier's one file, seven tables:
//
//   sessions       for each check session that gave a stamp: the SHA-256 of its id, the stamp number it
//                  was signed for, and which check it was (`face` or `id`), so a session gives its stamp
//                  to one stamp number only, and once its hour is over, is known as used
//   stamps         for each stamp number and key (`face` or `id`): the first stamp that key signed for
//                  it, as its facts and its signature (r8, s), so a lost stamp is handed back
//   to_delete      for each session that gave a stamp and is not yet deleted in Didit: its id, which
//                  check it was, and when it was first signed, so it is signed again only within the
//                  hour after, and the sweep deletes it in Didit, keeping its face template, once the
//                  hour is over; it goes once Didit has deleted the session
//   opened         for each session the verifier opened that gave no stamp and is not yet deleted in
//                  Didit: its id, which check it was, when it opened, and for an ID session which of its
//                  payment's tries it was and the SHA-256 of that payment, while it is not used up, so
//                  it is stamped only with that payment, its refusal ends the payment only when it was
//                  the last try, and the sweep deletes it in Didit, face and all, a day after it opened;
//                  it goes once Didit has deleted the session, or moves to `to_delete` once it gives a
//                  stamp
//   gifts          each stamp number given its face stamp's gift (gift.ts), with a hash of the buy it
//                  was given for, so a person gets one, and the same buy asked again gets the same
//                  ticket
//   id_gifts       the same, for the ID stamp's gift
//   payments       each payment (stripe.ts) that opened an ID session: the SHA-256 of its id, how many
//                  sessions it opened, and whether it is used up (`stamped`: it gave a stamp, gave one
//                  back, or its hold was cancelled), so it opens at most ID_TRIES and gives one stamp
//
// Nothing else: no face, no embedding, no name, no birth date, no document, none of the fields beside a
// stamp, of a gift only a hash of its buy, and of a payment nothing of who paid or with what, no
// amount and no time, and nothing beside a stamp number. A session id is kept as its hash; in clear,
// and with a time, only in `to_delete` and `opened`, until Didit has deleted the session, a day at
// most, so then the file names no Didit session and holds no time. A payment sits beside the sessions
// it opened only there, and only until it is used up. The stamp number links `sessions`, `stamps` and
// the gifts: the hashes of the sessions signed for it, face and ID. Deleted bytes are overwritten
// (`secure_delete`), the dropped `fingerprints` table's among them: keyed hashes of a name and birth
// date, which this code no longer keeps.

import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { type StampSignature, fromBytes32, toBytes32 } from '@foundationforest/proofs'

import type { Check } from './didit.ts'

/** What the file keeps of a session id: its SHA-256, so the file lists no Didit session. */
export function sessionHash(sessionId: string): Uint8Array {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

/** What the file keeps of a payment's id: its SHA-256, so the file lists no payment. */
export function paymentHash(payment: string): Uint8Array {
  return createHash('sha256').update(payment, 'utf8').digest()
}

/** How many ID sessions one payment opens: the first try and two more. */
export const ID_TRIES = 3

export type Remembered = 'ok' | 'session_used' | 'not_paid' | 'payment_used'

/** What the file keeps of a stamp, beside its stamp number and key: its facts and its signature. */
export type KeptStamp = { facts: bigint; signature: StampSignature }

/** A stamp as the file keeps it: its facts, and its signature as r8 (x then y) and s. */
function keptStamp(row: Record<string, unknown>): KeptStamp {
  const r8 = row.r8 as Uint8Array
  return {
    facts: fromBytes32(row.facts as Uint8Array),
    signature: { R8: [fromBytes32(r8.subarray(0, 32)), fromBytes32(r8.subarray(32))], S: fromBytes32(row.s as Uint8Array) },
  }
}

export class Store {
  readonly #db: DatabaseSync
  readonly #session: StatementSync
  readonly #addSession: StatementSync
  readonly #addStamp: StatementSync
  readonly #stamps: StatementSync
  readonly #stampsOf: StatementSync
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
      CREATE TABLE IF NOT EXISTS opened (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, opened_at INTEGER NOT NULL, payment BLOB, try INTEGER) WITHOUT ROWID;
      DROP TABLE IF EXISTS fingerprints;
      CREATE TABLE IF NOT EXISTS gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS id_gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS payments (hash BLOB PRIMARY KEY, tries INTEGER NOT NULL, stamped INTEGER NOT NULL) WITHOUT ROWID;
    `)
    this.#session = this.#db.prepare('SELECT stamp_number FROM sessions WHERE hash = ?')
    this.#addSession = this.#db.prepare('INSERT OR IGNORE INTO sessions (hash, stamp_number, kind) VALUES (?, ?, ?)')
    this.#addStamp = this.#db.prepare('INSERT OR IGNORE INTO stamps (stamp_number, kind, facts, r8, s) VALUES (?, ?, ?, ?, ?)')
    this.#stamps = this.#db.prepare('SELECT kind, facts, r8, s FROM stamps WHERE stamp_number = ?')
    this.#stampsOf = this.#db.prepare('SELECT stamp_number, facts, r8, s FROM stamps WHERE kind = ?')
    this.#dropStamp = this.#db.prepare('DELETE FROM stamps WHERE stamp_number = ? AND kind = ?')
    const gifts = (table: string) => ({ give: this.#db.prepare(`INSERT OR IGNORE INTO ${table} (stamp_number, buy) VALUES (?, ?)`), given: this.#db.prepare(`SELECT buy FROM ${table} WHERE stamp_number = ?`) })
    this.#gifts = { face: gifts('gifts'), id: gifts('id_gifts') }
    this.#signedAt = this.#db.prepare('SELECT signed_at FROM to_delete WHERE session_id = ?')
    this.#addToDelete = this.#db.prepare('INSERT OR IGNORE INTO to_delete (session_id, kind, signed_at) VALUES (?, ?, ?)')
    this.#due = this.#db.prepare('SELECT session_id, kind FROM to_delete WHERE signed_at <= ? ORDER BY signed_at')
    this.#deleted = this.#db.prepare('DELETE FROM to_delete WHERE session_id = ?')
    // An ID session's try: how many its payment has opened, this one among them.
    this.#addOpened = this.#db.prepare('INSERT OR IGNORE INTO opened (session_id, kind, opened_at, payment, try) VALUES (?, ?, ?, ?, (SELECT tries FROM payments WHERE hash = ?))')
    this.#opener = this.#db.prepare('SELECT payment FROM opened WHERE session_id = ?')
    this.#tryOf = this.#db.prepare('SELECT try FROM opened WHERE session_id = ?')
    this.#stale = this.#db.prepare('SELECT session_id, kind FROM opened WHERE opened_at <= ? ORDER BY opened_at')
    this.#closed = this.#db.prepare('DELETE FROM opened WHERE session_id = ?')
    this.#unlink = this.#db.prepare('UPDATE opened SET payment = NULL WHERE payment = ?')
    this.#payment = this.#db.prepare('SELECT tries, stamped FROM payments WHERE hash = ?')
    this.#addPayment = this.#db.prepare('INSERT INTO payments (hash, tries, stamped) VALUES (?, 1, 0)')
    this.#tries = this.#db.prepare('UPDATE payments SET tries = tries + ? WHERE hash = ? AND stamped = 0')
    // Used up, a payment opens no more sessions, and the file forgets how many it took.
    this.#stamped = this.#db.prepare(`UPDATE payments SET stamped = 1, tries = ${ID_TRIES} WHERE hash = ?`)
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
   * `check`, and when it passes, the session and the stamp kept with the stamp number, the session
   * moved from `opened` to `to_delete`, and the payment used up, in one transaction. Two requests can
   * both pass every check before this while each waits for Didit; only the first to get here keeps
   * anything, and the second is checked against it. A session sent again within its hour uses no
   * payment.
   */
  remember(input: { sessionId: string; stampNumber: bigint; kind: Check; since: number; signedAt: number; stamp: KeptStamp; payment?: Uint8Array }): Remembered {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const again = this.holds(input.sessionId)
      const outcome = this.check(input)
      if (outcome === 'ok') {
        // The payment is only marked, and loses its sessions: nothing ties it to the stamp number.
        if (input.payment && !again) this.useUp(input.payment)
        const number = toBytes32(input.stampNumber)
        this.#addSession.run(sessionHash(input.sessionId), number, input.kind)
        // The first stamp a key signs for a stamp number stays: a later check for that number, by
        // anyone who knows it, never changes the stamp handed back. Any of them gives the same verification.
        const { facts, signature } = input.stamp
        this.#addStamp.run(number, input.kind, toBytes32(facts), Buffer.concat([toBytes32(signature.R8[0]), toBytes32(signature.R8[1])]), toBytes32(signature.S))
        // The first signing's time stays: a session signed again within its hour gets no more time.
        this.#addToDelete.run(input.sessionId, input.kind, input.signedAt)
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

  /** The stamps kept for this stamp number, by key: the first each key signed for it. */
  stamps(stampNumber: bigint): Partial<Record<Check, KeptStamp>> {
    const kept: Partial<Record<Check, KeptStamp>> = {}
    for (const row of this.#stamps.all(toBytes32(stampNumber))) kept[row.kind as Check] = keptStamp(row)
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
      this.#dropStamp.run(row.stamp_number as Uint8Array, kind)
      dropped++
    }
    return dropped
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

  /** The sessions first signed at `before` or earlier and not yet deleted in Didit, oldest first. */
  due(before: number): { sessionId: string; kind: Check }[] {
    return this.#due.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** The sessions opened at `before` or earlier that gave no stamp and are not yet deleted in Didit, oldest first. */
  stale(before: number): { sessionId: string; kind: Check }[] {
    return this.#stale.all(before).map((r) => ({ sessionId: r.session_id as string, kind: r.kind as Check }))
  }

  /** Forgets a session's id and time, once Didit has deleted it. */
  deleted(sessionId: string): void {
    this.#deleted.run(sessionId)
    this.#closed.run(sessionId)
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
   * One of the payment's tries, for a session about to open: `ok`, or `payment_used` once it gave its
   * stamp or opened ID_TRIES sessions. The first try keeps the payment, as paid.
   */
  takeTry(payment: Uint8Array): 'ok' | 'payment_used' {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const paid = this.#payment.get(payment)
      let outcome: 'ok' | 'payment_used' = 'ok'
      if (!paid) this.#addPayment.run(payment)
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
