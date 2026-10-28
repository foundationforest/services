// The foundation's host: the plug (plug.ts, over storage.ts), run with this service's choices. It
// takes anyone's records, delivers messages to inboxes, and keeps blobs, as the standard's plug
// says; every number it uses is in `choice` below, in plug.ts's defaults, or a setting, and
// README.md says each in words.
//
// Around the plug, one thing only: a front that answers `GET /` with one line saying what this is,
// sells and takes credits (credits.ts), and passes every other request, untouched, to the plug on
// loopback.
//
// Every write is paid for in credits, from its folder's balance here: the plug asks this host's
// choices (`recordChoice`, `blobChoice`, `messageChoice`). A record is claimed by its id as its
// price is taken, so two copies pay once. Bytes are stored first: their price is reserved, then
// taken once the plug answers that it kept them, or released; the front sends on one request for
// the same bytes at a time. The plug asks about a folder's first hosts record, so joining costs a
// write, and never about a later one, so leaving and updating are free. A message to its own
// profile's inbox is a write of that folder's, priced and claimed as a record is; others' messages
// are free, MESSAGES_A_DAY an inbox a day. Reads are free.
//
// Taking your own things down is never blocked by money: a null body over a live record, and a blob
// delete the plug carries out, cost the floor when the balance holds it, and go through free when it
// does not. A null body where nothing stands is a write like any other.
//
// Where it keeps things is storage.ts's: a data directory (DATA_DIR) with a SQLite file per folder,
// and the blobs on disk there or in an S3-compatible bucket (BLOBS=s3). The credits keep their own
// file and their key in DATA_DIR/credits.

import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { checkBlobRequest, encodeMessage, encodeRecord, messageId, recordId, unsignedMessageOf, unsignedOf } from '@foundationforest/records'
import { base58 } from '@scure/base'

import { PAYMENT_HEADER, challengeOf } from '../credits/credit.ts'
import { type Rpc, keyAt } from '../credits/seller.ts'

import { type Answer, BALANCE_PATH, BUY_PATH, Credits, DIRECTORY_PATH, SPEND_PATH, millionthsOf } from './credits.ts'
import { type BlobChoice, type BlobDriver, Host, type HostOptions, type MessageChoice, type RecordChoice, defaultBlobChoice, logFailure } from './plug.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host, run by the Forest Foundation: the code and the choices in foundationforest/services, ' +
  'host/README.md. Anyone can write here, paying in credits.\n'

/** This host's choices: each number the plug takes as an option. */
export const choice = {
  /** Days a replaced record or a message is kept. */
  keepDays: 30,
  /** Records or messages one request may carry. */
  maxBatch: 100,
  /** Records or messages one page holds at most. */
  maxPageRecords: 1000,
  /** Bytes one page holds at most, though always one line. */
  maxPageBytes: 4 * 1024 * 1024,
  /** The largest blob it takes. Its types are the standard's default: png, jpeg and mp4. */
  maxBlobBytes: 50_000_000,
} as const satisfies HostOptions

/** Others' messages one inbox takes in a day, from midnight UTC. */
export const MESSAGES_A_DAY = 1_000
const DAY_MS = 86_400_000

export type Config = {
  /** The data directory: the plug's storage, and the credits' file and key in `credits/`. */
  dir: string
  /** Where blob bytes go: disk in `dir`, or a bucket. */
  blobs: BlobDriver
  port: number
  /** Its public origin, `https://host`: the name its credits carry, and that a ticket names. */
  origin: string
  /** One credit's price, in US cents. */
  priceCents: number
  /** Where a credit is paid on Solana, in which dollar, and the RPC that checks it; null: only tickets buy. */
  payment: { address: string; mint: string; rpcUrl: string } | null
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
  /** What a write costs, in credits as decimal text: `floor` each, and `perKb` for each 1,000 bytes it stores. */
  cost: { floor: string; perKb: string }
}

/** The bucket's settings, with BLOBS=s3; the first four are needed. */
const BUCKET_NEEDED = ['BLOBS_ENDPOINT', 'BLOBS_BUCKET', 'BLOBS_ACCESS_KEY_ID', 'BLOBS_SECRET_ACCESS_KEY']
/** A payment on Solana takes all three, or none: then only tickets buy. */
const PAYMENT = ['CREDIT_MINT', 'CREDIT_PAY_TO', 'RPC_URL']

function blobDriver(env: Record<string, string | undefined>): BlobDriver {
  const kind = env.BLOBS || 'disk'
  if (kind === 'disk') return { kind: 'disk' }
  if (kind !== 's3') throw new Error('BLOBS is disk or s3')
  const missing = BUCKET_NEEDED.filter((name) => !env[name])
  if (missing.length) throw new Error(`BLOBS=s3 needs ${BUCKET_NEEDED.join(', ')}; missing: ${missing.join(', ')}`)
  new URL(env.BLOBS_ENDPOINT!)
  const style = env.BLOBS_STYLE || undefined
  if (style !== undefined && style !== 'path' && style !== 'virtual') throw new Error('BLOBS_STYLE is path or virtual')
  return {
    kind: 's3',
    endpoint: env.BLOBS_ENDPOINT!,
    bucket: env.BLOBS_BUCKET!,
    accessKeyId: env.BLOBS_ACCESS_KEY_ID!,
    secretAccessKey: env.BLOBS_SECRET_ACCESS_KEY!,
    // storage.ts signs with whatever region it is given, `auto` included; us-east-1 when none.
    ...(env.BLOBS_REGION && { region: env.BLOBS_REGION }),
    ...(style && { style }),
  }
}

function whole(name: string, value: string, least = 0): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < least) throw new Error(`${name} must be a whole number of at least ${least}`)
  return n
}

function solanaAddress(name: string, value: string): string {
  try {
    if (base58.decode(value).length === 32 && base58.encode(base58.decode(value)) === value) return value
  } catch {
    // Refused below.
  }
  throw new Error(`${name} is a Solana address`)
}

/** Reads the settings README.md lists. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const dir = env.DATA_DIR?.trim()
  if (!dir) throw new Error('DATA_DIR is needed: where the folders, the credits and their key are kept')
  const origin = env.PUBLIC_ORIGIN?.trim() ?? ''
  if (!URL.canParse(origin) || new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN is needed, an origin: https://host')
  try {
    challengeOf(origin)
  } catch {
    throw new Error('PUBLIC_ORIGIN is https, or http only on loopback')
  }
  const paid = PAYMENT.filter((name) => env[name]?.trim())
  if (paid.length && paid.length < PAYMENT.length) throw new Error(`a payment on Solana needs ${PAYMENT.join(', ')}, or none of them`)
  const rpcUrl = env.RPC_URL?.trim()
  if (rpcUrl) new URL(rpcUrl)
  const cost = { floor: (env.WRITE_FLOOR || '0.01').trim(), perKb: (env.PER_KB || '0.01').trim() }
  millionthsOf('WRITE_FLOOR', cost.floor)
  millionthsOf('PER_KB', cost.perKb)
  return {
    dir,
    blobs: blobDriver(env),
    port: whole('PORT', env.PORT || '8080'),
    origin,
    priceCents: whole('CREDIT_PRICE_CENTS', env.CREDIT_PRICE_CENTS || '1', 1),
    payment: rpcUrl ? { address: solanaAddress('CREDIT_PAY_TO', env.CREDIT_PAY_TO!.trim()), mint: solanaAddress('CREDIT_MINT', env.CREDIT_MINT!.trim()), rpcUrl } : null,
    maxBuy: whole('MAX_BUY', env.MAX_BUY || '1000', 1),
    sponsors: (env.SPONSORS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cost,
  }
}

/** A JSON-RPC call through `url`, for the payment check. Its errors never carry the URL, which may carry the RPC's key. */
function rpcAt(url: string): Rpc {
  return async (method, params) => {
    let answered: { result?: unknown; error?: unknown }
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
      answered = (await res.json()) as typeof answered
    } catch {
      throw new Error('the RPC could not be reached')
    }
    if (answered.error !== undefined || !('result' in answered)) throw new Error(`the RPC refused ${method}`)
    return answered.result
  }
}

/**
 * A record's price, from its own folder's balance: the floor and its canonical bytes by the kilobyte.
 * The plug asks about a folder's first hosts record too, so it is priced like any. A null body over a
 * live record takes it down: it costs the floor, and goes through free when the folder cannot pay.
 * `host` is the plug the record is going into, for what stands there.
 */
export function paidRecords(credits: Credits, host: () => Host): RecordChoice {
  return (record) => {
    const id = recordId(unsignedOf(record))
    if (record.body === null && host().view(record.profile).current.get(record.path)?.record.body) {
      credits.charge(record.profile, credits.floor, id)
      return null
    }
    return credits.charge(record.profile, credits.priceOf(Buffer.byteLength(encodeRecord(record))), id)
  }
}

/**
 * A message's price. One whose `from` is its `to` is the profile writing to its own inbox, its
 * devices passing things to each other: a write of that folder's, priced from its balance as a
 * record of the same canonical bytes is, and claimed by its id, so two copies pay once. Any other is
 * free, and one inbox takes `cap` of them a day, from midnight UTC. The count is kept in memory, so
 * no file holds how many messages an inbox got, and a restart counts the day again from none.
 */
export function pricedMessages(credits: Credits, cap = MESSAGES_A_DAY, now: () => number = Date.now): MessageChoice {
  let day = -1
  const counted = new Map<string, number>()
  return (m) => {
    if (m.from === m.to) return credits.charge(m.to, credits.priceOf(Buffer.byteLength(encodeMessage(m))), messageId(unsignedMessageOf(m)))
    const today = Math.floor(now() / DAY_MS)
    if (today !== day) {
      day = today
      counted.clear()
    }
    const n = counted.get(m.to) ?? 0
    if (n >= cap) return `this inbox has taken ${cap} messages from others today, as many as this host takes in a day; send again after midnight UTC`
    counted.set(m.to, n + 1)
    return null
  }
}

/** Bytes, paid for once stored: the plug's own types, then their price, reserved on the folder that puts them. The front takes it once they are kept, or releases it. */
export function paidBlobs(credits: Credits): BlobChoice {
  return async (blob, stored) => (await defaultBlobChoice(blob, stored)) ?? credits.reserve(blob.sha256, blob.profile, credits.priceOf(blob.size))
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

export type RunningHost = {
  url: string
  host: Host
  credits: Credits
  server: Server
  close(): Promise<void>
}

const BLOB = /^\/v1\/blobs\/([0-9a-f]{64})$/

/**
 * A request sent on to the plug, untouched, and its answer back. With `heard`, the answer (a blob
 * request's, a little JSON) is read whole first, and `heard` learns, once, whether the plug carried
 * the request out (`{ "ok": true }` and no message: bytes stored, or deleted)
 * before the answer goes back; anything else, or no answer, is false.
 */
function forward(inner: URL, req: IncomingMessage, res: ServerResponse, heard?: (done: boolean) => void): void {
  let told = false
  const tell = (done: boolean) => {
    if (!told) heard?.(done)
    told = true
  }
  let upstream
  try {
    upstream = request({ host: inner.hostname, port: inner.port, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
      if (!heard) {
        res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
        return void answer.pipe(res)
      }
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        const body = Buffer.concat(chunks)
        let said: { ok?: unknown; message?: unknown } | undefined
        try {
          said = JSON.parse(body.toString('utf8')) ?? undefined
        } catch {
          // Not the standard's JSON: nothing was carried out.
        }
        tell(answer.statusCode === 200 && said?.ok === true && said.message === undefined)
        res.writeHead(answer.statusCode ?? 502, passed(answer.headers)).end(body)
      })
      answer.on('close', () => {
        if (told) return
        tell(false)
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
    })
  } catch {
    // A request node:http will not send on, as it is.
    tell(false)
    req.resume()
    return void res.writeHead(400, { 'access-control-allow-origin': '*' }).end()
  }
  upstream.on('error', () => {
    tell(false)
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
}

/** A credit route's body read whole: a buy of the most credits is a little over 260 bytes each. */
const MAX_CREDIT_BODY = 512 * 1024
const CORS = { 'access-control-allow-origin': '*' }

function send(res: ServerResponse, answered: Answer): void {
  const body = answered.body instanceof Uint8Array ? answered.body : JSON.stringify(answered.body)
  res.writeHead(answered.status, { ...CORS, 'content-type': answered.type ?? 'application/json' }).end(body)
}

async function readBytes(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_CREDIT_BODY) return undefined
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** The credit routes (credits.ts); false for any other path, which goes to the plug. */
function creditRoute(credits: Credits, path: string, req: IncomingMessage, res: ServerResponse): boolean {
  const routes = [DIRECTORY_PATH, BUY_PATH, SPEND_PATH]
  if (!routes.includes(path) && !path.startsWith(BALANCE_PATH)) return false
  if (req.method === 'OPTIONS') {
    req.resume()
    res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': `content-type, ${PAYMENT_HEADER}`, 'access-control-max-age': '86400' }).end()
    return true
  }
  if (req.method === 'GET' && path === DIRECTORY_PATH) {
    req.resume()
    send(res, { status: 200, body: credits.directory(), type: 'application/private-token-issuer-directory' })
    return true
  }
  if (req.method === 'GET' && path.startsWith(BALANCE_PATH)) {
    req.resume()
    send(res, credits.balanceOf(path.slice(BALANCE_PATH.length)))
    return true
  }
  if (req.method !== 'POST' || (path !== BUY_PATH && path !== SPEND_PATH)) {
    req.resume()
    send(res, { status: 405, body: { error: 'method' } })
    return true
  }
  readBytes(req)
    .then(async (bytes) => {
      if (!bytes) return send(res, { status: 413, body: { error: 'too_big' } })
      if (path === BUY_PATH) return send(res, await credits.seller.collect(bytes, req.headers[PAYMENT_HEADER] as string | undefined))
      let body: unknown
      try {
        body = JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        body = undefined
      }
      send(res, await credits.spend(body))
    })
    .catch((err: unknown) => {
      if (!res.headersSent) {
        logFailure(path, err)
        res.writeHead(500, CORS)
      }
      res.end()
    })
  return true
}

/** The folder a blob delete is for, when the header holds a signed delete of the bytes `name`; null for anything else, which the plug refuses itself. */
function deleteFrom(header: string | string[] | undefined, name: string): string | null {
  if (typeof header !== 'string') return null
  try {
    const ask = checkBlobRequest(header, Date.now())
    return ask.action === 'delete' && ask.sha256 === name ? ask.profile : null
  } catch {
    return null
  }
}

/** In tests, `rpc` stands in for the RPC the payment check asks, otherwise made from the payment's `rpcUrl`. */
export async function startHost(config: Config, stand: { rpc?: Rpc } = {}): Promise<RunningHost> {
  const creditsDir = join(config.dir, 'credits')
  mkdirSync(creditsDir, { recursive: true })
  const creditKey = await keyAt(join(creditsDir, 'key.der'))
  const payment = config.payment && { address: config.payment.address, mint: config.payment.mint, rpc: stand.rpc ?? rpcAt(config.payment.rpcUrl) }
  const credits = new Credits(creditsDir, { origin: config.origin, creditKey, priceCents: config.priceCents, payment, maxBuy: config.maxBuy, sponsors: config.sponsors, cost: config.cost })
  const host: Host = new Host({
    dir: config.dir,
    blobs: config.blobs,
    ...choice,
    recordChoice: paidRecords(credits, () => host),
    blobChoice: paidBlobs(credits),
    messageChoice: pricedMessages(credits),
  })
  const inner = new URL(await host.listen(0))
  const blobQueue = new Map<string, Promise<void>>()

  const server = createServer((req, res) => {
    // A URL no URL parser reads (`//`, `/\`) is refused here: thrown in this handler, it would stop
    // the process.
    const path = URL.parse(req.url ?? '/', 'http://host.invalid')?.pathname
    if (path === undefined) {
      req.resume()
      return void res.writeHead(400, CORS).end()
    }
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      req.resume()
      res.writeHead(200, { ...CORS, 'content-type': 'text/plain; charset=utf-8' })
      return void res.end(req.method === 'HEAD' ? undefined : LABEL)
    }
    if (creditRoute(credits, path, req, res)) return
    const name = req.method === 'PUT' || req.method === 'DELETE' ? BLOB.exec(path)?.[1] : undefined
    if (!name) return forward(inner, req, res)
    // One put or delete of the same bytes at a time: a second put finds them kept, and pays nothing.
    // A put's price was reserved by the plug (paidBlobs); a delete's floor is reserved here, when the
    // folder holds it, and the delete goes on either way. Each is taken once the plug answers that it
    // carried the request out, before the answer goes back, or released.
    const turn = (blobQueue.get(name) ?? Promise.resolve()).then(
      () =>
        new Promise<void>((done) => {
          const folder = req.method === 'DELETE' ? deleteFrom(req.headers['forest-blob'], name) : null
          if (folder) credits.reserve(name, folder, credits.floor)
          forward(inner, req, res, (carried) => {
            credits.settle(name, carried)
            done()
          })
        }),
    )
    blobQueue.set(name, turn)
    void turn.then(() => {
      if (blobQueue.get(name) === turn) blobQueue.delete(name)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host,
    credits,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await host.close()
      credits.close()
    },
  }
}
