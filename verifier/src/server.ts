// The verifier's routes. The ones a person's app calls are POST with a JSON body, so nothing a person
// sends is ever in a URL: hosting platforms log the path of every request (Railway does, with the
// client's address).
//
//   GET  /              who this verifier is, as canonical JSON: its name; for each check, the key that
//                       signs its stamps, as an address, and its facts recipe; what h is; and, with
//                       gifts, {"gift":{"face":n,"host":"<origin>","id":n,"sponsor":"<address>"}}
//   POST /face/session  {} or {returnUrl}         -> 201 {sessionId, url}   a face check; Didit sends the
//                                                    person back to returnUrl, an app's own page, when
//                                                    its origin is in APP_ORIGINS
//   POST /face/stamp    {sessionId, stampNumber}  -> 200 {stamp}            a stamp from the face key
//                       with a gift, also {gift: "<the host buy's reference>"}
//                                                 -> 200 {stamp, gift: {ticket} or {error}}
//   POST /id/payment    {returnUrl}               -> 201 {payment, url}     a Stripe Checkout page for one
//                                                    ID check (stripe.ts); Stripe sends the person back
//                                                    to returnUrl, on an origin in APP_ORIGINS
//   POST /id/session    {payment} or {payment, returnUrl}
//                                                 -> 201 {sessionId, url}   an ID check, opened as a face
//                                                    check is, for a paid payment with a try left
//   POST /id/stamp      {sessionId, stampNumber, payment}
//                                                 -> 200 {stamp}            a stamp from the ID key, for a
//                                                    payment that gave none yet, and its gift asked as
//                                                    the face stamp's is
//   POST /stamp         {stampNumber}             -> 200 {face, id}         the stamps kept for it, each
//                                                    a stamp or null, its own fields only; 404
//                                                    `not_found` when none was signed for it
//
// A session Didit holds In Review answers 202 {waiting: "review"}: a person at the foundation decides
// in Didit's console, and the app asks again. Errors are `{error: <code>}`: 400 a malformed body,
// 402 a payment not paid, 403 a check that does not count (the code says why; `declined` and
// `expired` mean the session will never pass, so the app starts a new one), 404 `not_found`, 409 a
// session already used for another stamp number, or a payment used up, 413 a body over 4 KB, 502
// Didit or Stripe not answering, 503 the ID check not for sale (no Stripe). A refused or failed
// request uses nothing up: the same session can be sent again.
//
// One payment opens up to ID_TRIES ID sessions (store.ts) and gives one ID stamp. The payment sent
// with a stamp need not be the one that opened its session: each opens at most ID_TRIES and gives at
// most one, which is all the rule needs, so nothing ever ties a payment to a session.
//
// A session gives its stamp to one stamp number. Sent again with it within the hour after it was first
// signed, it gives the same stamp: Didit still has the decision. After that hour it is refused,
// `session_used`, and the sweep (`sweep`) deletes it in Didit, keeping only its face template
// (didit.ts).
//
// No request is logged, and the client's address is never read.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { signStamp, stampToJson } from '@foundationforest/proofs'
import type { ServiceKey } from '@foundationforest/keys'
import { b64u } from '@foundationforest/folders'

import { type Check, type FaceCheck, judge } from './didit.ts'
import { type Embedder, FaceError } from './face.ts'
import { type Gift, buyOf, ticketFor } from './gift.ts'
import { decimal, faceFacts, fingerprint, idFacts, person } from './facts.ts'
import type { Ed25519Key } from './seed.ts'
import { type Store, paymentHash } from './store.ts'
import { PAYMENT, type Payments } from './stripe.ts'

const MAX_BODY = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class HttpError extends Error {
  readonly status: number
  constructor(status: number, code: string) {
    super(code)
    this.status = status
  }
}

/** Didit holds the session In Review: answered 202, not as an error. */
class Waiting extends Error {}

/** The kind of error, never its message: a message can carry a URL, a key or a session. */
export const errorKind = (error: unknown) => (error instanceof Error ? error.constructor.name : typeof error)

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
    throw new HttpError(400, names.length ? `expected_exactly_${names.join('_and_')}` : 'expected_empty_body')
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
  /** The key the ID check's fingerprints are made under. */
  fingerprintKey: Uint8Array
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

/** How often the sweep looks for sessions to delete. */
export const SWEEP_EVERY_MS = 60_000

/**
 * Deletes in Didit each session whose stamp was first signed an hour ago or more, keeping its face
 * template, and forgets its id and time once Didit has deleted it. A deletion Didit does not answer
 * stays, for the next sweep. Logs without the session: how many deletions failed, and what Didit said
 * it did with a face when it kept no template.
 */
export async function sweep(deps: { store: Store; checks: Record<Check, FaceCheck>; now?: () => number; log?: (line: string) => void }): Promise<void> {
  const log = deps.log ?? ((line) => console.log(line))
  let failed = 0
  let kind = ''
  for (const { sessionId, kind: check } of deps.store.due((deps.now ?? Date.now)() - SIGNED_FOR_MS)) {
    let outcome: string
    try {
      outcome = await deps.checks[check].deleteSession(sessionId)
    } catch (error) {
      failed++
      kind = errorKind(error)
      continue
    }
    deps.store.deleted(sessionId)
    if (outcome !== 'retained_with_user' && outcome !== 'gone') log(`verifier: Didit kept no face template for a deleted session (${outcome || 'no outcome'})`)
  }
  if (failed) log(`verifier: ${failed} signed session${failed === 1 ? '' : 's'} could not be deleted in Didit, kept for the next sweep (${kind})`)
}

export function handler(deps: VerifierDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { face, id, store, embedder } = deps
  const log = deps.log ?? ((line) => console.log(line))
  const now = deps.now ?? Date.now
  /** The earliest first signing a session may have to be signed again now. */
  const since = () => now() - SIGNED_FOR_MS

  type Route = (body: Record<string, unknown>) => Promise<[number, unknown]>

  /**
   * A session on the check's workflow: `{}`, or `{returnUrl}` on an app's origin, where Didit sends
   * the person when it is done.
   */
  async function open(c: CheckDeps, body: Record<string, unknown>): Promise<[number, unknown]> {
    let callback: string | undefined
    if ('returnUrl' in body) callback = returnUrlIn(deps.appOrigins ?? [], fields(body, ['returnUrl']).returnUrl!)
    else fields(body)
    try {
      return [201, await c.check.createSession({ callback })]
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
    }
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
    } catch {
      throw new HttpError(502, 'payment_unavailable')
    }
  }

  /**
   * An ID session, for a payment: Stripe is asked only the first time, whether it was paid; then each
   * session takes one of its tries, and a session Didit does not open gives its try back.
   */
  async function openId(body: Record<string, unknown>): Promise<[number, unknown]> {
    const payments = forSale()
    const input = fields(body, 'returnUrl' in body ? ['payment', 'returnUrl'] : ['payment'])
    const callback = input.returnUrl === undefined ? undefined : returnUrlIn(deps.appOrigins ?? [], input.returnUrl)
    const payment = paymentOf(input.payment!)
    const hash = paymentHash(payment)
    if (!store.knowsPayment(hash)) {
      let paid: boolean
      try {
        paid = await payments.paid(payment)
      } catch {
        throw new HttpError(502, 'payment_unavailable')
      }
      if (!paid) throw new HttpError(402, 'not_paid')
    }
    kept(store.takeTry(hash))
    try {
      return [201, await id.check.createSession({ callback })]
    } catch {
      store.giveBackTry(hash)
      throw new HttpError(502, 'face_check_unavailable')
    }
  }

  /** What Didit decided for this session, if it passed: otherwise waiting, or the refusal. */
  async function decided(c: CheckDeps, sessionId: string) {
    let decision
    try {
      decision = await c.check.decision(sessionId)
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
    }
    const refusal = judge(decision, c.workflowId, c.kind)
    // A session that gave a stamp and is gone from Didit was deleted: by the sweep, or by hand.
    if (refusal === 'unknown_session' && store.holds(sessionId)) throw new HttpError(409, 'session_used')
    if (refusal === 'in_review') throw new Waiting()
    if (refusal) throw new HttpError(403, refusal)
    return decision!
  }

  /** The embedding of the selfie the session took. */
  async function embedding(c: CheckDeps, url: string | null): Promise<Uint8Array> {
    if (!url) throw new HttpError(403, 'no_face')
    let photo: Uint8Array
    try {
      photo = await c.check.photo(url)
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
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

  /**
   * A stamp from the ID key, for this stamp number, from an ID check Didit approved, for a payment that
   * gave no stamp yet, when the person's fingerprint was signed for no other stamp number.
   */
  async function idStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    forSale()
    const { sessionId, stampNumber, input, gift } = stampAsked('id', body, ['payment'])
    const payment = paymentHash(paymentOf(input.payment!))
    kept(store.check({ sessionId, stampNumber, since: since(), payment }))

    const decision = await decided(id, sessionId)
    const who = person(decision.document)
    if (!who) throw new HttpError(403, 'no_document_data')
    const print = fingerprint(deps.fingerprintKey, who)
    kept(store.check({ sessionId, stampNumber, since: since(), fingerprint: print, payment }))
    const embedded = await embedding(id, decision.faceImage)
    const model = embedder.model
    const facts = idFacts(model, embedded, who)
    const stamp = signStamp(deps.stampKeys.id.secret, { stampNumber, facts, verifierName: deps.verifierName, model, embedding: b64u.encode(embedded), name: who.name, birth: who.birth, country: who.country })
    kept(store.remember({ sessionId, stampNumber, kind: 'id', since: since(), signedAt: now(), stamp, fingerprint: print, payment }))
    return [200, { stamp: stampToJson(stamp), ...(gift && { gift: giveGift('id', stampNumber, gift.reference) }) }]
  }

  /**
   * The stamps kept for a stamp number, one for each key, each with its own fields only: the fields
   * beside it were never kept. A stamp is no use without the seed behind its number.
   */
  async function stampBack(body: Record<string, unknown>): Promise<[number, unknown]> {
    const stampNumber = decimal(fields(body, ['stampNumber']).stampNumber)
    if (stampNumber === null) throw new HttpError(400, 'bad_stamp_number')
    const kept = store.stamps(stampNumber)
    if (!kept.face && !kept.id) throw new HttpError(404, 'not_found')
    const back = (check: Check) => {
      const stamp = kept[check]
      return stamp ? stampToJson({ stampNumber, ...stamp, verifierName: deps.verifierName, verifier: deps.stampKeys[check].address }) : null
    }
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
        if (error instanceof Waiting) return send(res, 202, { waiting: 'review' })
        if (error instanceof HttpError) return send(res, error.status, { error: error.message })
        log(`verifier: request failed (${errorKind(error)})`)
        send(res, 500, { error: 'internal' })
      }
    })()
  }
}
