// The issuer's routes. The ones a person's app calls are POST with a JSON body, so nothing a person
// sends is ever in a URL: hosting platforms log the path of every request (Railway does, with the
// client's address).
//
//   GET  /issuer.json   {"key":"<128 hex>","name":"<the issuer's name>","v":1}   who this issuer is
//   POST /session       {}                       -> 201 {sessionId, url}   a face check (stage 1)
//   POST /note          {sessionId, noteNumber}  -> 200 {note}             a tier 1 note
//   POST /id/session    {} or {payment}          -> 201 {sessionId, url}   a document check (stage 2),
//                                                   or 402 with a payment to make first
//   POST /id/note       {sessionId, note}        -> 200 {note}             the same note at tier 2
//
// Errors are `{error: <code>}`: 400 a malformed body, 402 a payment still to make or still to land,
// 403 a check that does not count (the code says why), 409 a session or payment already used for
// something else, 413 a body over 4 KB, 429 `try_later` for an address that has opened its share of
// sessions this hour, 502 Didit or the RPC not answering. A refused or failed request uses nothing
// up: the same session can be sent again, for instance once a review in Didit approves it; sent again
// with the same note number once it has given a note, it gives the note again.
//
// No request is logged. The client's address is read for one thing only, counting the sessions it
// opens against the limit (`limit.ts`), and is never written anywhere.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { type IssuerKey, type SignedNote, noteSigned, signNote } from '../../standard/registry/client/src/person.ts'
import { type FaceCheck, type Tier, judge } from './didit.ts'
import { type Embedder, FACE_MATCH, FaceError, similarity } from './face.ts'
import type { RateLimit } from './limit.ts'
import { TIER, decimal, fingerprint, issuerHex, noteFromJson, noteToJson } from './notes.ts'
import type { Payments, Price } from './payment.ts'
import type { Store } from './store.ts'

const MAX_BODY = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A payment's id, as the issuer hands it out: 16 random bytes in hex. */
const PAYMENT_ID = /^[0-9a-f]{32}$/

class HttpError extends Error {
  readonly status: number
  constructor(status: number, code: string) {
    super(code)
    this.status = status
  }
}

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

/** Exactly these fields, each of its type: the service takes nothing it doesn't need. */
function fields(body: Record<string, unknown>, shape: Record<string, 'string' | 'object'> = {}): Record<string, unknown> {
  const names = Object.keys(shape)
  const keys = Object.keys(body)
  if (keys.length !== names.length || !names.every((n) => typeof body[n] === shape[n] && body[n] !== null)) {
    throw new HttpError(400, names.length ? `expected_exactly_${names.join('_and_')}` : 'expected_empty_body')
  }
  return body
}

function sessionIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'bad_session_id')
  return value
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

/** One check: its tier, its Didit workflow, and Didit. */
export type CheckDeps = {
  tier: Tier
  check: FaceCheck
  /** The workflow its sessions are opened on; a session on any other is refused. */
  workflowId: string
}

/** The document check's price, when it has one, and how a payment is found. */
export type PaymentDeps = {
  price: Price
  payments: Payments
  /** The address a payment with this id must name: a key mixed from the issuer's seed. */
  reference(id: string): Promise<string>
}

export type IssuerDeps = {
  face: CheckDeps
  id: CheckDeps
  store: Store
  embedder: Embedder
  /** The note key: its 32 private bytes, and its public key. */
  noteKey: { privateKey: Uint8Array; key: IssuerKey }
  /** The key the document fingerprints are made under. */
  fingerprintKey: Uint8Array
  /** `GET /issuer.json`, canonical text. */
  about: string
  /** Unset: the document check is free. */
  payment?: PaymentDeps
  /** How often one address may open a session, on either check. */
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
  const { face, id, store, embedder, payment, limit } = deps
  const log = deps.log ?? ((line) => console.log(line))

  type Route = (body: Record<string, unknown>, req: IncomingMessage) => Promise<[number, unknown]>

  /** A session on the check's workflow, counted against the address's share of the hour. */
  async function open(c: CheckDeps, req: IncomingMessage): Promise<[number, unknown]> {
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    try {
      return [201, await c.check.createSession()]
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
    }
  }

  /** What Didit decided for this session, with Didit's part of the rule applied. */
  async function decided(c: CheckDeps, sessionId: string) {
    let decision
    try {
      decision = await c.check.decision(sessionId)
    } catch {
      throw new HttpError(502, 'face_check_unavailable')
    }
    const refusal = judge(decision, c.workflowId, c.tier)
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

  const sign = (note: Omit<SignedNote, 'issuer' | 'signature'>) => [200, { note: noteToJson(signNote(deps.noteKey.privateKey, note)) }] as [number, unknown]

  /**
   * Stage 1: a tier 1 note for this note number, from a face check that passed. A face Didit's
   * search found in an earlier session is signed again only for the note number that session gave.
   */
  async function faceNote(body: Record<string, unknown>): Promise<[number, unknown]> {
    const input = fields(body, { sessionId: 'string', noteNumber: 'string' })
    const sessionId = sessionIdFrom(input.sessionId)
    const noteNumber = decimal(input.noteNumber)
    if (!noteNumber) throw new HttpError(400, 'bad_note_number')
    kept(store.check({ sessionId, noteNumber }))

    const decision = await decided(face, sessionId)
    const earlier = decision.matches.filter((s) => s !== sessionId)
    kept(store.check({ sessionId, noteNumber, earlier }))
    const embedded = await embedding(face, decision.faceImage)
    // Checked again, for good, inside one transaction: another session with this face may have given
    // a note while this one waited for Didit.
    kept(store.remember({ sessionId, noteNumber, earlier }))
    return sign({ noteNumber, embedding: embedded, model: embedder.model, tier: TIER.face })
  }

  /**
   * Stage 2: the note the person shows, at tier 2, from a document check that passed, when the live
   * face matches the note's, and the document's person was signed for no other note number.
   */
  async function idNote(body: Record<string, unknown>): Promise<[number, unknown]> {
    const input = fields(body, { sessionId: 'string', note: 'object' })
    const sessionId = sessionIdFrom(input.sessionId)
    const note = noteFromJson(input.note)
    if (!note) throw new HttpError(400, 'bad_note')
    if (issuerHex(note.issuer) !== issuerHex(deps.noteKey.key) || !noteSigned(note)) throw new HttpError(403, 'not_our_note')
    if (note.model !== embedder.model) throw new HttpError(403, 'other_model')
    const { noteNumber } = note
    kept(store.check({ sessionId, noteNumber }))

    const decision = await decided(id, sessionId)
    const print = fingerprint(deps.fingerprintKey, decision.document)
    if (!print) throw new HttpError(403, 'no_document_data')
    kept(store.check({ sessionId, noteNumber, fingerprint: print }))
    const live = await embedding(id, decision.faceImage)
    if (similarity(live, note.embedding) < FACE_MATCH) throw new HttpError(403, 'not_the_same_face')
    kept(store.remember({ sessionId, noteNumber, fingerprint: print }))
    return sign({ noteNumber, embedding: note.embedding, model: note.model, tier: TIER.id })
  }

  /**
   * The document check's session. Free, it opens like the face check's. With a price, `{}` answers
   * 402 with a new payment: its id, the reference the transfer must name, where to pay, in which
   * dollar, how much. `{payment}` then opens the session once a payment naming that reference has
   * landed and no session was opened with it before; until then it answers 402 `not_paid`, and the
   * app asks again.
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
    const paymentId = fields(body, { payment: 'string' }).payment as string
    if (!PAYMENT_ID.test(paymentId)) throw new HttpError(400, 'bad_payment')
    let landed: string[]
    try {
      landed = await payment.payments.landed(await payment.reference(paymentId))
    } catch {
      throw new HttpError(502, 'payment_check_unavailable')
    }
    if (landed.length === 0) throw new HttpError(402, 'not_paid')
    const unused = landed.find((signature) => !store.isPaymentUsed(signature))
    if (!unused) throw new HttpError(409, 'payment_used')
    if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
    // Marked in one statement: another request with the same payment may have got here first.
    if (!store.usePayment(unused)) throw new HttpError(409, 'payment_used')
    try {
      return [201, await id.check.createSession()]
    } catch {
      // No session was opened, so the payment is still the person's to use.
      store.releasePayment(unused)
      throw new HttpError(502, 'face_check_unavailable')
    }
  }

  const routes: Record<string, Route> = {
    async '/session'(body, req) {
      fields(body)
      return open(face, req)
    },
    '/note': faceNote,
    '/id/session': openId,
    '/id/note': idNote,
  }

  return (req, res) => {
    void (async () => {
      try {
        if (req.method === 'OPTIONS') return send(res, 204)
        const path = req.url ?? ''
        if (path === '/issuer.json') {
          if (req.method !== 'GET') throw new HttpError(405, 'get_only')
          res.writeHead(200, { ...CORS, 'cache-control': 'no-cache', 'content-type': 'application/json' })
          return void res.end(deps.about)
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
