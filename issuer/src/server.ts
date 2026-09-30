// The issuer's three routes, all POST with a JSON body, so nothing a person sends is ever in a URL:
// hosting platforms log the path of every request (Railway does, with the client's address).
//
//   POST /session   {}                        -> 201 {sessionId, url}     a Didit session to do the check on
//   POST /submit    {sessionId, commitment}   -> 202 {status: "queued"}   or an error, below
//   POST /status    {commitment}              -> 200 {status: "queued" | "listed" | "unknown"}
//
// Errors are `{error: <code>}`: 400 a malformed body, 403 a face check that does not count (the code
// says why), 409 a session already used or a commitment already queued or listed, 413 a body over
// 1 KB, 429 `try_later` for an address that has opened its share of sessions this hour, 502 Didit not
// answering. A refused or failed submit uses nothing up: the same session can be sent again, for
// instance once a review in Didit approves it.
//
// No request is logged. The client's address is read for one thing only, counting `/session` against
// the limit (`limit.ts`), and is never written anywhere.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { isFieldElement } from '../../registry/client/src/field.ts'
import { errorKind, type Batcher } from './batch.ts'
import { judge, type FaceCheck } from './didit.ts'
import type { RateLimit } from './limit.ts'
import type { IssuerList } from './list.ts'
import type { Store } from './store.ts'

const MAX_BODY = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A commitment is sent as Semaphore prints it: a decimal number, no sign, no leading zero. */
const DECIMAL = /^[1-9][0-9]{0,77}$/

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

function commitmentFrom(value: string): bigint {
  if (!DECIMAL.test(value)) throw new HttpError(400, 'bad_commitment')
  const commitment = BigInt(value)
  if (!isFieldElement(commitment)) throw new HttpError(400, 'bad_commitment')
  return commitment
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

export type IssuerDeps = {
  store: Store
  faceCheck: FaceCheck
  list: IssuerList
  batcher: Batcher
  /** How often one address may open a session. */
  limit: RateLimit
  /** The header a proxy puts the client's address in; unset, the connection's own address. */
  clientAddressHeader?: string
  workflowId: string
  log?: (line: string) => void
}

/** The address a request came from: the proxy's header when one is named, else the connection's. */
function clientAddress(req: IncomingMessage, header: string | undefined): string {
  const value = header ? req.headers[header] : undefined
  const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim()
  return first || req.socket.remoteAddress || ''
}

export function handler(deps: IssuerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, faceCheck, list, batcher, limit, workflowId } = deps
  const log = deps.log ?? ((line) => console.log(line))

  type Route = (body: Record<string, unknown>, req: IncomingMessage) => Promise<[number, unknown]>
  const routes: Record<string, Route> = {
    async '/session'(body, req) {
      fields(body)
      if (!limit.take(clientAddress(req, deps.clientAddressHeader))) throw new HttpError(429, 'try_later')
      try {
        return [201, await faceCheck.createSession()]
      } catch {
        throw new HttpError(502, 'face_check_unavailable')
      }
    },

    async '/submit'(body) {
      const input = fields(body, 'sessionId', 'commitment')
      if (!UUID.test(input.sessionId)) throw new HttpError(400, 'bad_session_id')
      const { sessionId } = input
      const commitment = commitmentFrom(input.commitment)

      if (store.isUsed(sessionId)) throw new HttpError(409, 'session_used')
      if (store.isQueued(commitment)) throw new HttpError(409, 'commitment_queued')
      if (list.has(commitment)) throw new HttpError(409, 'already_listed')

      let decision
      try {
        decision = await faceCheck.decision(sessionId)
      } catch {
        throw new HttpError(502, 'face_check_unavailable')
      }
      const refusal = judge(decision, workflowId)
      if (refusal) throw new HttpError(403, refusal)

      // Checked again, for good, inside one transaction: another request may have used this session
      // while this one waited for Didit.
      const accepted = store.accept(sessionId, commitment)
      if (accepted !== 'queued') throw new HttpError(409, accepted)
      batcher.poke()
      return [202, { status: 'queued' }]
    },

    async '/status'(body) {
      const commitment = commitmentFrom(fields(body, 'commitment').commitment)
      const status = store.isQueued(commitment) ? 'queued' : list.has(commitment) ? 'listed' : 'unknown'
      return [200, { status }]
    },
  }

  return (req, res) => {
    void (async () => {
      try {
        if (req.method === 'OPTIONS') return send(res, 204)
        const path = req.url ?? ''
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
