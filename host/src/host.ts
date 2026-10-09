// The foundation's host: standard/records' reference host (standard/records/src/host.ts), unchanged, run
// with this service's policy. It takes anyone's records, delivers messages to inboxes, and keeps
// blobs, as forest's host does; every number it uses is in POLICY below, and README.md says each in
// words.
//
// Around forest's host, one thing only: a front that answers `GET /` with one line saying what this
// is, and passes every other request, untouched, to the host on loopback.
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
// Photos and videos (forest's blobs) are taken only for a folder holding a row from an issuer this
// host counts, and only while that folder's photos and videos here stay within PHOTOS.folderBytes
// (`photoRule`). The lookup is the registry lookup's: without an RPC, no photo is taken.

import { existsSync, renameSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Connection, PublicKey } from '@solana/web3.js'

import { readPage } from '../../standard/records/src/client.ts'
import { publicFetch } from '../../standard/records/src/public.ts'
import { type BlobDriver, type BlobPolicy, Host, type HostOptions, defaultBlobPolicy } from '../../standard/records/src/host.ts'
import type { Checked } from '../../standard/records/src/record.ts'
import { type BlobStore, blobNames, blobStore } from '../../standard/records/src/storage.ts'
import { importSingleFile } from '../../standard/records/scripts/import-single-file.ts'
import { fromBytes32 } from '../../standard/registry/client/src/field.ts'
import { fetchRows } from '../../standard/registry/client/src/rows.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host, run by the Forest Foundation on devnet: forest/records’ reference host with the policy in ' +
  'foundationforest/services, host/README.md. Anyone may write here, and on devnet it may be wiped at any time.\n'

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

/** The photo rule: whose photos and videos this host takes, and how many bytes of them one folder may hold. */
export const PHOTOS = {
  /** The issuers whose registry rows let a folder put photos and videos here, by key as a row holds it: the foundation's devnet issuer. */
  issuers: ['2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549'],
  /** The most bytes of photos and videos a folder's current records may name here, the ones being put included. */
  folderBytes: 250_000_000,
} as const

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

/** Reads the variables README.md lists. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const registryProgramId = env.REGISTRY_PROGRAM_ID || DEVNET_REGISTRY
  new PublicKey(registryProgramId)
  return {
    dir: env.DATA_DIR || null,
    importFrom: env.IMPORT_FROM || null,
    blobs: blobDriver(env),
    port: whole('PORT', env.PORT || '8080'),
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId,
    senderCacheMs: whole('SENDER_CACHE_SECONDS', env.SENDER_CACHE_SECONDS || '60') * 1000,
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
 * The photo rule, a policy for forest's host on top of forest's own types (png, jpeg and mp4) and its
 * size cap: bytes are taken when one of the folders whose current records name them holds a row
 * from an issuer in PHOTOS (`counted`), and the bytes this host holds that the folder's current
 * records name, these included, come to at most `limit`. A size is the bytes' own, never what a
 * record says of them, which can be anything: learned when this policy takes them, or read back
 * once for bytes taken before this start. Bytes enter only through this policy while it runs, so
 * bytes it finds missing stay missing until it takes them.
 */
export function photoRule(host: () => Host, counted: (folder: string) => Promise<boolean>, limit: number = PHOTOS.folderBytes): BlobPolicy {
  const sizes = new Map<string, number>()
  const size = async (sha256: string) => {
    let n = sizes.get(sha256)
    if (n === undefined) {
      n = (await host().getBlob(sha256))?.bytes.length ?? 0
      sizes.set(sha256, n)
    }
    return n
  }
  return async (blob) => {
    const refused = await defaultBlobPolicy(blob)
    if (refused) return refused
    let full = false
    for (const folder of blob.folders) {
      if (!(await counted(folder))) continue
      const named = new Set([...host().view(folder).current.values()].flatMap((c) => blobNames(c.record.body).map((n) => n.sha256)))
      named.delete(blob.sha256)
      let total = blob.size
      for (const sha256 of named) total += await size(sha256)
      if (total <= limit) {
        sizes.set(blob.sha256, blob.size)
        return null
      }
      full = true
    }
    return full
      ? `a folder's photos and videos here come to at most ${limit} bytes`
      : 'this host takes photos and videos only for a folder holding a registry row from an issuer it counts'
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
  server: Server
  /** What the start moved: the old file's import, and, with a bucket, the blobs that were on disk. Null when there was nothing to move. */
  moved: { imported: Imported | null; toBucket: number | null }
  close(): Promise<void>
}

/**
 * In tests, `connection` stands in for the RPC, otherwise made from `config.rpcUrl`, and `fetch` for
 * `publicFetch`, so a sender's host on loopback can be read.
 */
export async function startHost(config: Config, stand: { connection?: Pick<Connection, 'getProgramAccounts'>; fetch?: typeof fetch } = {}): Promise<RunningHost> {
  const imported = config.dir ? await importOnce(config) : null
  const disk = config.dir && join(config.dir, 'blobs')
  const toBucket = disk && config.blobs.kind === 's3' && existsSync(disk) ? await moveBlobs(blobStore(config.dir!, { kind: 'disk' }), blobStore(config.dir!, config.blobs)) : null

  const rpc = stand.connection ?? (config.rpcUrl ? new Connection(config.rpcUrl, 'confirmed') : null)
  const lookup = rpc && rowLookup(rpc, config.registryProgramId)
  const counted = async (folder: string) => {
    for (const issuer of PHOTOS.issuers) if (lookup && (await lookup(folder, issuer))) return true
    return false
  }
  const host: Host = new Host({
    ...(config.dir && { dir: config.dir }),
    blobs: config.blobs,
    ...POLICY,
    blobPolicy: photoRule(() => host, counted),
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
    server,
    moved: { imported, toBucket },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await host.close()
    },
  }
}
