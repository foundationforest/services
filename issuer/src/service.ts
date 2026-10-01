// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { Batcher } from './batch.ts'
import { RootWriter } from './chain.ts'
import { DiditClient, type FaceCheck } from './didit.ts'
import { loadKeypair, writeKeyFile, type IssuerKey } from './key.ts'
import { RateLimit } from './limit.ts'
import { IssuerList } from './list.ts'
import { handler } from './server.ts'
import { Store } from './store.ts'

export type Config = {
  diditApiKey: string
  diditWorkflowId: string
  diditBaseUrl: string
  /** The key as a file, for local runs. */
  issuerKeypairPath?: string
  /** Or its contents, from a sealed variable, as on Railway. Exactly one of the two is set. */
  issuerKeypair?: string
  databasePath: string
  batchMax: number
  batchIntervalMs: number
  /** How many sessions one address may open in an hour. */
  sessionLimitPerHour: number
  /** The header a proxy in front puts the client's address in (`x-real-ip` on Railway); unset, the connection's. */
  clientAddressHeader?: string
  /** A Solana RPC: each new root is also written on chain there (chain.ts). Unset, nothing goes on chain. */
  solanaRpcUrl?: string
  port: number
}

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/**
 * Reads the variables `README.md` lists. Fails naming every required one that is missing. The key's
 * contents (`ISSUER_KEYPAIR`) are taken out of `env` once read, so nothing that reads the
 * environment later finds them.
 */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID']
  const missing = required.filter((name) => !env[name])
  if (!env.ISSUER_KEYPAIR && !env.ISSUER_KEYPAIR_PATH) missing.push('ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH')
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  if (env.ISSUER_KEYPAIR && env.ISSUER_KEYPAIR_PATH) {
    throw new Error('set ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH, not both')
  }
  const issuerKeypair = env.ISSUER_KEYPAIR || undefined
  delete env.ISSUER_KEYPAIR
  return {
    diditApiKey: env.DIDIT_API_KEY!,
    diditWorkflowId: env.DIDIT_WORKFLOW_ID!,
    diditBaseUrl: env.DIDIT_BASE_URL || 'https://verification.didit.me',
    issuerKeypairPath: env.ISSUER_KEYPAIR_PATH || undefined,
    issuerKeypair,
    databasePath: env.DATABASE_PATH || './data/issuer.sqlite',
    batchMax: whole('BATCH_MAX', env.BATCH_MAX || '50', 1),
    batchIntervalMs: whole('BATCH_INTERVAL_SECONDS', env.BATCH_INTERVAL_SECONDS || '3600', 1) * 1000,
    sessionLimitPerHour: whole('SESSION_LIMIT_PER_HOUR', env.SESSION_LIMIT_PER_HOUR || '5', 1),
    clientAddressHeader: env.CLIENT_ADDRESS_HEADER?.toLowerCase() || undefined,
    solanaRpcUrl: env.SOLANA_RPC_URL || undefined,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

export type Issuer = {
  url: string
  server: Server
  store: Store
  list: IssuerList
  batcher: Batcher
  /** Writes each root on chain; none without SOLANA_RPC_URL. */
  writer?: RootWriter
  /** Where the key from `ISSUER_KEYPAIR` was written; the file is gone by the time this returns. */
  keyFile?: string
  /** Stops taking requests, lets a running batch finish, and closes the file. */
  close(): Promise<void>
}

/**
 * The issuer's key: from its file, or, when it came in a sealed variable, written to a private file
 * in a temporary directory, loaded, and the file deleted at once. Nothing reads it again.
 */
function issuerKey(config: Config): { keypair: IssuerKey; keyFile?: string } {
  if (!config.issuerKeypair) return { keypair: loadKeypair(config.issuerKeypairPath!) }
  const file = writeKeyFile(config.issuerKeypair)
  try {
    return { keypair: loadKeypair(file.path), keyFile: file.path }
  } finally {
    file.remove()
  }
}

/**
 * Starts the service. Tests pass their own face check and clock; otherwise it talks to Didit. The
 * list is the file's own, read at start.
 */
export async function startIssuer(
  config: Config,
  overrides: {
    faceCheck?: FaceCheck
    log?: (line: string) => void
    now?: () => number
    chain?: { retryMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
  } = {},
): Promise<Issuer> {
  const key = issuerKey(config)
  const faceCheck =
    overrides.faceCheck ??
    new DiditClient({
      apiKey: config.diditApiKey,
      workflowId: config.diditWorkflowId,
      baseUrl: config.diditBaseUrl,
    })

  mkdirSync(dirname(config.databasePath), { recursive: true })
  const store = new Store(config.databasePath)
  const list = new IssuerList(store, key.keypair)
  const writer = config.solanaRpcUrl
    ? new RootWriter(store, key.keypair, { rpcUrl: config.solanaRpcUrl, log: overrides.log, ...overrides.chain })
    : undefined
  const batcher = new Batcher(store, list, {
    max: config.batchMax,
    intervalMs: config.batchIntervalMs,
    log: overrides.log,
    now: overrides.now,
    onAppend: () => void writer?.poke(),
  })
  const limit = new RateLimit({ max: config.sessionLimitPerHour, windowMs: 3_600_000 })
  const server = createServer(
    handler({
      store,
      faceCheck,
      list,
      batcher,
      limit,
      clientAddressHeader: config.clientAddressHeader,
      workflowId: config.diditWorkflowId,
      log: overrides.log,
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })
  batcher.start()
  writer?.start()

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    store,
    list,
    batcher,
    writer,
    keyFile: key.keyFile,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await batcher.close()
      await writer?.close()
      store.close()
    },
  }
}
