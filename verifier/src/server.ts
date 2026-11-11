// The verifier's routes. The ones a person's app calls are POST with a JSON body, so nothing a person
// sends is ever in a URL: hosting platforms log the path of every request (Railway does, with the
// client's address).
//
//   GET  /              who this verifier is, as canonical JSON: its name; for each check, the key that
//                       signs its stamps, as an address, and its facts recipe; what h is; `consent`,
//                       the text an app shows before the ID check; and, with gifts,
//                       {"gift":{"face":n,"host":"<origin>","id":n,"sponsor":"<address>"}}
//   POST /face/session  {} or {returnUrl}         -> 201 {sessionId, url}   a face check; Didit sends the
//                                                    person back to returnUrl, an app's own page, when
//                                                    its origin is in APP_ORIGINS
//   POST /face/stamp    {sessionId, stampNumber}  -> 200 {stamp}            a stamp from the face key
//                       with a gift, also {gift: "<the host buy's reference>"}
//                                                 -> 200 {stamp, gift: {ticket} or {error}}
//   POST /id/payment    {returnUrl}               -> 201 {payment, url}     a Stripe Checkout page for one
//                                                    ID check (stripe.ts), which holds its $5; Stripe
//                                                    sends the person back to returnUrl, on an origin
//                                                    in APP_ORIGINS
//   POST /id/session    {payment} or {payment, returnUrl}
//                                                 -> 201 {sessionId, url}   an ID check, opened as a face
//                                                    check is, for a payment held less than a day ago,
//                                                    with a try left
//   POST /id/stamp      {sessionId, stampNumber, payment}
//                                                 -> 200 {stamp}            a stamp from the ID key, for the
//                                                    payment that opened the session, its hold taken,
//                                                    and its gift asked as the face stamp's is; for a
//                                                    stamp number that has one, the first, its own
//                                                    fields only, its hold cancelled
//   POST /stamp         {stampNumber}             -> 200 {face, id}         the stamps kept for it, each
//                                                    a stamp or null, its own fields only; 404
//                                                    `not_found` when none was signed for it
//
// Errors are `{error: <code>}`, each code in codes.ts: 400 a malformed body, 402 a payment not held
// (or not the one that opened the session), 403 a check that does not count (the code says why;
// `declined`, `face_seen` and `expired` mean the session will never pass, so the app starts a new
// one), 404 `not_found`, 409 a session already used for another stamp number, or a payment used up,
// 413 a body over 4 KB, 502 Didit or Stripe failing the request (logged by its status and codes,
// `why`), 503 the ID check not for sale (no Stripe). A refused or failed request uses nothing up,
// but for the ID check's refusals that end its payment (`ends`).
//
// One payment opens up to ID_TRIES ID sessions in its first day (store.ts), and gives one ID stamp,
// from one of the sessions it opened. Its $5 is only held until then: taken when it gives a new ID
// stamp; cancelled when it gives an ID stamp back, when its check is refused as a person seen before,
// when its last try is refused, and by the hourly search two days after it was held (`sweepHolds`).
//
// A session gives its stamp to one stamp number. Sent again with it within the hour after it was first
// signed, it gives the same stamp: Didit still has the decision. After that hour it is refused,
// `session_used`. The sweep (`sweep`) deletes every session the verifier opened: one that gave a
// stamp an hour after, keeping only its face template (didit.ts), and any other a day after it
// opened, face and all.
//
// No request is logged, and the client's address is never read.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { signStamp, stampToJson } from '@foundationforest/proofs'
import type { ServiceKey } from '@foundationforest/keys'
import { b64u } from '@foundationforest/folders'

import type { Code } from './codes.ts'
import { type Check, type Decision, DiditUnavailable, type FaceCheck, judge } from './didit.ts'
import { type Embedder, FaceError } from './face.ts'
import { type Gift, buyOf, ticketFor } from './gift.ts'
import { type Person, decimal, faceFacts, fieldsText, idFacts, person, samePerson } from './facts.ts'
import type { Ed25519Key } from './seed.ts'
import { type KeptStamp, type Store, paymentHash } from './store.ts'
import { PAYMENT, PaymentUnavailable, type Payments } from './stripe.ts'

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
function fields(body: Record<string, unknown>, names: string[] = []): Record<string, string> {
  const keys = Object.keys(body)
  if (keys.length !== names.length || !names.every((n) => typeof body[n] === 'string')) {
    // Each route's own names joined, every one of them in codes.ts, as its tests send it.
    throw new HttpError(400, (names.length ? `expected_exactly_${names.join('_and_')}` : 'expected_empty_body') as Code)
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

/** A payment's id, as Stripe gave it: a Checkout Session's. */
function paymentOf(value: string): string {
  if (!PAYMENT.test(value)) throw new HttpError(400, 'bad_payment')
  return value
}

/** A request for a stamp: a Didit session id, and the person's stamp number at this verifier. */
function stampRequest(input: Record<string, string>): { sessionId: string; stampNumber: bigint } {
  if (!UUID.test(input.sessionId!)) throw new HttpError(400, 'bad_session_id')
  const stampNumber = decimal(input.stampNumber)
  if (stampNumber === null) throw new HttpError(400, 'bad_stamp_number')
  return { sessionId: input.sessionId!, stampNumber }
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
  /** `GET /`, canonical text. */
  about: string
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
 * template, and each that gave no stamp and opened a day ago or more, keeping nothing; and forgets its
 * id and time once Didit has deleted it. A deletion Didit does not answer stays, for the next sweep.
 * Logs without the session: how many deletions failed and why the last did (`why`), and what Didit
 * said it did with a face when it kept no template it was asked to.
 */
export async function sweep(deps: { store: Store; checks: Record<Check, FaceCheck>; now?: () => number; log?: (line: string) => void }): Promise<void> {
  const log = deps.log ?? ((line) => console.log(line))
  const now = (deps.now ?? Date.now)()
  const deletions = [
    ...deps.store.due(now - SIGNED_FOR_MS).map((session) => ({ ...session, keepFace: true })),
    ...deps.store.stale(now - OPEN_FOR_MS).map((session) => ({ ...session, keepFace: false })),
  ]
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

  /**
   * A face session on the check's workflow: `{}`, or `{returnUrl}` on an app's origin, where Didit
   * sends the person when it is done. Kept as opened, so the sweep deletes it.
   */
  async function open(c: CheckDeps, body: Record<string, unknown>): Promise<[number, unknown]> {
    let callback: string | undefined
    if ('returnUrl' in body) callback = returnUrlIn(deps.appOrigins ?? [], fields(body, ['returnUrl']).returnUrl!)
    else fields(body)
    let session
    try {
      session = await c.check.createSession({ callback })
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
    store.opened(session.sessionId, c.kind, now())
    return [201, session]
  }

  /** Stripe, or `not_for_sale`: the ID check is sold only through it. */
  function forSale(): Payments {
    if (!deps.payments) throw new HttpError(503, 'not_for_sale')
    return deps.payments
  }

  /** A Stripe Checkout page for one ID check, sending the person back to `returnUrl`, an app's page. */
  async function pay(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const returnUrl = returnUrlIn(deps.appOrigins ?? [], fields(body, ['returnUrl']).returnUrl!)
    try {
      return [201, await payments.checkout(returnUrl)]
    } catch (error) {
      throw unavailable('payment_unavailable', error)
    }
  }

  /**
   * An ID session, for a payment: Stripe is asked each time whether it holds the money, and since
   * when, since the hourly search may have cancelled it; a payment held a day ago or more opens none.
   * Each session takes one of its tries, and a session Didit does not open gives its try back. Kept as
   * opened with the payment, so only that payment gives its stamp, and the sweep deletes it.
   */
  async function openId(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const input = fields(body, 'returnUrl' in body ? ['payment', 'returnUrl'] : ['payment'])
    const callback = input.returnUrl === undefined ? undefined : returnUrlIn(deps.appOrigins ?? [], input.returnUrl)
    const payment = paymentOf(input.payment!)
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
      session = await id.check.createSession({ callback })
    } catch (error) {
      store.giveBackTry(hash)
      throw unavailable('face_check_unavailable', error)
    }
    store.opened(session.sessionId, 'id', now(), hash)
    return [201, session]
  }

  /** What Didit decided for this session, if it passed: otherwise the refusal. */
  async function decided(c: CheckDeps, sessionId: string) {
    let decision
    try {
      decision = await c.check.decision(sessionId)
    } catch (error) {
      throw unavailable('face_check_unavailable', error)
    }
    const refusal = judge(decision, c.workflowId, c.kind)
    // A session that gave a stamp and is gone from Didit was deleted: by the sweep, or by hand.
    if (refusal === 'unknown_session' && store.holds(sessionId)) throw new HttpError(409, 'session_used')
    if (refusal) throw new HttpError(403, refusal)
    return decision!
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

  /** A stamp from the face key, for this stamp number, from a face check Didit approved. */
  async function faceStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    const { sessionId, stampNumber, gift } = stampAsked('face', body)
    kept(store.check({ sessionId, stampNumber, since: since() }))

    const decision = await decided(face, sessionId)
    const embedded = await embedding(face, decision.faceImage)
    const model = embedder.model
    // Signed, with the fields its facts were made from beside it, and kept without them.
    const stamp = signStamp(deps.stampKeys.face.secret, { stampNumber, facts: faceFacts(model, embedded), verifierName: deps.verifierName, model, embedding: b64u.encode(embedded) })
    // Checked again, for good, inside one transaction: the session may have given a stamp for another
    // stamp number while this request waited for Didit.
    kept(store.remember({ sessionId, stampNumber, kind: 'face', since: since(), signedAt: now(), stamp }))
    const answer: Record<string, unknown> = { stamp: stampToJson(stamp) }
    if (gift) answer.gift = giveGift('face', stampNumber, gift.reference)
    return [200, answer]
  }

  /** A kept stamp as JSON, with its own fields only: the fields beside it were never kept. */
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

  /**
   * Whether Didit has seen this person before: a face it matched whose Didit user has the same birth
   * date and a name that fits (facts.ts's `samePerson`), refused as `duplicate_document`. A match to a
   * session this same payment opened is the person's own earlier try, and one payment gives one stamp,
   * so it is skipped.
   */
  async function seenBefore(who: Person, decision: Decision, payment: Uint8Array): Promise<void> {
    for (const match of decision.matches) {
      const opener = match.sessionId === null ? undefined : store.opener(match.sessionId)
      if (opener && Buffer.from(opener).equals(Buffer.from(payment))) continue
      let user
      try {
        user = await id.check.user(match.vendorData)
      } catch (error) {
        throw unavailable('face_check_unavailable', error)
      }
      if (user && samePerson(who, user)) throw new HttpError(403, 'duplicate_document')
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
   * The ID stamp for this stamp number, from an ID check Didit approved, opened by the payment sent,
   * which gave no stamp yet: a stamp number that has one gets it back, its own fields only, and the
   * payment's hold is cancelled; a person Didit has seen before is refused; anyone else gets a new
   * stamp, and the hold is taken. One ID stamp a person, ever. The session that signed it, sent again
   * within its hour, gives it with its fields beside it, using nothing. A refusal that ends the
   * payment cancels its hold: a person seen before, always; any other refusal of a session that will
   * never pass, once the payment has no try left.
   */
  async function idStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const { sessionId, stampNumber, input, gift } = stampAsked('id', body, ['payment'])
    const payment = paymentOf(input.payment!)
    const hash = paymentHash(payment)
    kept(store.check({ sessionId, stampNumber, since: since(), payment: hash }))
    const again = store.holds(sessionId)
    try {
      return await signId({ sessionId, stampNumber, payment, hash, again, gift })
    } catch (error) {
      const ends = error instanceof HttpError && error.status === 403 && !NOT_A_TRY.has(error.message)
      if (!again && ends && (error.message === 'duplicate_document' || store.triesLeft(hash) === 0)) {
        store.useUp(hash)
        await cancel(payments, payment)
      }
      throw error
    }
  }

  async function signId(a: { sessionId: string; stampNumber: bigint; payment: string; hash: Uint8Array; again: boolean; gift?: { reference: unknown } }): Promise<[number, unknown]> {
    const { sessionId, stampNumber, hash, again } = a
    const payments = deps.payments!
    const decision = await decided(id, sessionId)
    const withGift = (answer: unknown): [number, unknown] => [200, { stamp: answer, ...(a.gift && { gift: giveGift('id', stampNumber, a.gift.reference) }) }]
    /** The first ID stamp back, its own fields only: the session kept with it, the payment used up, and its hold cancelled. */
    const giveBack = async (first: KeptStamp): Promise<[number, unknown]> => {
      kept(store.remember({ sessionId, stampNumber, kind: 'id', since: since(), signedAt: now(), stamp: first, payment: hash }))
      await cancel(payments, a.payment)
      return withGift(keptToJson('id', stampNumber, first))
    }
    const first = store.stamps(stampNumber).id
    if (first && !again) return giveBack(first)

    const who = person(decision.document)
    if (!who) throw new HttpError(403, 'no_document_data')
    if (!again) await seenBefore(who, decision, hash)
    const embedded = await embedding(id, decision.faceImage)
    const model = embedder.model
    const document = decision.document!
    const stamp = signStamp(deps.stampKeys.id.secret, { stampNumber, facts: idFacts(model, embedded, document), verifierName: deps.verifierName, model, embedding: b64u.encode(embedded), fields: fieldsText(document) })
    return settle(async () => {
      // Checked again: another request may have signed for this session or this stamp number meanwhile.
      kept(store.check({ sessionId, stampNumber, since: since(), payment: hash }))
      const signed = store.stamps(stampNumber).id
      if (signed && !again) return giveBack(signed)
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
      kept(store.remember({ sessionId, stampNumber, kind: 'id', since: since(), signedAt: now(), stamp, payment: hash }))
      // Read after `remember`, whose transaction keeps only the first ID stamp a stamp number gets. The
      // same facts mean the same embedding and fields: this stamp, so its fields go with it.
      const firstId = store.stamps(stampNumber).id!
      return withGift(firstId.facts === stamp.facts ? stampToJson(stamp) : keptToJson('id', stampNumber, firstId))
    })
  }

  /**
   * The stamps kept for a stamp number, one for each key, each with its own fields only. A stamp is no
   * use without the seed behind its number.
   */
  async function stampBack(body: Record<string, unknown>): Promise<[number, unknown]> {
    const stampNumber = decimal(fields(body, ['stampNumber']).stampNumber)
    if (stampNumber === null) throw new HttpError(400, 'bad_stamp_number')
    const kept = store.stamps(stampNumber)
    if (!kept.face && !kept.id) throw new HttpError(404, 'not_found')
    const back = (check: Check) => (kept[check] ? keptToJson(check, stampNumber, kept[check]) : null)
    return [200, { face: back('face'), id: back('id') }]
  }

  const routes: Record<string, Route> = {
    '/face/session': (body) => open(face, body),
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
          return void res.end(deps.about)
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
