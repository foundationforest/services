// A stand-in for Didit and for Stripe, an embedder that knows people by name, a fresh verifier seed, a person's stamp number, and the check that the file keeps nothing it shouldn't.

import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { seedNumber, stampNumberOf } from '@foundationforest/keys'
import { fromBytes32 } from '@foundationforest/proofs'
import { hex } from '@foundationforest/folders'

import type { Check, Decision, Document, FaceCheck } from '../src/didit.ts'
import { EMBEDDING_BYTES, FaceError, type Embedder } from '../src/face.ts'
import { paymentHash, sessionHash } from '../src/store.ts'
import type { Payments, Prices } from '../src/stripe.ts'

export const FACE_WORKFLOW = '7f9f3c52-1b1e-4c4b-9d0f-2a6e4b1c0d11'
export const ID_WORKFLOW = '0b6e2f1a-3c4d-4e5f-8a9b-1c2d3e4f5a6b'
export const VERIFIER_NAME = 'verifier.test.forest.example'

/** The selfie of `person`, as the stand-in Didit names it: the test embedder reads the name back. */
export const selfie = (person: string) => `https://didit.example/photo/${person}`

/**
 * What a face check that passed looks like: approved, one liveness step approved, the person's
 * selfie. Its `vendor_data`, left empty, is the one the session was opened under (`FakeFaceCheck.set`).
 */
export const passed = (person: string, over: Partial<Decision> = {}): Decision => ({
  workflowId: FACE_WORKFLOW,
  vendorData: '',
  status: 'Approved',
  liveness: [{ status: 'Approved' }],
  documents: [],
  faceMatches: [],
  risks: [],
  faceImage: selfie(person),
  document: null,
  ...over,
})

/** A document as Didit reads one: its text fields, by Didit's names. */
export const doc = (lastName: string, over: Document = {}): Document => ({
  first_name: 'Ada',
  last_name: lastName,
  full_name: `Ada ${lastName}`,
  date_of_birth: '1990-04-01',
  issuing_state: 'GBR',
  document_type: 'Passport',
  document_number: 'AB1234567',
  address: '12 St James Square, London',
  ...over,
})

/** What an ID check that passed looks like: the document, the liveness step and the face match, each approved. */
export const passedId = (person: string, document: Document = doc(person), over: Partial<Decision> = {}): Decision =>
  passed(person, { workflowId: ID_WORKFLOW, documents: [{ status: 'Approved' }], faceMatches: [{ status: 'Approved' }], document, ...over })

/**
 * Faces by name: each person's embedding is a fixed random direction made from their name, so one
 * person matches themselves exactly and two people hardly at all. The photo `none` has no face.
 */
export function namedFaces(): Embedder & { embedded: number } {
  const faces = {
    model: 'test-model',
    embedded: 0,
    async embed(photo: Uint8Array) {
      const name = new TextDecoder().decode(photo)
      if (name === 'none') throw new FaceError('no_face')
      faces.embedded++
      return faceOf(name)
    },
  }
  return faces
}

/** The embedding `namedFaces` gives `name`. */
export function faceOf(name: string): Uint8Array {
  const values = Float32Array.from({ length: EMBEDDING_BYTES / 4 }, (_, i) => createHash('sha256').update(`${name}/${i}`).digest().readInt32LE(0) / 2 ** 31)
  const out = new Uint8Array(EMBEDDING_BYTES)
  const view = new DataView(out.buffer)
  const length = Math.hypot(...values)
  values.forEach((v, i) => view.setFloat32(i * 4, v / length, true))
  return out
}

/** A person's stamp number for the test verifier, as their app derives it: from a fresh seed and the verifier's name. */
export const stampNumber = async () => stampNumberOf(seedNumber(new Uint8Array(randomBytes(32))), VERIFIER_NAME)

/** What Didit refusing a check looks like: Declined, or In Review, with the risks of the warnings that set it. */
export const refusedWith = (risks: string[], over: Partial<Decision> = {}): Decision => passed('nobody', { status: 'Declined', liveness: [{ status: 'Declined' }], risks, ...over })

/** One Didit application, as both checks share it: its sessions' decisions. */
export class FakeApplication {
  readonly sessions = new Map<string, Decision>()
}

/**
 * Didit, as far as one check sees it: its workflow's sessions, in the application both checks share.
 * A test says what each session came to with `set`.
 * With `hold`, decisions wait until the test lets them go, so two requests can both be waiting at
 * once. A photo is its selfie address's last part, the person's name.
 */
export class FakeFaceCheck implements FaceCheck {
  readonly sessions: Map<string, Decision>
  down = false
  /** What Didit not answering throws, whichever way it is down. */
  fail: Error = new Error('down')
  photoDown = false
  waiting = 0
  /** How many sessions Didit was asked to open. */
  created = 0
  /** The callback each session was opened with, by session id. */
  readonly callbacks = new Map<string, string | undefined>()
  /** The `vendor_data` each session was opened under, by session id. */
  readonly vendorData = new Map<string, string>()
  /** Each session deleted, in order, and those deleted keeping the face; with `deleteDown`, Didit does not answer a deletion; `outcome` is what it says it did with a face it was asked to keep. */
  readonly deleted: string[] = []
  readonly keptFaces: string[] = []
  deleteDown = false
  outcome = 'retained_with_user'
  /** How many times Didit was asked what a session decided. */
  asked = 0
  /** Each Didit user deleted, by `vendor_data`, in order; with `usersDown`, Didit does not answer a user's deletion. */
  readonly deletedUsers: string[] = []
  usersDown = false
  #gate: Promise<void> | undefined

  constructor(application: FakeApplication = new FakeApplication()) {
    this.sessions = application.sessions
  }

  async createSession({ vendorData, callback }: { vendorData: string; callback?: string }) {
    if (this.down) throw this.fail
    this.created++
    const sessionId = randomUUID()
    this.callbacks.set(sessionId, callback)
    this.vendorData.set(sessionId, vendorData)
    return { sessionId, url: `https://verify.example/session/${sessionId}` }
  }

  /** What a session came to: `decision`, under the `vendor_data` it was opened with unless the decision names one. */
  set(sessionId: string, decision: Decision) {
    this.sessions.set(sessionId, { ...decision, vendorData: decision.vendorData || this.vendorData.get(sessionId) || '' })
  }

  hold(): () => void {
    let release!: () => void
    this.#gate = new Promise((r) => (release = r))
    return () => {
      this.#gate = undefined
      release()
    }
  }

  async decision(sessionId: string) {
    this.asked++
    this.waiting++
    try {
      await (this.#gate ?? new Promise((r) => setImmediate(r)))
      if (this.down) throw this.fail
      return this.sessions.get(sessionId) ?? null
    } finally {
      this.waiting--
    }
  }

  async deleteSession(sessionId: string, keepFace: boolean) {
    if (this.deleteDown) throw this.fail
    if (!this.sessions.delete(sessionId)) return 'gone'
    this.deleted.push(sessionId)
    if (!keepFace) return 'deleted'
    this.keptFaces.push(sessionId)
    return this.outcome
  }

  async deleteUser(vendorData: string) {
    if (this.usersDown) throw this.fail
    this.deletedUsers.push(vendorData)
  }

  async photo(url: string) {
    if (this.photoDown) throw this.fail
    return new TextEncoder().encode(url.split('/').at(-1))
  }
}

/** The two Prices the stand-in Stripe sells: $5 for a stamp number's first ID stamp, $2 for each after. */
export const PRICES: Prices = { price: { amount: 500, currency: 'usd' }, addedPrice: { amount: 200, currency: 'usd' } }

/**
 * Stripe, as far as the verifier sees it: its two Prices, unless `pricesDown`; the Checkout pages it
 * made, each with the page it sends the person back to and whether it sells the added-ID Price; and
 * each payment's hold: when it was held, by `clock`, and whether it is held, taken or cancelled. A test
 * pays one with `pay`, by its Checkout Session's id.
 */
export class FakePayments implements Payments {
  /** Its payments are `cs_test_…`, as a test key's are. */
  readonly test = true
  readonly publishableKey = 'pk_test_standin'
  /** The page each Checkout page sends the person back to, or undefined for one embedded, by its Checkout Session's id. */
  readonly returnUrls = new Map<string, string | undefined>()
  /** The client secret of each embedded Checkout page, by its Checkout Session's id. */
  readonly clientSecrets = new Map<string, string>()
  /** Whether each Checkout page sells the added-ID Price, by its Checkout Session's id. */
  readonly added = new Map<string, boolean>()
  /** Stripe not answering for its Prices alone. */
  pricesDown = false
  readonly #holds = new Map<string, { at: number; state: 'held' | 'taken' | 'cancelled' }>()
  readonly #clock: () => number
  down = false
  /** What Stripe not answering throws. */
  fail: Error = new Error('down')
  /** How many times Stripe was asked whether a payment holds its money. */
  asked = 0
  /** The `before` of each search for old holds. */
  readonly searched: number[] = []

  constructor(clock: () => number = Date.now) {
    this.#clock = clock
  }

  async prices() {
    if (this.down || this.pricesDown) throw this.fail
    return PRICES
  }

  async checkout(returnUrl: string | undefined, added: boolean) {
    if (this.down) throw this.fail
    const payment = `cs_test_${randomBytes(24).toString('hex')}`
    this.returnUrls.set(payment, returnUrl)
    this.added.set(payment, added)
    if (returnUrl !== undefined) return { payment, url: `https://checkout.stripe.example/c/pay/${payment}` }
    const clientSecret = `${payment}_secret_${randomBytes(12).toString('hex')}`
    this.clientSecrets.set(payment, clientSecret)
    return { payment, clientSecret }
  }

  /** The payment paid, by its Checkout Session's id or as the verifier answered it. */
  pay(payment: string) {
    this.#holds.set(checkoutOf(payment), { at: this.#clock(), state: 'held' })
  }

  /** What became of a payment's hold, by its Checkout Session's id or as the verifier answered it. */
  state(payment: string) {
    return this.#holds.get(checkoutOf(payment))?.state
  }

  async held(payment: string) {
    this.asked++
    if (this.down) throw this.fail
    const hold = this.#holds.get(payment)
    return hold && hold.state !== 'cancelled' ? hold.at : null
  }

  async capture(payment: string) {
    if (this.down) throw this.fail
    const hold = this.#holds.get(payment)
    if (!hold || hold.state === 'cancelled') return false
    hold.state = 'taken'
    return true
  }

  async cancel(payment: string) {
    if (this.down) throw this.fail
    const hold = this.#holds.get(checkoutOf(payment))
    if (!hold) return 'none' as const
    if (hold.state === 'held') hold.state = 'cancelled'
    return hold.state === 'taken' ? ('taken' as const) : ('cancelled' as const)
  }

  async cancelOld(before: number) {
    if (this.down) throw this.fail
    this.searched.push(before)
    let cancelled = 0
    for (const hold of this.#holds.values()) {
      if (hold.state === 'held' && hold.at < before) {
        hold.state = 'cancelled'
        cancelled++
      }
    }
    return { cancelled, failed: 0 }
  }
}

/** A payment's Checkout Session's id: what comes before the dot in the payment the verifier answers. */
export const checkoutOf = (payment: string) => payment.split('.')[0]!

/** A fresh verifier seed as its file holds it, and its 32 bytes. */
export function seedJson(): { json: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(randomBytes(32))
  return { json: JSON.stringify({ seed: hex.encode(bytes) }), bytes }
}

/** Every file SQLite may have written next to the database. */
const sideFiles = (path: string) => [`${path}-journal`, `${path}-wal`, `${path}-shm`]

const TABLES = [
  'CREATE TABLE face_tries (stamp_number BLOB PRIMARY KEY, tries INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID',
  'CREATE TABLE id_gifts (stamp_number BLOB PRIMARY KEY, buy BLOB NOT NULL) WITHOUT ROWID',
  'CREATE TABLE opened (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, opened_at INTEGER NOT NULL, payment BLOB, try INTEGER) WITHOUT ROWID',
  'CREATE TABLE payments (hash BLOB PRIMARY KEY, tries INTEGER NOT NULL, stamped INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE refused (session_id TEXT PRIMARY KEY, code TEXT NOT NULL, owner BLOB NOT NULL, gone INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE sessions (hash BLOB PRIMARY KEY, stamp_number BLOB NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID',
  'CREATE TABLE stamps (stamp_number BLOB NOT NULL, kind TEXT NOT NULL, facts BLOB NOT NULL, r8 BLOB NOT NULL, s BLOB NOT NULL, PRIMARY KEY (stamp_number, kind, facts)) WITHOUT ROWID',
  'CREATE TABLE to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL, keep_face INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID',
]

/**
 * What the file should hold: the sessions that gave stamps, with their stamp numbers and checks; of
 * those, the ones not yet deleted in Didit; the sessions opened that gave no stamp and are not yet
 * deleted, each with the payment that opened it while it is open, or null; of those, each refused,
 * with its code; each stamp number's face tries; the stamp numbers given each check's gift; each
 * payment that opened an ID session, by its Checkout Session's id, with its tries and whether it is
 * used up.
 */
export type Expected = { sessions: [string, bigint, Check][]; toDelete?: string[]; opened?: [string, string | null][]; refused?: [string, string][]; faceTries?: [bigint, number][]; gifts?: bigint[]; idGifts?: bigint[]; payments?: [string, number, boolean][]; never: string[] }

/**
 * The file holds nine tables and nothing else: each session that gave a stamp as the hash of its id,
 * next to its stamp number and its check; one face stamp for each stamp number those sessions gave a
 * stamp, as an ID check gives one too, and one ID stamp for each ID session; those not yet deleted in
 * Didit, by id; each stamp number's face tries; the sessions opened that gave no stamp and are not yet
 * deleted, by id, each with the hash of the payment that opened it or none, and those refused, with
 * their codes; the stamp numbers given
 * each check's gift, each with a hash of its buy; each payment as the hash of its id, with its tries
 * and whether it is used up, and nothing else. None of `never` (names, birth dates, embeddings, a
 * gift's buy) is anywhere in its bytes, no payment id and no other session id is in the clear, and no
 * journal is left beside it.
 */
export function assertKept(path: string, expected: Expected): void {
  for (const side of sideFiles(path)) assert.equal(existsSync(side), false, `no ${side} is left`)
  const file = readFileSync(path)
  for (const text of expected.never) assert.equal(file.includes(Buffer.from(text)), false, `${text.slice(0, 24)} is not in the file`)
  const payments = expected.payments ?? []
  for (const [payment] of payments) {
    for (const text of [payment, checkoutOf(payment)]) assert.equal(file.includes(Buffer.from(text)), false, 'no payment and no Checkout Session id is in the clear')
  }
  const toDelete = expected.toDelete ?? []
  for (const [sessionId] of expected.sessions) {
    if (!toDelete.includes(sessionId)) assert.equal(file.includes(Buffer.from(sessionId)), false, 'no deleted session id is in the clear')
  }
  const opened = expected.opened ?? []

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    assert.deepEqual(schema.map((t) => t.sql), TABLES, 'nine tables, and no index or other table beside them')
    const sessions = db
      .prepare('SELECT hash, stamp_number, kind FROM sessions')
      .all()
      .map((r) => `${Buffer.from(r.hash as Uint8Array).toString('hex')} ${fromBytes32(r.stamp_number as Uint8Array)} ${r.kind}`)
      .sort()
    const want = expected.sessions.map(([id, n, kind]) => `${Buffer.from(sessionHash(id)).toString('hex')} ${n} ${kind}`).sort()
    assert.deepEqual(sessions, want, 'each session that gave a stamp, hashed, next to its stamp number and its check')
    const stamps = db
      .prepare('SELECT stamp_number, kind FROM stamps')
      .all()
      .map((r) => `${fromBytes32(r.stamp_number as Uint8Array)} ${r.kind}`)
      .sort()
    const wantStamps = [...new Set(expected.sessions.map(([, n]) => `${n} face`)), ...expected.sessions.filter(([, , kind]) => kind === 'id').map(([, n]) => `${n} id`)].sort()
    assert.deepEqual(stamps, wantStamps, 'one face stamp for each stamp number a session gave a stamp, and one ID stamp for each ID session')
    const tries = db
      .prepare('SELECT stamp_number, tries FROM face_tries')
      .all()
      .map((r) => `${fromBytes32(r.stamp_number as Uint8Array)} ${r.tries}`)
      .sort()
    assert.deepEqual(tries, (expected.faceTries ?? []).map(([n, count]) => `${n} ${count}`).sort(), 'each stamp number’s face tries, a count, and nothing of them beside it')
    const pending = db
      .prepare('SELECT session_id FROM to_delete')
      .all()
      .map((r) => r.session_id as string)
      .sort()
    assert.deepEqual(pending, [...toDelete].sort(), 'by id, only the sessions not yet deleted in Didit')
    const open = db
      .prepare('SELECT session_id, payment FROM opened')
      .all()
      .map((r) => `${r.session_id} ${r.payment ? Buffer.from(r.payment as Uint8Array).toString('hex') : 'none'}`)
      .sort()
    const wantOpen = opened.map(([id, payment]) => `${id} ${payment ? Buffer.from(paymentHash(checkoutOf(payment))).toString('hex') : 'none'}`).sort()
    assert.deepEqual(open, wantOpen, 'by id, the sessions opened that gave no stamp and are not yet deleted, each beside its payment only while that is open')
    const refused = db
      .prepare('SELECT session_id, code FROM refused')
      .all()
      .map((r) => `${r.session_id} ${r.code}`)
      .sort()
    assert.deepEqual(refused, (expected.refused ?? []).map(([id, code]) => `${id} ${code}`).sort(), 'by id, the sessions refused, each with its code')
    for (const [table, given] of [['gifts', expected.gifts], ['id_gifts', expected.idGifts]] as const) {
      const gifts = db
        .prepare(`SELECT stamp_number FROM ${table}`)
        .all()
        .map((r) => fromBytes32(r.stamp_number as Uint8Array))
        .sort()
      assert.deepEqual(gifts, [...(given ?? [])].sort(), `the stamp numbers given a gift, in ${table}, and of the gift only a hash of its buy`)
    }
    const paid = db
      .prepare('SELECT hash, tries, stamped FROM payments')
      .all()
      .map((r) => `${Buffer.from(r.hash as Uint8Array).toString('hex')} ${r.tries} ${r.stamped}`)
      .sort()
    const wantPaid = payments.map(([payment, tries, stamped]) => `${Buffer.from(paymentHash(checkoutOf(payment))).toString('hex')} ${tries} ${stamped ? 1 : 0}`).sort()
    assert.deepEqual(paid, wantPaid, 'each payment, hashed, with its tries and whether it gave a stamp, and nothing beside it')
  } finally {
    db.close()
  }
}
