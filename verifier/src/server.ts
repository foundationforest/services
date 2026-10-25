// The verifier's routes. The ones a person's app calls are POST with a JSON body, so nothing a person
// sends is ever in a URL: hosting platforms log the path of every request (Railway does, with the
// client's address).
//
//   GET  /              who this verifier is, as canonical JSON: its name; for each check, the key that
//                       signs its stamps, as an address, and its facts recipe; what h is; and, with
//                       a welcome gift, {"gift":{"host":"<origin>","credits":n,"sponsor":"<address>"}}
//   POST /face/session  {} or {returnUrl}         -> 201 {sessionId, url}   a face check; Didit sends the
//                                                    person back to returnUrl, an app's own page, when
//                                                    its origin is in APP_ORIGINS
//   POST /face/stamp    {sessionId, stampNumber}  -> 200 {stamp}            a stamp from the face key
//                       with a gift, also {gift: "<the host buy's reference>"}
//                                                 -> 200 {stamp, gift: {ticket} or {error}}
//   POST /id/session    {} or {payment}           -> 201 {sessionId, url}   an ID check, or 402 with a
//                                                    payment to make first
//   POST /id/stamp      {sessionId, stampNumber}  -> 200 {stamp}            a stamp from the ID key
//   POST /stamp         {stampNumber}             -> 200 {face, id}         the stamps kept for it, each
//                                                    a stamp or null, its own fields only; 404
//                                                    `not_found` when none was signed for it
//
// A session Didit holds In Review answers 202 {waiting: "review"}: a person at the foundation decides
// in Didit's console, and the app asks again. Errors are `{error: <code>}`: 400 a malformed body,
// 402 a payment still to make or still to land, 403 a check that does not count (the code says why),
// 404 `not_offered` for the ID check when it has no price or `not_found`, 409 a session or payment already used for
// another stamp number, 413 a body over 4 KB, 429 `try_later` for an address that has opened its
// share of sessions this hour, 502 Didit or the RPC not answering. A refused or failed request uses
// nothing up: the same session can be sent again.
//
// A session gives its stamp to one stamp number. Sent again with it within the hour after it was first
// signed, it gives the same stamp: Didit still has the decision. After that hour it is refused,
// `session_used`, and the sweep (`sweep`) deletes it in Didit, keeping only its face template
// (didit.ts).
//
// No request is logged. The client's address is read for one thing only, counting the sessions it
// opens against the limit (`limit.ts`), and is never written anywhere.

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { signStamp, stampToJson } from '@foundationforest/stamp'
import type { ServiceKey } from '@foundationforest/keys'
import { b64u } from '@foundationforest/records'

import { type Check, type FaceCheck, judge } from './didit.ts'
import { type Embedder, FaceError } from './face.ts'
import { type Gift, buyOf, ticketFor } from './gift.ts'
import type { RateLimit } from './limit.ts'
import { decimal, faceFacts, fingerprint, idFacts, person } from './facts.ts'
import type { Payments, Price } from './payment.ts'
import type { Ed25519Key } from './seed.ts'
import type { Store } from './store.ts'

const MAX_BODY = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A payment's id, as the verifier hands it out: 16 random bytes in hex. */
const PAYMENT_ID = /^[0-9a-f]{32}$/

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

/** The ID check's price, and how a payment is found. Unset: the ID check is not offered. */
export type PaymentDeps = {
  price: Price
  payments: Payments
  /** The address a payment with this id must name: a key mixed from the verifier's seed. */
  reference(id: string): Promise<string>
}

export type VerifierDeps = {
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
  payment?: PaymentDeps
  /** Unset: no welcome gift. */
  gift?: { gift: Gift; sponsor: Ed25519Key }
  /** The origins a `returnUrl` may be on: the apps' own. Empty: none is taken. */
  appOrigins?: string[]
  /** How often one address may open a session, on either check. */
  limit: RateLimit
  /** The header a proxy puts the client's address in; unset, the connection's own address. */
  clientAddressHeader?: string
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

/** The address a request came from: the proxy's header when one is named, else the connection's. */
function clientAddress(req: IncomingMessage, header: string | undefined): string {
  const value = header ? req.headers[header] : undefined
  const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim()
  return first || req.socket.remoteAddress || ''
}

export function handler(deps: VerifierDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { face, id, store, embedder, payment, limit } = deps
  const log = deps.log ?? ((line) => console.log(line))
  const now = deps.now ?? Date.now
  /** The earliest first signing a session may have to be signed again now. */
  const since = () => now() - SIGNED_FOR_MS

  type Route = (body: Record<string, unknown>, req: IncomingMessage) => Promise<[number, unknown]>

  /** A session on the check's workflow, counted against the address's share of the hour. */
  async function open(c: CheckDeps, req: IncomingMessage, callback?: string): Promise<[number, unknown]> {
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    try {
      return [201, await c.check.createSession({ callback })]
    } catch {
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
    if (outcome === 'session_used') throw new HttpError(409, outcome)
    if (outcome !== 'ok') throw new HttpError(403, outcome)
  }

  /**
   * The welcome gift for this stamp number, once: a ticket for the app's host buy, and the buy kept,
   * hashed, next to the stamp number. The same buy asked for again gets the same ticket; another buy
   * gets `given`. It rides with the stamp, and never holds it back.
   */
  function giveGift(stampNumber: bigint, reference: unknown): Record<string, string> {
    const ticket = ticketFor(deps.gift!.gift, reference, deps.gift!.sponsor)
    if (ticket === 'bad_gift') return { error: ticket }
    if (store.giveGift(stampNumber, buyOf(reference as string)) === 'other') return { error: 'given' }
    return { ticket }
  }

  /** A stamp from the face key, for this stamp number, from a face check Didit approved. */
  async function faceStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    const { gift: reference, ...rest } = body
    const asked = deps.gift !== undefined && 'gift' in body
    const { sessionId, stampNumber } = stampRequest(fields(asked ? rest : body, ['sessionId', 'stampNumber']))
    kept(store.check({ sessionId, stampNumber, since: since() }))

    const decision = await decided(face, sessionId)
    const embedded = await embedding(face, decision.faceImage)
    const model = embedder.model
    // Signed, with the fields its facts were made from beside it, and kept without them.
    const stamp = signStamp(deps.stampKeys.face.secret, { stampNumber, facts: faceFacts(model, embedded), model, embedding: b64u.encode(embedded) })
    // Checked again, for good, inside one transaction: the session may have given a stamp for another
    // stamp number while this request waited for Didit.
    kept(store.remember({ sessionId, stampNumber, kind: 'face', since: since(), signedAt: now(), stamp }))
    const answer: Record<string, unknown> = { stamp: stampToJson(stamp) }
    if (asked) answer.gift = giveGift(stampNumber, reference)
    return [200, answer]
  }

  /**
   * A stamp from the ID key, for this stamp number, from an ID check Didit approved, when the person's
   * fingerprint was signed for no other stamp number.
   */
  async function idStamp(body: Record<string, unknown>): Promise<[number, unknown]> {
    if (!payment) throw new HttpError(404, 'not_offered')
    const { sessionId, stampNumber } = stampRequest(fields(body, ['sessionId', 'stampNumber']))
    kept(store.check({ sessionId, stampNumber, since: since() }))

    const decision = await decided(id, sessionId)
    const who = person(decision.document)
    if (!who) throw new HttpError(403, 'no_document_data')
    const print = fingerprint(deps.fingerprintKey, who)
    kept(store.check({ sessionId, stampNumber, since: since(), fingerprint: print }))
    const embedded = await embedding(id, decision.faceImage)
    const model = embedder.model
    const facts = idFacts(model, embedded, who)
    const stamp = signStamp(deps.stampKeys.id.secret, { stampNumber, facts, model, embedding: b64u.encode(embedded), name: who.name, birth: who.birth, country: who.country })
    kept(store.remember({ sessionId, stampNumber, kind: 'id', since: since(), signedAt: now(), stamp, fingerprint: print }))
    return [200, { stamp: stampToJson(stamp) }]
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
      return stamp ? stampToJson({ stampNumber, ...stamp, verifier: deps.stampKeys[check].address }) : null
    }
    return [200, { face: back('face'), id: back('id') }]
  }

  /**
   * The ID check's session, once paid. `{}` answers 402 with a new payment: its id, the reference
   * the transfer must name, where to pay, in which dollar, how much. `{payment}` then opens a session
   * once a payment naming that reference has landed; until then it answers 402 `not_paid`, and the
   * app asks again. A payment is never given back. Each session a payment id opens carries its tag in
   * Didit, so a lost answer is found again, and a session whose opening Didit never answered is
   * found, or opened, on the next ask. A payment whose session Didit answered it opened, and no longer
   * lists, gave its stamp and was deleted since: it is used.
   */
  async function openId(body: Record<string, unknown>, req: IncomingMessage): Promise<[number, unknown]> {
    if (!payment) throw new HttpError(404, 'not_offered')
    if (Object.keys(body).length === 0) {
      const paymentId = randomBytes(16).toString('hex')
      const { amount, mint, payTo } = payment.price
      const reference = await payment.reference(paymentId)
      return [402, { error: 'payment_required', payment: { id: paymentId, reference, to: payTo, mint, amount: amount.toString() } }]
    }
    const paymentId = fields(body, ['payment']).payment!
    if (!PAYMENT_ID.test(paymentId)) throw new HttpError(400, 'bad_payment')
    // Two asks with one payment id at once share one answer, so they never open two sessions.
    const running = opening.get(paymentId)
    if (running) return running
    const answer = paidSession(paymentId, req)
    opening.set(paymentId, answer)
    try {
      return await answer
    } finally {
      opening.delete(paymentId)
    }
  }

  const opening = new Map<string, Promise<[number, unknown]>>()

  async function paidSession(paymentId: string, req: IncomingMessage): Promise<[number, unknown]> {
    const reference = await payment!.reference(paymentId)
    let landed: string[]
    try {
      landed = await payment!.payments.landed(reference)
    } catch {
      throw new HttpError(502, 'payment_check_unavailable')
    }
    if (landed.length === 0) throw new HttpError(402, 'not_paid')
    // What Didit knows the payment by: never the id itself, which claims it.
    const tag = createHash('sha256').update(`payment/${paymentId}`).digest('hex')
    const unused = landed.find((signature) => store.paymentFor(signature) === undefined)
    let paid = unused
    if (!unused) {
      // Every payment naming the reference is used: for this payment id, its session is found again,
      // or, for a payment whose opening Didit never answered, opened now; for another, refused.
      const mine = landed.filter((signature) => store.paymentFor(signature) === reference)
      if (mine.length === 0) throw new HttpError(409, 'payment_used')
      let found
      try {
        found = await id.check.tagged(tag)
      } catch {
        throw new HttpError(502, 'face_check_unavailable')
      }
      if (found) return [201, found]
      paid = mine.find((signature) => !store.opened(signature))
      if (!paid) throw new HttpError(409, 'payment_used')
    }
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    // Marked in one statement: another payment id naming this transaction may have got here first.
    if (unused && !store.usePayment(unused, reference)) throw new HttpError(409, 'payment_used')
    let session
    try {
      session = await id.check.createSession({ tag })
    } catch {
      // Opened or not, the payment stays used: the next ask finds the session by its tag, or opens it.
      throw new HttpError(502, 'face_check_unavailable')
    }
    store.markOpened(paid!)
    return [201, session]
  }

  const routes: Record<string, Route> = {
    async '/face/session'(body, req) {
      if (!('returnUrl' in body)) {
        fields(body)
        return open(face, req)
      }
      return open(face, req, returnUrlIn(deps.appOrigins ?? [], fields(body, ['returnUrl']).returnUrl!))
    },
    '/face/stamp': faceStamp,
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
        const [status, body] = await route(await readBody(req), req)
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
