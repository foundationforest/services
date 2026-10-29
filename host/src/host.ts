// The foundation's host: the plug (plug.ts, over storage.ts), run with this service's choices. It
// takes anyone's entries, inbox entries and the files a current entry names, as the standard's plug
// says; every number it uses is in `choice` below, in plug.ts's defaults, or a setting, and
// README.md says each in words.
//
// Around the plug, one thing only: a front that answers `GET /` with one line saying what this is,
// sells and takes credits (credits.ts), and passes every other request, untouched, to the plug on
// loopback.
//
// Every write is paid for in credits, from its folder's balance here: the plug asks this host's
// choices (`entryChoice`, `fileChoice`, `inboxChoice`). An entry is claimed by its id as its price
// is taken, so two copies pay once. A file's bytes are stored first: their price is reserved on a
// folder whose current entry names them, then taken once the plug answers that it stored them, or
// released; the front sends on one upload of the same bytes at a time. The plug asks about a
// folder's first profile entry, so joining costs a write, and never about a later one, so leaving
// and updating are free. Inbox entries are free, INBOX_A_DAY an inbox a day: a host cannot see who
// left one, so no folder here pays for it. Inbox deletes and reads are free.
//
// Taking your own things down is never blocked by money: a null body over a live entry costs the
// floor when the balance holds it, and goes through free when it does not. A null body where nothing
// stands is a write like any other.
//
// Where it keeps things is storage.ts's: a data directory (DATA_DIR) with a SQLite file per folder,
// and the files on disk there or in an S3-compatible bucket (FILES=s3). The credits keep their own
// file and their key in DATA_DIR/credits.

import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { encodeEntry, entryId, unsignedOf } from '@foundationforest/folders'

import { PAYMENT_HEADER, challengeOf } from '../credits/credit.ts'
import { keyAt } from '../credits/seller.ts'

import { type Answer, BALANCE_PATH, BUY_PATH, Credits, DIRECTORY_PATH, SPEND_PATH, millionthsOf } from './credits.ts'
import { type EntryChoice, type FileChoice, type FileDriver, Host, type HostOptions, type InboxChoice, defaultFileChoice, logFailure } from './plug.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host, run by the Forest Foundation: the code and the choices in foundationforest/services, ' +
  'host/README.md. Anyone can write here, paying in credits.\n'

/** This host's choices: each number the plug takes as an option. */
export const choice = {
  /** Days an entry that stopped being current or counting, an inbox entry, and a file no current entry names are kept. */
  keepDays: 30,
  /** Lines one request may carry. */
  maxBatch: 100,
  /** Lines one page holds at most. */
  maxPageLines: 1000,
  /** Bytes one page holds at most, though always one line. */
  maxPageBytes: 4 * 1024 * 1024,
  /** The largest file it takes. Its types are the plug's default: png, jpeg and mp4. */
  maxFileBytes: 50_000_000,
} as const satisfies HostOptions

/** Inbox entries one inbox takes in a day, from midnight UTC. */
export const INBOX_A_DAY = 1_000
const DAY_MS = 86_400_000

export type Config = {
  /** The data directory: the plug's storage, and the credits' file and key in `credits/`. */
  dir: string
  /** Where file bytes go: disk in `dir`, or a bucket. */
  files: FileDriver
  port: number
  /** Its public origin, `https://host`: the name its credits carry, and that a ticket names. */
  origin: string
  /** One credit's price, in US cents. */
  priceCents: number
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
  /** What a write costs, in credits as decimal text: `floor` each, and `perKb` for each 1,000 bytes it stores. */
  cost: { floor: string; perKb: string }
}

/** The bucket's settings, with FILES=s3; the first four are needed. */
const BUCKET_NEEDED = ['FILES_ENDPOINT', 'FILES_BUCKET', 'FILES_ACCESS_KEY_ID', 'FILES_SECRET_ACCESS_KEY']

function fileDriver(env: Record<string, string | undefined>): FileDriver {
  const kind = env.FILES || 'disk'
  if (kind === 'disk') return { kind: 'disk' }
  if (kind !== 's3') throw new Error('FILES is disk or s3')
  const missing = BUCKET_NEEDED.filter((name) => !env[name])
  if (missing.length) throw new Error(`FILES=s3 needs ${BUCKET_NEEDED.join(', ')}; missing: ${missing.join(', ')}`)
  new URL(env.FILES_ENDPOINT!)
  const style = env.FILES_STYLE || undefined
  if (style !== undefined && style !== 'path' && style !== 'virtual') throw new Error('FILES_STYLE is path or virtual')
  return {
    kind: 's3',
    endpoint: env.FILES_ENDPOINT!,
    bucket: env.FILES_BUCKET!,
    accessKeyId: env.FILES_ACCESS_KEY_ID!,
    secretAccessKey: env.FILES_SECRET_ACCESS_KEY!,
    // storage.ts signs with whatever region it is given, `auto` included; us-east-1 when none.
    ...(env.FILES_REGION && { region: env.FILES_REGION }),
    ...(style && { style }),
  }
}

function whole(name: string, value: string, least = 0): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < least) throw new Error(`${name} must be a whole number of at least ${least}`)
  return n
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
  const cost = { floor: (env.WRITE_FLOOR || '0.01').trim(), perKb: (env.PER_KB || '0.01').trim() }
  millionthsOf('WRITE_FLOOR', cost.floor)
  millionthsOf('PER_KB', cost.perKb)
  return {
    dir,
    files: fileDriver(env),
    port: whole('PORT', env.PORT || '8080'),
    origin,
    priceCents: whole('CREDIT_PRICE_CENTS', env.CREDIT_PRICE_CENTS || '1', 1),
    maxBuy: whole('MAX_BUY', env.MAX_BUY || '1000', 1),
    sponsors: (env.SPONSORS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cost,
  }
}

/**
 * An entry's price, from its own folder's balance: the floor and its canonical bytes by the
 * kilobyte. The plug asks about a folder's first profile entry too, so it is priced like any. A null
 * body over a live entry takes it down: it costs the floor, and goes through free when the folder
 * cannot pay. `host` is the plug the entry is going into, for what stands there.
 */
export function paidEntries(credits: Credits, host: () => Host): EntryChoice {
  return (entry) => {
    const id = entryId(unsignedOf(entry))
    if (entry.body === null && host().view(entry.profile).current.get(entry.path)?.entry.body) {
      credits.charge(entry.profile, credits.floor, id)
      return null
    }
    return credits.charge(entry.profile, credits.priceOf(Buffer.byteLength(encodeEntry(entry))), id)
  }
}

/**
 * Inbox entries are free: the sender is locked inside, so no folder here can be asked to pay. One
 * inbox takes `cap` of them a day, from midnight UTC. The count is kept in memory, so no file holds
 * how many inbox entries an inbox got, and a restart counts the day again from none.
 */
export function cappedInbox(cap = INBOX_A_DAY, now: () => number = Date.now): InboxChoice {
  let day = -1
  const counted = new Map<string, number>()
  return (entry) => {
    const today = Math.floor(now() / DAY_MS)
    if (today !== day) {
      day = today
      counted.clear()
    }
    const n = counted.get(entry.to) ?? 0
    if (n >= cap) return `this inbox has taken ${cap} inbox entries today, as many as this host takes in a day; send again after midnight UTC`
    counted.set(entry.to, n + 1)
    return null
  }
}

/**
 * A file's bytes, paid for once stored: the plug's own types, then their price, reserved on the
 * first of the folders naming them that can pay it, the newest naming entry first: the folder whose
 * app is uploading, almost always. The front takes it once they are stored, or releases it.
 */
export function paidFiles(credits: Credits): FileChoice {
  return async (file, folders) => {
    const refused = await defaultFileChoice(file, folders)
    if (refused) return refused
    let first: string | null = null
    for (const { folder } of folders) {
      const short = credits.reserve(file.sha256, folder, credits.priceOf(file.size))
      if (!short) return null
      first ??= short
    }
    return first
  }
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

const FILE = /^\/v1\/files\/([0-9a-f]{64})$/

/**
 * A request sent on to the plug, untouched, and its answer back. With `heard`, the answer (an
 * upload's, a little JSON) is read whole first, and `heard` learns, once, whether the plug stored
 * the bytes (`{ "ok": true }` and no message) before the answer goes back; anything else, or no
 * answer, is false.
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
      // A request dropped while it arrived gets no 500, so it logs none.
      if (!res.headersSent && !res.destroyed) {
        logFailure(path, err)
        res.writeHead(500, CORS)
      }
      res.end()
    })
  return true
}

export async function startHost(config: Config): Promise<RunningHost> {
  const creditsDir = join(config.dir, 'credits')
  mkdirSync(creditsDir, { recursive: true })
  const creditKey = await keyAt(join(creditsDir, 'key.der'))
  const credits = new Credits(creditsDir, { origin: config.origin, creditKey, priceCents: config.priceCents, maxBuy: config.maxBuy, sponsors: config.sponsors, cost: config.cost })
  const host: Host = new Host({
    dir: config.dir,
    files: config.files,
    ...choice,
    entryChoice: paidEntries(credits, () => host),
    fileChoice: paidFiles(credits),
    inboxChoice: cappedInbox(),
  })
  const inner = new URL(await host.listen(0))
  const fileQueue = new Map<string, Promise<void>>()

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
    const name = req.method === 'PUT' ? FILE.exec(path)?.[1] : undefined
    if (!name) return forward(inner, req, res)
    // One upload of the same bytes at a time: a second finds them stored, and pays nothing. Its price
    // was reserved by the plug (paidFiles), and is taken once the plug answers that it stored the
    // bytes, before the answer goes back, or released.
    const turn = (fileQueue.get(name) ?? Promise.resolve()).then(
      () =>
        new Promise<void>((done) => {
          forward(inner, req, res, (stored) => {
            credits.settle(name, stored)
            done()
          })
        }),
    )
    fileQueue.set(name, turn)
    void turn.then(() => {
      if (fileQueue.get(name) === turn) fileQueue.delete(name)
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
