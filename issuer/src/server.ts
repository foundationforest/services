// The issuer's routes, for each of its two lists: the face list at the top, the ID list under /id/.
// The ones a person's app calls are POST with a JSON body, so nothing a person sends is ever in a URL:
// hosting platforms log the path of every request (Railway does, with the client's address).
//
//   POST /session      {}                  -> 201 {sessionId, url}     a Didit session to do the check on
//   POST /submit       {sessionId, stamp}  -> 202 {status: "queued"}   or an error, below
//   POST /status       {stamp}             -> 200 {status: "queued" | "listed" | "unknown"}
//   POST /id/session   {} or {payment}     -> 201 {sessionId, url}, or 402 with a payment to make first
//   POST /id/submit, POST /id/status       as above, for the ID list
//
// The public files, which anyone reads (list.ts):
//
//   GET  /list.json, /id/list.json   every stamp on the list, in order, and every snapshot, signed by its key
//
// Errors are `{error: <code>}`: 400 a malformed body, 402 a payment still to make or still to land,
// 403 a check that does not count (the code says why), 409 a session or payment already used or a
// stamp already queued or listed, 413 a body over 1 KB, 429 `try_later` for an address that has
// opened its share of sessions this hour, 502 Didit or the RPC not answering. A refused or failed
// submit uses nothing up: the same session can be sent again, for instance once a review in Didit
// approves it.
//
// No request is logged. The client's address is read for one thing only, counting the sessions it
// opens, on either list, against the limit (`limit.ts`), and is never written anywhere.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isFieldElement } from '../../forest/registry/client/src/field.ts'
import { errorKind, type Batcher } from './batch.ts'
import { judge, type FaceCheck, type Tier } from './didit.ts'
import type { RateLimit } from './limit.ts'
import type { IssuerList } from './list.ts'
import type { Payments, Price } from './payment.ts'
import type { Store } from './store.ts'

const MAX_BODY = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A stamp is sent as Semaphore prints it: a decimal number, no sign, no leading zero. */
const DECIMAL = /^[1-9][0-9]{0,77}$/
/** A payment's id, as the issuer hands it out: 16 random bytes in hex. */
const PAYMENT_ID = /^[0-9a-f]{32}$/

class HttpError extends Error {
  readonly status: number
  constructor(status: number, code: string) {
    super(code)
    this.status = status
  }
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
function fields<K extends string>(body: Record<string, unknown>, ...names: K[]): Record<K, string> {
  const keys = Object.keys(body)
  if (keys.length !== names.length || !names.every((n) => typeof body[n] === 'string')) {
    throw new HttpError(400, names.length ? `expected_exactly_${names.join('_and_')}` : 'expected_empty_body')
  }
  return body as Record<K, string>
}

function stampFrom(value: string): bigint {
  if (!DECIMAL.test(value)) throw new HttpError(400, 'bad_stamp')
  const stamp = BigInt(value)
  if (!isFieldElement(stamp)) throw new HttpError(400, 'bad_stamp')
  return stamp
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

/** A public file, as it is: its text is already canonical JSON. Readers may keep it and ask again. */
function sendFile(res: ServerResponse, text: string): void {
  res.writeHead(200, { ...CORS, 'cache-control': 'no-cache', 'content-type': 'application/json' })
  res.end(text)
}

/** One list and the check that fills it. */
export type ListDeps = {
  tier: Tier
  store: Store
  check: FaceCheck
  list: IssuerList
  batcher: Batcher
  /** The workflow its sessions are opened on; a session on any other is refused. */
  workflowId: string
}

/** The ID check's price, when it has one, and how a payment is found. */
export type PaymentDeps = {
  price: Price
  payments: Payments
  /** The address a payment with this id must name: a key mixed from the issuer's seed. */
  reference(id: string): Promise<string>
}

export type IssuerDeps = {
  face: ListDeps
  id: ListDeps
  /** Unset: the ID check is free. */
  payment?: PaymentDeps
  /** How often one address may open a session, on either list. */
  limit: RateLimit
  /** The header a proxy puts the client's address in; unset, the connection's own address. */
  clientAddressHeader?: string
  log?: (line: string) => void
}

/** The address a request came from: the proxy's header when one is named, else the connection's. */
function clientAddress(req: IncomingMessage, header: string | undefined): string {
  const value = header ? req.headers[header] : undefined
  const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim()
  return first || req.socket.remoteAddress || ''
}

export function handler(deps: IssuerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { face, id, payment, limit } = deps
  const log = deps.log ?? ((line) => console.log(line))

  type Route = (body: Record<string, unknown>, req: IncomingMessage) => Promise<[number, unknown]>

  /** A session on the list's check, counted against the address's share of the hour. */
  async function open(l: ListDeps, req: IncomingMessage): Promise<[number, unknown]> {
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    try {
      return [201, await l.check.createSession()]
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
    }
  }

  /** `/submit` and `/status`, the same for each list, on its own tables and its own check. */
  function routesFor(l: ListDeps): Record<string, Route> {
    return {
      async submit(body) {
        const input = fields(body, 'sessionId', 'stamp')
        if (!UUID.test(input.sessionId)) throw new HttpError(400, 'bad_session_id')
        const { sessionId } = input
        const stamp = stampFrom(input.stamp)

        if (l.store.isUsed(sessionId)) throw new HttpError(409, 'session_used')
        if (l.store.isQueued(stamp)) throw new HttpError(409, 'stamp_queued')
        if (l.list.has(stamp)) throw new HttpError(409, 'already_listed')

        let decision
        try {
          decision = await l.check.decision(sessionId)
        } catch {
          throw new HttpError(502, 'face_check_unavailable')
        }
        const refusal = judge(decision, l.workflowId, l.tier)
        if (refusal) throw new HttpError(403, refusal)

        // Checked again, for good, inside one transaction: another request may have used this session
        // while this one waited for Didit.
        const accepted = l.store.accept(sessionId, stamp)
        if (accepted !== 'queued') throw new HttpError(409, accepted)
        l.batcher.poke()
        return [202, { status: 'queued' }]
      },

      async status(body) {
        const stamp = stampFrom(fields(body, 'stamp').stamp)
        const status = l.store.isQueued(stamp) ? 'queued' : l.list.has(stamp) ? 'listed' : 'unknown'
        return [200, { status }]
      },
    }
  }

  /**
   * The ID check's session. Free, it opens like the face check's. With a price, `{}` answers 402 with
   * a new payment: its id, the reference the transfer must name, where to pay, in which dollar, how
   * much. `{payment}` then opens the session once a payment naming that reference has landed and no
   * session was opened with it before; until then it answers 402 `not_paid`, and the app asks again.
   */
  async function openId(body: Record<string, unknown>, req: IncomingMessage): Promise<[number, unknown]> {
    if (!payment) {
      fields(body)
      return open(id, req)
    }
    if (Object.keys(body).length === 0) {
      const paymentId = randomBytes(16).toString('hex')
      const { amount, mint, payTo } = payment.price
      const reference = await payment.reference(paymentId)
      return [402, { error: 'payment_required', payment: { id: paymentId, reference, to: payTo, mint, amount: amount.toString() } }]
    }
    const paymentId = fields(body, 'payment').payment
    if (!PAYMENT_ID.test(paymentId)) throw new HttpError(400, 'bad_payment')
    let landed: string[]
    try {
      landed = await payment.payments.landed(await payment.reference(paymentId))
    } catch {
      throw new HttpError(502, 'payment_check_unavailable')
    }
    if (landed.length === 0) throw new HttpError(402, 'not_paid')
    const unused = landed.find((signature) => !id.store.isPaymentUsed(signature))
    if (!unused) throw new HttpError(409, 'payment_used')
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    // Marked in one statement: another request with the same payment may have got here first.
    if (!id.store.usePayment(unused)) throw new HttpError(409, 'payment_used')
    try {
      return [201, await id.check.createSession()]
    } catch {
      // No session was opened, so the payment is still the person's to use.
      id.store.releasePayment(unused)
      throw new HttpError(502, 'face_check_unavailable')
    }
  }

  const faceRoutes = routesFor(face)
  const idRoutes = routesFor(id)
  const routes: Record<string, Route> = {
    async '/session'(body, req) {
      fields(body)
      return open(face, req)
    },
    '/submit': faceRoutes.submit,
    '/status': faceRoutes.status,
    '/id/session': openId,
    '/id/submit': idRoutes.submit,
    '/id/status': idRoutes.status,
  }

  const files: Record<string, () => string> = {
    '/list.json': () => face.list.file(),
    '/id/list.json': () => id.list.file(),
  }

  return (req, res) => {
    void (async () => {
      try {
        if (req.method === 'OPTIONS') return send(res, 204)
        const path = req.url ?? ''
        if (Object.hasOwn(files, path)) {
          if (req.method !== 'GET') throw new HttpError(405, 'get_only')
          return sendFile(res, files[path]())
        }
        if (!Object.hasOwn(routes, path)) throw new HttpError(404, 'not_found')
        const route = routes[path]
        if (req.method !== 'POST') throw new HttpError(405, 'post_only')
        const [status, body] = await route(await readBody(req), req)
        send(res, status, body)
      } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, { error: error.message })
        log(`issuer: request failed (${errorKind(error)})`)
        send(res, 500, { error: 'internal' })
      }
    })()
  }
}
