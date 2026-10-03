// Soil's host: forest/records' reference host (forest/records/src/host.ts), unchanged, run with this
// service's policy. It takes anyone's records, delivers messages to inboxes, and keeps blobs, as
// forest's host does; every number it uses is in POLICY below, and README.md says each in words.
//
// Around forest's host, one thing only: a front that answers `GET /` with one line saying what this
// is, and passes every other request, untouched, to the host on loopback.
//
// An inbox can take messages only from keys holding a registry row from one issuer. Forest's host
// asks `rowLookup` whether a sender holds one; this host answers from the registry, over the RPC in
// SOLANA_RPC_URL, with forest's registry client. Without an RPC there is no lookup, and forest's
// host refuses messages to such inboxes (`rule_unsupported`).

import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { Connection, PublicKey } from '@solana/web3.js'

import { Host, type HostOptions } from '../../forest/records/src/host.ts'
import { issuerSigned } from '../../forest/registry/client/src/issuer.ts'
import { fetchRows } from '../../forest/registry/client/src/rows.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host, run by Soil on devnet: forest/records’ reference host with the policy in ' +
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

/** The devnet registry (forest/registry/devnet/devnet.json), as the index reads it. */
export const DEVNET_REGISTRY = '5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC'

export type Config = {
  /** The SQLite file; in memory when null. */
  file: string | null
  port: number
  /** The Solana RPC for the registry lookup; no lookup when null. */
  rpcUrl: string | null
  registryProgramId: string
}

/** Reads DATABASE_PATH, PORT, SOLANA_RPC_URL and REGISTRY_PROGRAM_ID. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT || 8080)
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  const registryProgramId = env.REGISTRY_PROGRAM_ID || DEVNET_REGISTRY
  new PublicKey(registryProgramId)
  return { file: env.DATABASE_PATH || null, port, rpcUrl: env.SOLANA_RPC_URL || null, registryProgramId }
}

/**
 * Whether `from` holds a registry row from `issuer`, under any label. A row counts only if the
 * issuer's signature on its root checks: the program stores that signature and never checks it,
 * so a row naming an issuer is not by itself a row from that issuer.
 */
export function rowLookup(connection: Pick<Connection, 'getProgramAccounts'>, programId: string): NonNullable<HostOptions['rowLookup']> {
  const program = new PublicKey(programId)
  return async (from, issuer) => {
    // The registry client has its own copy of web3.js, whose key check is `instanceof` its own
    // PublicKey, so the two keys go in as their bytes.
    const rows = await fetchRows(connection as never, {
      profile: new PublicKey(from).toBytes() as never,
      issuer: new PublicKey(issuer).toBytes() as never,
      programId: program as never,
    })
    return rows.some(({ row }) => issuerSigned(row))
  }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

export type RunningHost = { url: string; host: Host; server: Server; close(): Promise<void> }

/** `connection` stands in for the RPC in tests; otherwise one is made from `config.rpcUrl`. */
export async function startHost(config: Config, connection?: Pick<Connection, 'getProgramAccounts'>): Promise<RunningHost> {
  if (config.file) mkdirSync(dirname(config.file), { recursive: true })
  const rpc = connection ?? (config.rpcUrl ? new Connection(config.rpcUrl, 'confirmed') : null)
  const host = new Host({ file: config.file ?? undefined, ...POLICY, ...(rpc && { rowLookup: rowLookup(rpc, config.registryProgramId) }) })
  const inner = new URL(await host.listen(0))

  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://host.invalid').pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      return void res.end(req.method === 'HEAD' ? undefined : LABEL)
    }
    const upstream = request({ host: inner.hostname, port: inner.port, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
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

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await host.close()
    },
  }
}
