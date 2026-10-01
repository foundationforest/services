// A board for devnet testing only: forest/records' reference host (forest/records/src/host.ts),
// unchanged, run so the loop (../loop.ts) and the devnet index have somewhere to read and write
// records. The foundation runs no board; boards are run by apps. This one takes anyone's entries,
// sets no policy of its own, and may be wiped at any time.
//
// Around forest's host, three things only:
//   - the public registry, for the badged feed: a key holds a badge when a registry line names it
//     (getProgramAccounts on the registry, filtered on a line's profile);
//   - forgetting what stopped counting, and asking the registry again, once an hour;
//   - a front that answers `GET /` with one line saying what this is, and passes every other
//     request, untouched, to the host on loopback (forest's host answers only /v1/entries).

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { base58 } from '../../../forest/records/src/bytes.ts'
import { normalizeOrigin } from '../../../forest/records/src/entry.ts'
import { Host } from '../../../forest/records/src/host.ts'
import { publicKeyFromDid } from '../../../forest/records/src/keys.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest board for devnet testing only: forest/records’ reference host, run for the loop in ' +
  'foundationforest/services. The foundation runs no board. Anyone may write here, and it may be wiped at any time.\n'

/** The registry's line accounts begin with this: Anchor's discriminator for `Line`, as forest's registry client has it (`LINE_DISCRIMINATOR`). */
export const LINE_DISCRIMINATOR = createHash('sha256').update('account:Line').digest().subarray(0, 8)

export type Config = {
  /** This board's origin, exactly as folders name it. */
  url: string
  /** The SQLite file; in memory when null. */
  file: string | null
  /** A Solana RPC and the registry's program id, for the badged feed; without both, no key is badged. */
  rpcUrl: string | null
  registryProgramId: string | null
  port: number
}

/** Reads PUBLIC_URL, DATABASE_PATH, SOLANA_RPC_URL, REGISTRY_PROGRAM_ID and PORT. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const url = normalizeOrigin(env.PUBLIC_URL ?? '')
  if (!url) throw new Error('PUBLIC_URL must be this board’s https origin, as folders name it')
  const port = Number(env.PORT || 8080)
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  return {
    url,
    file: env.DATABASE_PATH || null,
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId: env.REGISTRY_PROGRAM_ID || null,
    port,
  }
}

/**
 * Does any registry line name this profile's key? One `getProgramAccounts`, filtered on the line
 * discriminator and the profile at offset 8, as forest's `fetchLines` filters, with no data sent
 * back. An RPC that fails counts as no: a badged feed is a hint, and readers check lines themselves.
 */
export async function hasLine(rpcUrl: string, programId: string, did: string, get: typeof fetch = fetch): Promise<boolean> {
  const key = publicKeyFromDid(did)
  if (!key) return false
  try {
    const res = await get(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getProgramAccounts',
        params: [
          programId,
          {
            commitment: 'confirmed',
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
            filters: [{ memcmp: { offset: 0, bytes: base58.encode(LINE_DISCRIMINATOR) } }, { memcmp: { offset: 8, bytes: base58.encode(key) } }],
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json()) as { result?: unknown[] }
    return Array.isArray(body.result) && body.result.length > 0
  } catch {
    return false
  }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

export type Board = { url: string; host: Host; server: Server; close(): Promise<void> }

const HOUR = 3_600_000

export async function startBoard(config: Config, options: { fetch?: typeof fetch } = {}): Promise<Board> {
  const { rpcUrl, registryProgramId } = config
  if (config.file) mkdirSync(dirname(config.file), { recursive: true })
  const host = new Host({
    url: config.url,
    file: config.file ?? undefined,
    isBadged: rpcUrl && registryProgramId ? (did) => hasLine(rpcUrl, registryProgramId, did, options.fetch) : undefined,
  })
  const inner = await host.listen(0)

  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://board.invalid').pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      return void res.end(req.method === 'HEAD' ? undefined : LABEL)
    }
    const upstream = request({ host: '127.0.0.1', port: inner, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
      answer.pipe(res)
    })
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

  const hourly = setInterval(() => {
    host.prune()
    void host.refreshBadges().catch(() => {})
  }, HOUR)

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host,
    server,
    async close() {
      clearInterval(hourly)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await host.close()
    },
  }
}
