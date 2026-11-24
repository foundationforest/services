// The verifier's routes. The ones a person's app calls are POST with a JSON body, so nothing a person
// sends is ever in a URL: hosting platforms log the path of every request (Railway does, with the
// client's address). The payment page is a GET, and what it needs comes after its `#`, which no
// browser sends.
//
//   GET  /              who this verifier is, as canonical JSON: its name; for each check, the key that
//                       signs its stamps, as an address, and the names of its facts; for the ID check
//                       also `forSale` and `testPayments`, whether it is for sale and whether its
//                       payments run on a test key, and `price` and `addedPrice`, each
//                       {amount, currency} as Stripe's Price says, or null until Stripe has said it;
//                       `recipe`, the standard's facts as a list; `consent`, the text an app shows
//                       before the ID check; and, with gifts,
//                       {"gift":{"face":n,"host":"<origin>","id":n,"sponsor":"<address>"}}
//   POST /face/session  {stampNumber} or {stampNumber, returnUrl}
//                                                 -> 201 {sessionId, url}   a face check for that stamp
//                                                    number, while it has a free try left; Didit sends
//                                                    the person back to returnUrl, an app's own page,
//                                                    when its origin is in APP_ORIGINS
//   POST /face/stamp    {sessionId, stampNumber}  -> 200 {stamp}            a stamp from the face key
//                       with a gift, also {gift: "<the host buy's reference>"}
//                                                 -> 200 {stamp, gift: {ticket} or {error}}
//   POST /id/payment    {stampNumber, returnUrl}  -> 201 {payment, url}     a Stripe Checkout page for one
//                                                    ID check (stripe.ts), which holds its price: the
//                                                    added-ID price for a stamp number that holds an ID
//                                                    stamp; the payment carries the stamp number, locked
//                                                    (`lockPayment`); Stripe sends the person back to
//                                                    returnUrl, on an origin in APP_ORIGINS
//                       {stampNumber}             -> 201 {payment, clientSecret}
//                                                    the same payment, made to be embedded in the
//                                                    payment page, which sends the person nowhere
//   GET  /id/pay        #<clientSecret>           -> 200 the payment page (page.ts), which only the apps
//                                                    may frame: Stripe's embedded Checkout, and, once
//                                                    the person has paid, one message to the app
//   POST /id/session    {payment} or {payment, returnUrl}
//                                                 -> 201 {sessionId, url}   an ID check for the payment's
//                                                    stamp number, opened as a face check is, for a
//                                                    payment held less than a day ago, with a try left
//   POST /id/stamp      {sessionId, stampNumber, payment}
//                                                 -> 200 {stamp, face}      a new stamp from the ID key,
//                                                    for the payment that opened the session, its hold
//                                                    taken, and its gift asked as the face stamp's is;
//                                                    `face`, the face stamp signed from the same selfie
//                                                    when the stamp number held none, or null
//   POST /stamp         {stampNumber}             -> 200 {face, id, faceTriesLeft}
//                                                    what is kept for it: its face stamp or null, every
//                                                    ID stamp, each without its list, and how many free
//                                                    face tries it has left
//
// Errors are `{error: <code>}`, each code in codes.ts: 400 a malformed body, 402 a payment not held
// (or not the one that opened the session), 403 a check that does not count (the code says why;
// `declined`, `face_seen` and `expired` mean the session will never pass, so the app starts a new
// one), 404 `not_found`, 409 a session already used for another stamp number, a payment used up, or
// the free face tries used, 413 a body over 4 KB, 502 Didit or Stripe failing the request (logged by
// its status and codes, `why`), or Stripe's prices not yet known, 503 the ID check not for sale (no
// Stripe). A refused or failed request uses nothing up, but for the ID check's refusals that end its
// payment (`ends`), and a face check's that are a try (`UNFINISHED`).
//
// One person, one stamp number: a session is opened for one stamp number, S, and gives a stamp only
// to it, its `vendor_data` carrying S's hash (didit.ts). Once Didit approves it, the verifier
// judges each face Didit matched, and each session a seen-face risk names (`faces`): own, under S's
// hash from a check that gave S a stamp (one `sessions` holds for S, or a kept template, which only
// such a check leaves); an earlier try, under S's hash from one that gave none, which counts for
// nothing but its place in Didit's list; or another's, under any other `vendor_data`
// (`judgeFaces`):
//
//   1. another's: for a face check, `face_seen`; for an ID check, one whose Didit user has the same
//      birth date and a name that fits, `duplicate_document`, and any other passes, a face check's
//      among them: with no name on it, it cannot be told from a twin
//   2. S holds a stamp of either key, and no face is its own: `other_person`
//   3. for an ID check, its own ID check whose Didit user has a birth date that does not fit this
//      one's: `other_person`
//   4. Didit listed as many matches as it lists, and nothing above refused: `too_many_matches`, since
//      the verifier cannot tell what it left out
//
// Then a face check gives a new face stamp; an ID check, a new ID stamp, and, when S holds no face
// stamp, a face stamp from the same selfie: an ID check is a face check and a document.
//
// Two free face tries: a face session for S that Didit finished (approved or declined) and that an app
// asked a stamp of, refused, is one of S's tries, once (store.ts); after FACE_TRIES, S opens no face
// session, `face_tries_used`, and takes the ID check.
//
// One payment opens up to ID_TRIES ID sessions in its first day (store.ts), all for its stamp number,
// and gives one ID stamp, from one of the sessions it opened. Its price is only held until then:
// taken when it gives an ID stamp; cancelled when its check is refused as a person seen before, when
// its newest session, its last try, is refused, and by the hourly search two days after it was held
// (`sweepHolds`).
//
// A session gives its stamp to one stamp number. Sent again with it within the hour after it was first
// signed, it gives the same stamp: Didit still has the decision. After that hour it is refused,
// `session_used`. The sweep (`sweep`) deletes every session the verifier opened: one that gave a
// stamp an hour after, keeping its face template (didit.ts) only when it gave S its first stamp of a
// kind, and any other a day after it opened, face and all.
//
// No request is logged, and the client's address is never read.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { type Fact, factsNumber, fromBytes32, signStamp, stampToJson, toBytes32 } from '@foundationforest/proofs'
import type { ServiceKey } from '@foundationforest/keys'

import type { Code } from './codes.ts'
import { type Check, type Decision, DiditUnavailable, type FaceCheck, judge, readVendorData, stampHash, vendorDataFor } from './didit.ts'
import { type Embedder, FaceError } from './face.ts'
import { type Gift, buyOf, ticketFor } from './gift.ts'
import { type Person, decimal, faceList, idList, person, saltsOf, samePerson } from './facts.ts'
import { payPage } from './page.ts'
import type { Ed25519Key } from './seed.ts'
import { FACE_TRIES, type KeptStamp, type Store, paymentHash } from './store.ts'
import { PAYMENT, PaymentUnavailable, type Payments, type Prices } from './stripe.ts'

const MAX_BODY = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An error answered as `{"error": "<code>"}`, by one of the codes in codes.ts. */
class HttpError extends Error {
  readonly status: number
  constructor(status: number, code: Code) {
    super(code)
    this.status = status
  }
}

/** The kind of error, never its message: a message can carry a URL, a key or a session. */
export const errorKind = (error: unknown) => (error instanceof Error ? error.constructor.name : typeof error)

/**
 * A code as Stripe's error types, codes and params and Didit's codes are written: lower case, digits,
 * `_`, `.` and brackets, at most 64 characters. Anything else Stripe or Didit sent, its own words and
 * a session's id among it, is never logged.
 */
const CODE = /^[a-z0-9_.[\]]{1,64}$/

/** A Stripe key's or a Checkout Session's shape: never logged, even where it would pass as a code. */
const STRIPE_SECRET = /^(?:sk|rk|pk|cs)_(?:test|live)_/

/**
 * Why a request to Stripe or Didit failed, for a log line: the error's kind, and, when it answered,
 * its HTTP status and the codes it sent that look like codes. Never a message.
 */
export function why(error: unknown): string {
  if (!(error instanceof PaymentUnavailable || error instanceof DiditUnavailable)) return errorKind(error)
  const codes = error.codes.filter((code): code is string => typeof code === 'string' && CODE.test(code) && !STRIPE_SECRET.test(code))
  return [errorKind(error), ...(error.status === undefined ? [] : [String(error.status)]), ...codes].join(' ')
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'too_large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'not_json')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'not_an_object')
  return body as Record<string, unknown>
}

/** Exactly these fields, each a string: the service takes nothing it doesn't need. */
function fields(body: Record<string, unknown>, names: string[]): Record<string, string> {
  const keys = Object.keys(body)
  if (keys.length !== names.length || !names.every((n) => typeof body[n] === 'string')) {
    // Each route's own names joined, every one of them in codes.ts, as its tests send it.
    throw new HttpError(400, `expected_exactly_${names.join('_and_')}` as Code)
  }
  return body as Record<string, string>
}

/** Where Didit sends the person when the check is done: a page on one of the apps' origins, and nowhere else. */
function returnUrlIn(origins: string[], value: string): string {
  try {
    const url = new URL(value)
    if (origins.includes(url.origin)) return url.href
  } catch {
    // Refused below.
  }
  throw new HttpError(400, 'bad_return_url')
}

/** The locked part of a payment: a 12-byte nonce, the 32 bytes of its stamp number, locked, and a 16-byte tag, in base64url. */
const LOCKED = /^[A-Za-z0-9_-]{80}$/

/**
 * A payment as the verifier answers it: its Checkout Session's id, a dot, and the stamp number it was
 * made for, locked with AES-256-GCM under the payment key (seed.ts), the id bound in, so it opens ID
 * sessions for that stamp number only and can be moved to no other. The app holds it, as it holds the
 * stamp number; nothing else keeps the two side by side, and Stripe never sees the stamp number.
 */
export function lockPayment(key: Uint8Array, payment: string, stampNumber: bigint): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(payment, 'utf8'))
  const locked = Buffer.concat([nonce, cipher.update(toBytes32(stampNumber)), cipher.final(), cipher.getAuthTag()])
  return `${payment}.${locked.toString('base64url')}`
}

/** A payment's Checkout Session's id and its stamp number, or `bad_payment` for one this verifier did not make. */
export function openPayment(key: Uint8Array, value: string): { payment: string; stampNumber: bigint } {
  const dot = value.lastIndexOf('.')
  const payment = value.slice(0, dot)
  if (dot < 0 || !PAYMENT.test(payment) || !LOCKED.test(value.slice(dot + 1))) throw new HttpError(400, 'bad_payment')
  const locked = Buffer.from(value.slice(dot + 1), 'base64url')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, locked.subarray(0, 12))
    decipher.setAAD(Buffer.from(payment, 'utf8'))
    decipher.setAuthTag(locked.subarray(44))
    return { payment, stampNumber: fromBytes32(Buffer.concat([decipher.update(locked.subarray(12, 44)), decipher.final()])) }
  } catch {
    // Its tag does not check: altered, or locked under another verifier's key.
    throw new HttpError(400, 'bad_payment')
  }
}

/** The person's stamp number at this verifier, from its decimal text. */
function stampNumberIn(text: string | undefined): bigint {
  const stampNumber = decimal(text)
  if (stampNumber === null) throw new HttpError(400, 'bad_stamp_number')
  return stampNumber
}

/** A request for a stamp: a Didit session id, and the person's stamp number at this verifier. */
function stampRequest(input: Record<string, string>): { sessionId: string; stampNumber: bigint } {
  if (!UUID.test(input.sessionId!)) throw new HttpError(400, 'bad_session_id')
  return { sessionId: input.sessionId!, stampNumber: stampNumberIn(input.stampNumber) }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    ...CORS,
    'cache-control': 'no-store',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/** One check: which it is, its Didit workflow, and Didit. */
export type CheckDeps = {
  kind: Check
  check: FaceCheck
  /** The workflow its sessions are opened on; a session on any other is refused. */
  workflowId: string
}

export type VerifierDeps = {
  /** The verifier's name, which every stamp it signs carries. */
  verifierName: string
  face: CheckDeps
  id: CheckDeps
  store: Store
  embedder: Embedder
  /** The two stamp keys, service keys: the face key and the ID key. */
  stampKeys: { face: ServiceKey; id: ServiceKey }
  /** The keys of a stamp number's hash in `vendor_data` and of the facts' salts, derived from the verifier's secret (seed.ts). */
  hashKeys: { vendorData: Uint8Array; salt: Uint8Array }
  /** The key a payment's stamp number is locked under (`lockPayment`), derived the same way. */
  paymentKey: Uint8Array
  /** `GET /`, canonical text, as it is now: its prices come once Stripe has said them. */
  about: () => string
  /** The ID check's two prices, once Stripe has said them; null before, or without Stripe. */
  prices?: () => Prices | null
  /** Unset: no gifts. */
  gift?: { gift: Gift; sponsor: Ed25519Key }
  /** The origins a `returnUrl` may be on: the apps' own. Empty: none is taken. */
  appOrigins?: string[]
  /** Stripe, which the ID check is paid through. Unset: the ID check is not for sale. */
  payments?: Payments
  log?: (line: string) => void
  /** The clock, in ms; unset, the system's. */
  now?: () => number
}

/** How long after a session is first signed it may be sent again, and when the sweep deletes it in Didit. */
export const SIGNED_FOR_MS = 3_600_000

/**
 * A day: how long after a session opened the sweep deletes it in Didit, face and all, when it gave no
 * stamp; and how long after a payment was held it may open sessions. So every session gets its full
 * day before its payment's hold can go (HOLD_FOR_MS).
 */
export const OPEN_FOR_MS = 86_400_000

/** Two days: how long after it was held the hourly search cancels a hold that nothing took or cancelled. */
export const HOLD_FOR_MS = 2 * OPEN_FOR_MS

/** How often the sweep looks for sessions to delete. */
export const SWEEP_EVERY_MS = 60_000

/** How often the sweep searches Stripe for old holds to cancel. */
export const HOLDS_EVERY_MS = 3_600_000

/**
 * Deletes in Didit each session whose stamp was first signed an hour ago or more, keeping its face
 * template if it gave its stamp number its first stamp of a kind (store.ts), and each that gave no
 * stamp and opened a day ago or more, keeping nothing; and forgets its
 * id and time once Didit has deleted it. A deletion Didit does not answer stays, for the next sweep.
 * Logs without the session: how many deletions failed and why the last did (`why`), and what Didit
 * said it did with a face when it kept no template it was asked to.
 */
export async function sweep(deps: { store: Store; checks: Record<Check, FaceCheck>; now?: () => number; log?: (line: string) => void }): Promise<void> {
  const log = deps.log ?? ((line) => console.log(line))
  const now = (deps.now ?? Date.now)()
  const deletions = [...deps.store.due(now - SIGNED_FOR_MS), ...deps.store.stale(now - OPEN_FOR_MS).map((session) => ({ ...session, keepFace: false }))]
  let failed = 0
  let kind = ''
  for (const { sessionId, kind: check, keepFace } of deletions) {
    let outcome: string
    try {
      outcome = await deps.checks[check].deleteSession(sessionId, keepFace)
    } catch (error) {
      failed++
      kind = why(error)
      continue
    }
    deps.store.deleted(sessionId)
    if (keepFace && outcome !== 'retained_with_user' && outcome !== 'gone') log(`verifier: Didit kept no face template for a deleted session (${outcome || 'no outcome'})`)
  }
  if (failed) log(`verifier: ${failed} session${failed === 1 ? '' : 's'} could not be deleted in Didit, kept for the next sweep (${kind})`)
}

/**
 * Cancels each hold Stripe has from the verifier, held two days ago or more, that nothing took or
 * cancelled: whether Stripe answered the search, so the next is due in an hour. Logs, without a
 * payment, why the search failed, or how many cancels Stripe refused and why the last was.
 */
export async function sweepHolds(deps: { payments: Payments; now?: () => number; log?: (line: string) => void }): Promise<boolean> {
  const log = deps.log ?? ((line) => console.log(line))
  let outcome
  try {
    outcome = await deps.payments.cancelOld((deps.now ?? Date.now)() - HOLD_FOR_MS)
  } catch (error) {
    log(`verifier: the search for old holds failed, tried again at the next sweep (${why(error)})`)
    return false
  }
  if (outcome.failed) log(`verifier: ${outcome.failed} old hold${outcome.failed === 1 ? '' : 's'} could not be cancelled at Stripe, kept for the next search (${why(outcome.error)})`)
  return true
}

/** The 403s that are no try of a payment's: a session unfinished, or none of this check's. */
const NOT_A_TRY = new Set<string>(['not_approved', 'unknown_session', 'wrong_workflow'] satisfies Code[])

/** The 403s that are no free face try: those, and a session the person never finished, expired or abandoned. */
const UNFINISHED = new Set<string>([...NOT_A_TRY, 'expired'] satisfies string[])

export function handler(deps: VerifierDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { face, id, store, embedder } = deps
  const log = deps.log ?? ((line) => console.log(line))
  const now = deps.now ?? Date.now
  /** The earliest first signing a session may have to be signed again now. */
  const since = () => now() - SIGNED_FOR_MS

  /** A 502: Stripe or Didit failed the request, and one log line says why (`why`). */
  function unavailable(code: 'face_check_unavailable' | 'payment_unavailable', error: unknown): HttpError {
    log(`verifier: ${code} (${why(error)})`)
    return new HttpError(502, code)
  }

  type Route = (body: Record<string, unknown>) => Promise<[number, unknown]>

  /** The `vendor_data` a session of this check opened for this stamp number carries (didit.ts). */
  const vendorData = (c: CheckDeps, stampNumber: bigint) => vendorDataFor(c.kind, deps.hashKeys.vendorData, stampNumber)

  /**
   * A face session, for a stamp number with a free try left: `{stampNumber}`, or with `returnUrl` on an
   * app's origin, where Didit sends the person when it is done. Kept as opened, so the sweep deletes
   * it.
   */
  async function openFace(body: Record<string, unknown>): Promise<[number, unknown]> {
    const input = fields(body, 'returnUrl' in body ? ['stampNumber', 'returnUrl'] : ['stampNumber'])
    const stampNumber = stampNumberIn(input.stampNumber)
    const callback = input.returnUrl === undefined ? undefined : returnUrlIn(deps.appOrigins ?? [], input.returnUrl)
    if (store.faceTries(stampNumber) >= FACE_TRIES) throw new HttpError(409, 'face_tries_used')
    let session
    try {
      session = await face.check.createSession({ vendorData: vendorData(face, stampNumber), callback })
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
    store.opened(session.sessionId, 'face', now())
    return [201, session]
  }

  /** Stripe, or `not_for_sale`: the ID check is sold only through it. */
  function forSale(): Payments {
    if (!deps.payments) throw new HttpError(503, 'not_for_sale')
    return deps.payments
  }

  /**
   * A Stripe Checkout page for one ID check for a stamp number, sending the person back to
   * `returnUrl`, an app's page; or, with no `returnUrl`, one to embed in the payment page, answered by
   * its client secret: at the added-ID price when the stamp number holds an ID stamp. None until
   * Stripe has said what its prices are, so the app can show the person the price first; the payment
   * answered carries the stamp number, locked.
   */
  async function pay(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const input = fields(body, 'returnUrl' in body ? ['stampNumber', 'returnUrl'] : ['stampNumber'])
    const stampNumber = stampNumberIn(input.stampNumber)
    const returnUrl = input.returnUrl === undefined ? undefined : returnUrlIn(deps.appOrigins ?? [], input.returnUrl)
    // Asked again at every sweep (service.ts), and logged there.
    if (!deps.prices?.()) throw new HttpError(502, 'payment_unavailable')
    let made
    try {
      // The price is the one when the payment is made: a stamp number with an ID stamp then pays the
      // added-ID price, and its check is judged as its own (`judgeFaces`), so it adds to that person only.
      made = await payments.checkout(returnUrl, store.stamps(stampNumber).id.length > 0)
    } catch (error) {
      throw unavailable('payment_unavailable', error)
    }
    const payment = lockPayment(deps.paymentKey, made.payment, stampNumber)
    return [201, 'url' in made ? { payment, url: made.url } : { payment, clientSecret: made.clientSecret }]
  }

  /** The payment page, with Stripe: the same for every payment, whose client secret it reads after its `#`. */
  const page = deps.payments && payPage(deps.payments.publishableKey, deps.appOrigins ?? [])

  /**
   * An ID session, for a payment, for the stamp number it carries: Stripe is asked each time whether it
   * holds the money, and since when, since the hourly search may have cancelled it; a payment held a
   * day ago or more opens none. Each session takes one of its tries, and a session Didit does not open
   * gives its try back. Kept as opened with the payment, so only that payment gives its stamp, and the
   * sweep deletes it.
   */
  async function openId(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const input = fields(body, 'returnUrl' in body ? ['payment', 'returnUrl'] : ['payment'])
    const { payment, stampNumber } = openPayment(deps.paymentKey, input.payment!)
    const callback = input.returnUrl === undefined ? undefined : returnUrlIn(deps.appOrigins ?? [], input.returnUrl)
    const hash = paymentHash(payment)
    if (store.knowsPayment(hash) && store.triesLeft(hash) === 0) throw new HttpError(409, 'payment_used')
    let heldAt: number | null
    try {
      heldAt = await payments.held(payment)
    } catch (error) {
      throw unavailable('payment_unavailable', error)
    }
    if (heldAt === null || now() - heldAt >= OPEN_FOR_MS) throw new HttpError(402, 'not_paid')
    kept(store.takeTry(hash))
    let session
    try {
      session = await id.check.createSession({ vendorData: vendorData(id, stampNumber), callback })
    } catch (error) {
      store.giveBackTry(hash)
      throw unavailable('face_check_unavailable', error)
    }
    store.opened(session.sessionId, 'id', now(), hash)
    return [201, session]
  }

  /**
   * What Didit decided for this session, if it passed and the session was opened for this stamp
   * number: otherwise the refusal. One opened for another, or under a `vendor_data` this verifier
   * cannot read, as before it wrote stamp numbers there, gives its stamp to none but that one:
   * `session_used`, a 409, which ends no payment.
   */
  async function decided(c: CheckDeps, sessionId: string, stampNumber: bigint) {
    let decision
    try {
      decision = await c.check.decision(sessionId)
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
    const refusal = judge(decision, c.workflowId, c.kind)
    // A session that gave a stamp and is gone from Didit was deleted: by the sweep, or by hand.
    if (refusal === 'unknown_session' && store.holds(sessionId)) throw new HttpError(409, 'session_used')
    if (refusal === 'unknown_session' || refusal === 'wrong_workflow') throw new HttpError(403, refusal)
    const opened = readVendorData(decision!.vendorData)
    if (opened?.check !== c.kind || opened.hash !== stampHash(deps.hashKeys.vendorData, stampNumber)) throw new HttpError(409, 'session_used')
    if (refusal) throw new HttpError(403, refusal)
    return decision!
  }

  /** A face Didit matched, or a session a seen-face risk named, as `judgeFaces` reads it: whose it is, and its `vendor_data` when it is known. */
  type Face = { kind: 'own' | 'try' | 'other'; vendorData: string | null }

  /**
   * Each face Didit matched to this session's, and each session a seen-face risk names that no match
   * listed can be (didit.ts's `named`), for stamp number S: own, under S's hash from a check that gave
   * S a stamp, a session `sessions` holds for S or a kept template, which only such a check leaves; an
   * earlier try, under S's hash from a session that gave none; another's, under any other. A named
   * session's `vendor_data` is read from Didit; one Didit no longer has is S's own if it gave S a
   * stamp, and like a risk that names no session, another's otherwise.
   */
  async function faces(c: CheckDeps, stampNumber: bigint, decision: Decision): Promise<Face[]> {
    const mine = stampHash(deps.hashKeys.vendorData, stampNumber)
    const gaveStamp = (sessionId: string) => store.stampNumberOf(sessionId) === stampNumber
    const kindOf = (vendorData: string | null, sessionId: string | null): Face['kind'] => {
      if (vendorData === null || readVendorData(vendorData)?.hash !== mine) return 'other'
      return sessionId === null || gaveStamp(sessionId) ? 'own' : 'try'
    }
    const found: Face[] = decision.matches.map((match) => ({ kind: kindOf(match.vendorData, match.sessionId), vendorData: match.vendorData }))
    const listed = (sessionId: string | null) => decision.matches.some((match) => match.sessionId === sessionId)
    for (const sessionId of decision.named.filter((named) => !listed(named))) {
      if (sessionId === null) {
        found.push({ kind: 'other', vendorData: null })
        continue
      }
      let named
      try {
        named = await c.check.decision(sessionId)
      } catch (error) {
        throw unavailable('face_check_unavailable', error)
      }
      if (named?.vendorData) found.push({ kind: kindOf(named.vendorData, sessionId), vendorData: named.vendorData })
      else found.push({ kind: gaveStamp(sessionId) ? 'own' : 'other', vendorData: null })
    }
    return found
  }

  /** The Didit user a face's `vendor_data` names, or null for none. */
  async function userOf(vendorData: string) {
    try {
      return await id.check.user(vendorData)
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
  }

  /**
   * One person, one stamp number: the faces Didit found for a session opened for S (`faces`), judged
   * in order, for a check Didit approved. Another stamp number's face refuses a face check,
   * `face_seen`, and an ID check when its Didit user has the same birth date and a name that fits,
   * `duplicate_document`; a face check's, which read no name, is not asked about. S holding a stamp,
   * with no face of its own, is someone else, `other_person`; so is an ID check whose own earlier ID
   * check's user has a birth date that does not fit. A list as long as Didit makes them, with none of
   * these, may have left one out: `too_many_matches`. An earlier try counts only in the list.
   */
  async function judgeFaces(c: CheckDeps, stampNumber: bigint, decision: Decision, who: Person | null): Promise<void> {
    const found = await faces(c, stampNumber, decision)
    const others = found.filter((face) => face.kind === 'other')
    const own = found.filter((face) => face.kind === 'own')
    const isFaceCheck = (vendorData: string) => readVendorData(vendorData)?.check === 'face'
    if (c.kind === 'face' && others.length > 0) throw new HttpError(403, 'face_seen')
    if (c.kind === 'id') {
      for (const { vendorData } of others) {
        if (vendorData === null || isFaceCheck(vendorData)) continue
        const user = await userOf(vendorData)
        if (user && samePerson(who!, user)) throw new HttpError(403, 'duplicate_document')
      }
    }
    const held = store.stamps(stampNumber)
    if ((held.face || held.id.length > 0) && own.length === 0) throw new HttpError(403, 'other_person')
    if (c.kind === 'id') {
      for (const { vendorData } of own) {
        if (vendorData === null || isFaceCheck(vendorData)) continue
        const user = await userOf(vendorData)
        if (user?.birth && !samePerson(who!, user)) throw new HttpError(403, 'other_person')
      }
    }
    if (decision.full) throw new HttpError(403, 'too_many_matches')
  }

  /** The embedding of the selfie the session took. */
  async function embedding(c: CheckDeps, url: string | null): Promise<Uint8Array> {
    if (!url) throw new HttpError(403, 'no_face')
    let photo: Uint8Array
    try {
      photo = await c.check.photo(url)
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
    try {
      return await embedder.embed(photo)
    } catch (error) {
      if (error instanceof FaceError) throw new HttpError(403, 'no_face')
      throw error
    }
  }

  /** The store's answer, as the refusal it is. */
  function kept(outcome: ReturnType<Store['check']>): void {
    if (outcome === 'session_used' || outcome === 'payment_used') throw new HttpError(409, outcome)
    if (outcome === 'not_paid') throw new HttpError(402, outcome)
    if (outcome !== 'ok') throw new HttpError(403, outcome)
  }

  /**
   * A check's gift for this stamp number, once: a ticket for the app's host buy, and the buy kept,
   * hashed, next to the stamp number. The same buy asked for again gets the same ticket; another buy
   * gets `given`. It rides with the stamp, and never holds it back.
   */
  function giveGift(check: Check, stampNumber: bigint, reference: unknown): Record<string, string> {
    const ticket = ticketFor(deps.gift!.gift, check, reference, deps.gift!.sponsor)
    if (ticket === 'bad_gift') return { error: ticket }
    if (store.giveGift(stampNumber, check, buyOf(reference as string)) === 'other') return { error: 'given' }
    return { ticket }
  }

  /**
   * A stamp request's session and stamp number, and `more` fields, and the gift's buy, asked only of a
   * check that gives one.
   */
  function stampAsked(check: Check, body: Record<string, unknown>, more: string[] = []): { sessionId: string; stampNumber: bigint; input: Record<string, string>; gift?: { reference: unknown } } {
    const { gift: reference, ...rest } = body
    const asked = (deps.gift?.gift.credits[check] ?? 0) > 0 && 'gift' in body
    const input = fields(asked ? rest : body, ['sessionId', 'stampNumber', ...more])
    return { ...stampRequest(input), input, ...(asked && { gift: { reference } }) }
  }

  /** A stamp's list (facts.ts), its facts made from it, signed by this check's key with the list beside it. */
  const signed = (c: CheckDeps, stampNumber: bigint, factList: Fact[]) =>
    signStamp(deps.stampKeys[c.kind].secret, { stampNumber, facts: factsNumber(factList), verifierName: deps.verifierName, factList })

  /**
   * A stamp from the face key, for this stamp number, from a face check Didit approved and the
   * verifier judged (`judgeFaces`). The session, asked again within its hour, gives the same stamp: its
   * decision and its salts are the same, and it is judged no more, as its own stamp is now S's. A
   * refusal of a session Didit finished is one of S's free tries (`UNFINISHED`, store.ts).
   */
  async function faceStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    const { sessionId, stampNumber, gift } = stampAsked('face', body)
    kept(store.check({ sessionId, stampNumber, since: since() }))
    const again = store.holds(sessionId)

    let stamp
    try {
      const decision = await decided(face, sessionId, stampNumber)
      if (!again) await judgeFaces(face, stampNumber, decision, null)
      const embedded = await embedding(face, decision.faceImage)
      // Signed, with the list its facts were made from beside it, and kept without it.
      stamp = signed(face, stampNumber, faceList(embedder.model, embedded, saltsOf(deps.hashKeys.salt, sessionId)))
    } catch (error) {
      // Only a session S opened and that gave no stamp counts, once: the store knows which.
      if (error instanceof HttpError && error.status === 403 && !UNFINISHED.has(error.message)) store.faceTry(sessionId, stampNumber)
      throw error
    }
    // Checked again, for good, inside one transaction: the session may have given a stamp for another
    // stamp number while this request waited for Didit.
    kept(store.remember({ sessionId, stampNumber, kind: 'face', since: since(), signedAt: now(), stamp }))
    const answer: Record<string, unknown> = { stamp: stampToJson(stamp) }
    if (gift) answer.gift = giveGift('face', stampNumber, gift.reference)
    return [200, answer]
  }

  /** A kept stamp as JSON, without its list: the list beside it was never kept. */
  const keptToJson = (check: Check, stampNumber: bigint, stamp: KeptStamp) =>
    stampToJson({ stampNumber, ...stamp, verifierName: deps.verifierName, verifier: deps.stampKeys[check].address })

  /** Cancels a payment's hold at Stripe; one Stripe does not answer is left for the hourly search (`sweepHolds`), and logged. */
  async function cancel(payments: Payments, payment: string): Promise<void> {
    try {
      await payments.cancel(payment)
    } catch (error) {
      log(`verifier: a hold could not be cancelled at Stripe, left for the hourly search (${why(error)})`)
    }
  }

  // One ID stamp's last steps at a time: checked again, its hold taken, and kept, so two requests at
  // once never both take money for one stamp, or take it for a stamp they then cannot keep.
  let settling: Promise<unknown> = Promise.resolve()
  function settle<T>(steps: () => Promise<T>): Promise<T> {
    const run = settling.then(steps)
    settling = run.catch(() => {})
    return run
  }

  /**
   * A new ID stamp for this stamp number, from an ID check Didit approved and the verifier judged
   * (`judgeFaces`), opened by the payment sent, which gave no stamp yet, and its hold taken: one for
   * each document checked, none replacing another. The session that signed it, sent again within its
   * hour, gives it again with its list beside it, using nothing. A refusal that ends the payment
   * cancels its hold: a person seen before, always; any other refusal of a session that will never
   * pass, only for the payment's newest session, its last try, so an older one asked about later
   * never cancels a hold whose newest session may still pass.
   */
  async function idStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const { sessionId, stampNumber, input, gift } = stampAsked('id', body, ['payment'])
    // The payment's own stamp number is the session's (its vendor_data): `decided` refuses any other.
    const { payment } = openPayment(deps.paymentKey, input.payment!)
    const hash = paymentHash(payment)
    kept(store.check({ sessionId, stampNumber, since: since(), payment: hash }))
    const again = store.holds(sessionId)
    try {
      return await signId({ sessionId, stampNumber, payment, hash, again, gift })
    } catch (error) {
      const ends = error instanceof HttpError && error.status === 403 && !NOT_A_TRY.has(error.message)
      if (!again && ends && (error.message === 'duplicate_document' || store.lastTry(sessionId))) {
        store.useUp(hash)
        await cancel(payments, payment)
      }
      throw error
    }
  }

  async function signId(a: { sessionId: string; stampNumber: bigint; payment: string; hash: Uint8Array; again: boolean; gift?: { reference: unknown } }): Promise<[number, unknown]> {
    const { sessionId, stampNumber, hash, again } = a
    const payments = deps.payments!
    const decision = await decided(id, sessionId, stampNumber)
    const who = person(decision.document)
    if (!who) throw new HttpError(403, 'no_document_data')
    if (!again) await judgeFaces(id, stampNumber, decision, who)

    const embedded = await embedding(id, decision.faceImage)
    const salts = saltsOf(deps.hashKeys.salt, sessionId)
    const stamp = signed(id, stampNumber, idList(embedder.model, embedded, decision.document!, salts))
    // An ID check is a face check and a document: its selfie gives S a face stamp too, kept only when
    // S holds none (store.ts), with no rule of its own and no gift: the ID stamp's gift stands for both.
    const faceStamp = signed(face, stampNumber, faceList(embedder.model, embedded, salts))
    return settle(async () => {
      // Checked again: another request may have signed for this session or this payment meanwhile.
      kept(store.check({ sessionId, stampNumber, since: since(), payment: hash }))
      if (!again) {
        let taken: boolean
        try {
          taken = await payments.capture(a.payment)
        } catch (error) {
          throw unavailable('payment_unavailable', error)
        }
        // The hold was cancelled, by the hourly search or at Stripe: this payment gives nothing more.
        if (!taken) {
          store.useUp(hash)
          throw new HttpError(409, 'payment_used')
        }
      }
      kept(store.remember({ sessionId, stampNumber, kind: 'id', since: since(), signedAt: now(), stamp, face: faceStamp, payment: hash }))
      // Read after `remember`: the face stamp goes with the answer only when it is the one S holds, this
      // session's, now or within its hour. The same facts mean the same session and selfie.
      const held = store.stamps(stampNumber).face
      const answer: Record<string, unknown> = { stamp: stampToJson(stamp), face: held?.facts === faceStamp.facts ? stampToJson(faceStamp) : null }
      if (a.gift) answer.gift = giveGift('id', stampNumber, a.gift.reference)
      return [200, answer]
    })
  }

  /**
   * What is kept for a stamp number: its face stamp, the first the face key signed for it, or null;
   * every ID stamp; each without its list; and how many free face tries it has left. A stamp is no use
   * without the seed behind its number.
   */
  async function stampBack(body: Record<string, unknown>): Promise<[number, unknown]> {
    const stampNumber = stampNumberIn(fields(body, ['stampNumber']).stampNumber)
    const kept = store.stamps(stampNumber)
    return [
      200,
      {
        face: kept.face ? keptToJson('face', stampNumber, kept.face) : null,
        id: kept.id.map((stamp) => keptToJson('id', stampNumber, stamp)),
        faceTriesLeft: Math.max(0, FACE_TRIES - store.faceTries(stampNumber)),
      },
    ]
  }

  const routes: Record<string, Route> = {
    '/face/session': openFace,
    '/face/stamp': faceStamp,
    '/id/payment': pay,
    '/id/session': openId,
    '/id/stamp': idStamp,
    '/stamp': stampBack,
  }

  return (req, res) => {
    void (async () => {
      try {
        if (req.method === 'OPTIONS') return send(res, 204)
        const path = req.url ?? ''
        if (path === '/') {
          if (req.method !== 'GET') throw new HttpError(405, 'get_only')
          res.writeHead(200, { ...CORS, 'cache-control': 'no-cache', 'content-type': 'application/json' })
          return void res.end(deps.about())
        }
        if (path === '/id/pay') {
          if (req.method !== 'GET') throw new HttpError(405, 'get_only')
          if (!page) throw new HttpError(503, 'not_for_sale')
          res.writeHead(200, page.headers)
          return void res.end(page.html)
        }
        if (!Object.hasOwn(routes, path)) throw new HttpError(404, 'not_found')
        const route = routes[path]!
        if (req.method !== 'POST') throw new HttpError(405, 'post_only')
        const [status, body] = await route(await readBody(req))
        send(res, status, body)
      } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, { error: error.message })
        log(`verifier: request failed (${errorKind(error)})`)
        send(res, 500, { error: 'internal' satisfies Code })
      }
    })()
  }
}
