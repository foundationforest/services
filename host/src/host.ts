// The foundation's host: standard/records' reference host (standard/records/src/host.ts), unchanged, run
// with this service's policy. It takes anyone's records, delivers messages to inboxes, and keeps
// blobs, as forest's host does; every number it uses is in POLICY below, and README.md says each in
// words.
//
// Around forest's host, one thing only: a front that answers `GET /` with one line saying what this
// is, sells and takes credits (credits.ts), and passes every other request, untouched, to the host on
// loopback.
//
// Every write is paid for in credits, from a folder's balance here: forest's host asks this host's
// policies (`policy`, `messagePolicy`, `blobPolicy`), and each takes the write's price from the
// balance, or refuses it. Forest's host asks nothing about a hosts or permissions record, so those
// are free. Reads are free.
//
// Where it keeps things is forest's storage: a data directory (DATA_DIR) with a SQLite file per
// folder, and the blobs on disk there, or in an S3-compatible bucket when the S3_ variables are set.
// Before it starts, two moves, each done once: the single SQLite file this host kept before
// (IMPORT_FROM) goes into the data directory with forest's import script, and, with a bucket, bytes
// left on disk go to the bucket.
//
// An inbox can take messages only from keys holding a registry row from one issuer, named by its key
// as a row holds it (128 hex). Forest's host asks `rowLookup` whether a sender holds one; this host
// answers from the registry, over the RPC in SOLANA_RPC_URL, with forest's registry client. Without
// an RPC there is no lookup, and forest's host refuses messages to such inboxes (`rule_unsupported`).
//
// A message a message key signed is taken only if the sender's own host lists that key: forest's
// host asks `readSender` for the sender's records, and this host reads them with forest's client,
// within SENDER_READ_MS, and keeps what it read for SENDER_CACHE_SECONDS. It reads them only from a
// public address, and follows no redirect (forest's `publicFetch`, records/src/public.ts).
//
import { existsSync, renameSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Connection, PublicKey } from '@solana/web3.js'

import { readPage } from '../../standard/records/src/client.ts'
import { publicFetch } from '../../standard/records/src/public.ts'
import { type BlobDriver, type BlobPolicy, Host, type HostOptions, defaultBlobPolicy } from '../../standard/records/src/host.ts'
import { encodeMessage } from '../../standard/records/src/message.ts'
import { type Checked, encodeRecord } from '../../standard/records/src/record.ts'
import { type BlobStore, blobStore } from '../../standard/records/src/storage.ts'
import { type Rpc, keyFrom } from '../../standard/credits/src/service.ts'
import { importSingleFile } from '../../standard/records/scripts/import-single-file.ts'
import { fromBytes32 } from '../../standard/registry/client/src/field.ts'
import { fetchRows } from '../../standard/registry/client/src/rows.ts'

import { type Answer, BALANCE_PATH, BUY_PATH, Credits, DIRECTORY_PATH, SPEND_PATH, priceOf } from './credits.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host, run by the Forest Foundation on devnet: forest/records’ reference host with the policy in ' +
  'foundationforest/services, host/README.md. Anyone may write here, paying in credits, and on devnet it may be wiped at any time.\n'

/** This host's policy: each number forest's host takes as an option. */
export const POLICY = {
  /** Days a replaced record, a message, or bytes no current record names are kept. */
  keepDays: 30,
  /** Records or messages one request may carry. */
  maxBatch: 100,
  /** Records or messages one page holds at most. */
  maxPageRecords: 1000,
  /** Bytes one page holds at most, though always one line. */
  maxPageBytes: 4 * 1024 * 1024,
  /** The largest blob it takes. Its types are forest's default: png, jpeg and mp4. */
  maxBlobBytes: 50_000_000,
} as const satisfies HostOptions

/** Milliseconds a sender's host may take to serve all of the sender's records. */
export const SENDER_READ_MS = 5_000

/** The devnet registry (standard/registry/devnet/devnet.json), as the index reads it. */
export const DEVNET_REGISTRY = 'J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4'

export type Config = {
  /** The data directory; a temporary one, removed on close, when null. */
  dir: string | null
  /** The single SQLite file this host kept before, moved into `dir` on the start that finds no host there. */
  importFrom: string | null
  /** Where blob bytes go: disk in `dir`, or a bucket. */
  blobs: BlobDriver
  port: number
  /** The Solana RPC for the registry lookup; no lookup when null. */
  rpcUrl: string | null
  registryProgramId: string
  /** Milliseconds what a sender's host served is kept; 0 reads it again for every request. */
  senderCacheMs: number
  /** Its public origin, `https://host`: the name its credits carry. */
  origin: string
  /** Its credit key, RSA-2048 in PKCS #8, from CREDIT_KEY. */
  creditKey: Uint8Array
  /** Where a credit is paid, in what, and one credit's price in whole units. */
  credit: { address: string; mint: string; price: string }
  /** The most credits one buy may ask for. */
  maxBuy: number
}

/** The bucket's variables; the first four are needed once any of them is set. */
const S3_NEEDED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
const S3_OPTIONAL = ['S3_REGION', 'S3_STYLE']

function blobDriver(env: Record<string, string | undefined>): BlobDriver {
  if (![...S3_NEEDED, ...S3_OPTIONAL].some((name) => env[name])) return { kind: 'disk' }
  const missing = S3_NEEDED.filter((name) => !env[name])
  if (missing.length) throw new Error(`a bucket needs ${S3_NEEDED.join(', ')}; missing: ${missing.join(', ')}`)
  new URL(env.S3_ENDPOINT!)
  const style = env.S3_STYLE || undefined
  if (style !== undefined && style !== 'path' && style !== 'virtual') throw new Error('S3_STYLE is path or virtual')
  return {
    kind: 's3',
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    // Forest signs with whatever region it is given, `auto` included; us-east-1 when none.
    ...(env.S3_REGION && { region: env.S3_REGION }),
    ...(style && { style }),
  }
}

function whole(name: string, value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`)
  return n
}

/** The credit variables, every one needed: without them the host could take no write. */
const CREDIT_NEEDED = ['PUBLIC_ORIGIN', 'CREDIT_KEY', 'CREDIT_ADDRESS', 'CREDIT_MINT', 'CREDIT_PRICE']

/** Reads the variables README.md lists. CREDIT_KEY leaves the environment once read. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const registryProgramId = env.REGISTRY_PROGRAM_ID || DEVNET_REGISTRY
  new PublicKey(registryProgramId)
  const missing = CREDIT_NEEDED.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const origin = env.PUBLIC_ORIGIN!.trim()
  if (new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN is an origin: https://host')
  const price = env.CREDIT_PRICE!.trim()
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(price) || !/[1-9]/.test(price)) throw new Error('CREDIT_PRICE is decimal text above 0')
  const mint = env.CREDIT_MINT!.trim()
  const creditKey = new Uint8Array(Buffer.from(env.CREDIT_KEY!.trim(), 'base64'))
  delete env.CREDIT_KEY
  const maxBuy = whole('CREDITS_PER_BUY', env.CREDITS_PER_BUY || '1000')
  if (maxBuy < 1) throw new Error('CREDITS_PER_BUY must be a whole number of at least 1')
  return {
    dir: env.DATA_DIR || null,
    importFrom: env.IMPORT_FROM || null,
    blobs: blobDriver(env),
    port: whole('PORT', env.PORT || '8080'),
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId,
    senderCacheMs: whole('SENDER_CACHE_SECONDS', env.SENDER_CACHE_SECONDS || '60') * 1000,
    origin,
    creditKey,
    credit: { address: new PublicKey(env.CREDIT_ADDRESS!.trim()).toBase58(), mint: mint === 'SOL' ? 'SOL' : new PublicKey(mint).toBase58(), price },
    maxBuy,
  }
}

/** A JSON-RPC call through `url`, for the payment check. Its errors never carry the URL, which may carry the RPC's key. */
function rpcAt(url: string | null): Rpc {
  return async (method, params) => {
    if (!url) throw new Error('no RPC')
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
 * Whether `from` holds a registry row from `issuer`, under any label. `issuer` is the issuer's key as
 * a row holds it, 128 hex characters, x then y. A row names its issuer only after the program checked
 * the person proof against that key, so any such row counts.
 */
export function rowLookup(connection: Pick<Connection, 'getProgramAccounts'>, programId: string): NonNullable<HostOptions['rowLookup']> {
  const program = new PublicKey(programId)
  return async (from, issuer) => {
    if (!/^[0-9a-f]{128}$/.test(issuer)) return false
    const key = Buffer.from(issuer, 'hex')
    // The registry client has its own copy of web3.js, whose key check is `instanceof` its own
    // PublicKey, so the profile goes in as its bytes.
    const rows = await fetchRows(connection as never, {
      profile: new PublicKey(from).toBytes() as never,
      issuer: [fromBytes32(key.subarray(0, 32)), fromBytes32(key.subarray(32))],
      programId: program as never,
    })
    return rows.length > 0
  }
}

/**
 * Bytes, paid for: forest's own types (png, jpeg and mp4), then their price, from the balance of the
 * first folder whose current records name them that holds it.
 */
export function paidBlobs(credits: Credits): BlobPolicy {
  return async (blob) => {
    const refused = await defaultBlobPolicy(blob)
    if (refused) return refused
    const price = priceOf(blob.size)
    let why: string | null = null
    for (const folder of blob.folders) {
      why = credits.charge(folder, price)
      if (!why) return null
    }
    return blob.folders.length === 1 ? why : `these bytes cost ${price} credits, and no folder whose records name them holds that many here`
  }
}

/**
 * A profile's records, every page, as `host` serves them, each checked by forest's reader; all within
 * SENDER_READ_MS. Through `get`, `publicFetch` but for tests, and never after a redirect.
 */
async function readRecords(host: string, profile: string, get: typeof fetch): Promise<Checked[]> {
  const deadline = Date.now() + SENDER_READ_MS
  const records: Checked[] = []
  for (let after = 0; ; ) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`${host} took more than ${SENDER_READ_MS} ms`)
    const page = await readPage(host, { profile, after, timeout: left, fetch: get, redirect: 'error' })
    records.push(...page.records)
    if (page.cursor <= after) return records
    after = page.cursor
  }
}

/**
 * Forest's `readSender`: a sender's records from the host a message names, kept for `cacheMs` per
 * sender and host. Two messages at once share one read; a read that fails is not kept, so forest's
 * host answers `lookup` and the sender's next try reads again. So a message key its owner made past
 * is still taken until what was read before expires. A host at no public address, or one that
 * redirects, is a read that fails.
 */
export function senderReader(cacheMs: number, now: () => number = Date.now, get: typeof fetch = publicFetch): NonNullable<HostOptions['readSender']> {
  const kept = new Map<string, { at: number; records: Promise<Checked[]> }>()
  return (host, profile) => {
    const t = now()
    const key = `${profile} ${host}`
    const held = kept.get(key)
    if (held && t - held.at < cacheMs) return held.records
    for (const [k, v] of kept) if (t - v.at >= cacheMs) kept.delete(k)
    const records = readRecords(host, profile, get)
    if (cacheMs > 0) {
      kept.set(key, { at: t, records })
      records.catch(() => {
        if (kept.get(key)?.records === records) kept.delete(key)
      })
    }
    return records
  }
}

/** Every blob in `from`, into `to` under the same name and type, then out of `from`. Returns how many. */
export async function moveBlobs(from: BlobStore, to: BlobStore): Promise<number> {
  let moved = 0
  for await (const { sha256 } of from.list()) {
    const blob = await from.get(sha256)
    if (!blob) continue
    await to.put(sha256, blob.type, blob.bytes)
    await from.delete(sha256)
    moved++
  }
  return moved
}

export type Imported = Awaited<ReturnType<typeof importSingleFile>>

/**
 * Forest's import of the single file this host kept before, when there is one and `dir` holds no
 * host yet. It runs into a directory beside `dir`, renamed onto it only when whole, so a start that
 * stops halfway leaves nothing half-made. A `dir` that holds folders but no host.sqlite is never
 * replaced: the rename fails, and so does the start.
 */
async function importOnce(config: Config): Promise<Imported | null> {
  const dir = config.dir!
  if (!config.importFrom || !existsSync(config.importFrom) || existsSync(join(dir, 'host.sqlite'))) return null
  const part = `${dir}.import`
  rmSync(part, { recursive: true, force: true })
  const counts = await importSingleFile(config.importFrom, { dir: part, blobs: config.blobs })
  renameSync(part, dir)
  return counts
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
  /** What the start moved: the old file's import, and, with a bucket, the blobs that were on disk. Null when there was nothing to move. */
  moved: { imported: Imported | null; toBucket: number | null }
  close(): Promise<void>
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

/** The credit routes (credits.ts); false for any other path, which goes to forest's host. */
function creditRoute(credits: Credits, path: string, req: IncomingMessage, res: ServerResponse): boolean {
  const routes = [DIRECTORY_PATH, BUY_PATH, SPEND_PATH]
  if (!routes.includes(path) && !path.startsWith(BALANCE_PATH)) return false
  if (req.method === 'OPTIONS') {
    req.resume()
    res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' }).end()
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
      if (path === BUY_PATH) return send(res, await credits.collect(bytes))
      let body: unknown
      try {
        body = JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        body = undefined
      }
      send(res, await credits.spend(req.headers.authorization, body))
    })
    .catch(() => {
      if (!res.headersSent) res.writeHead(500, CORS)
      res.end()
    })
  return true
}

/**
 * In tests, `connection` stands in for the RPC the registry lookup reads and `rpc` for the one the
 * payment check asks, otherwise both made from `config.rpcUrl`; `fetch` stands in for `publicFetch`,
 * so a sender's host on loopback can be read.
 */
export async function startHost(config: Config, stand: { connection?: Pick<Connection, 'getProgramAccounts'>; fetch?: typeof fetch; rpc?: Rpc } = {}): Promise<RunningHost> {
  let creditKey
  try {
    creditKey = await keyFrom(config.creditKey)
  } catch {
    // The setting is a private key: nothing of it goes in the message.
    throw new Error('CREDIT_KEY is not an RSA-2048 private key in PKCS #8, base64')
  }
  const imported = config.dir ? await importOnce(config) : null
  const disk = config.dir && join(config.dir, 'blobs')
  const toBucket = disk && config.blobs.kind === 's3' && existsSync(disk) ? await moveBlobs(blobStore(config.dir!, { kind: 'disk' }), blobStore(config.dir!, config.blobs)) : null

  const rpc = stand.connection ?? (config.rpcUrl ? new Connection(config.rpcUrl, 'confirmed') : null)
  const lookup = rpc && rowLookup(rpc, config.registryProgramId)
  const credits = new Credits(config.dir && join(config.dir, 'credits'), { origin: config.origin, creditKey, credit: config.credit, maxBuy: config.maxBuy }, stand.rpc ?? rpcAt(config.rpcUrl))
  // Each write's price is taken before forest's host keeps it. Two copies of one record or message
  // in flight at once may both pay, though forest's host keeps one.
  const host: Host = new Host({
    ...(config.dir && { dir: config.dir }),
    blobs: config.blobs,
    ...POLICY,
    policy: (record) => credits.charge(record.profile, priceOf(Buffer.byteLength(encodeRecord(record)))),
    messagePolicy: (message) => credits.charge(message.from, priceOf(Buffer.byteLength(encodeMessage(message)))),
    blobPolicy: paidBlobs(credits),
    ...(lookup && { rowLookup: lookup }),
    readSender: senderReader(config.senderCacheMs, Date.now, stand.fetch),
  })
  const inner = new URL(await host.listen(0))

  const server = createServer((req, res) => {
    // A URL no URL parser reads (`//`, `/\`) is refused here: thrown in this handler, it would stop
    // the process.
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://host.invalid').pathname
    } catch {
      req.resume()
      return void res.writeHead(400, { 'access-control-allow-origin': '*' }).end()
    }
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      return void res.end(req.method === 'HEAD' ? undefined : LABEL)
    }
    if (creditRoute(credits, path, req, res)) return
    let upstream
    try {
      upstream = request({ host: inner.hostname, port: inner.port, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
        answer.pipe(res)
      })
    } catch {
      // A request node:http will not send on, as it is.
      req.resume()
      return void res.writeHead(400, { 'access-control-allow-origin': '*' }).end()
    }
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
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
    moved: { imported, toBucket },
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
