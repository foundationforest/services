// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { Connection, PublicKey, type Keypair } from '@solana/web3.js'

import { PROGRAM_ID } from '../../registry/client/src/program.ts'
import { Batcher } from './batch.ts'
import { DiditClient, type FaceCheck } from './didit.ts'
import { RateLimit } from './limit.ts'
import { ChainList, loadKeypair, writeKeyFile, type IssuerList } from './list.ts'
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
  rpcUrl: string
  programId: PublicKey
  listIndex: number
  databasePath: string
  batchMax: number
  batchIntervalMs: number
  /** How many sessions one address may open in an hour. */
  sessionLimitPerHour: number
  /** The header a proxy in front puts the client's address in (`x-real-ip` on Railway); unset, the connection's. */
  clientAddressHeader?: string
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
  const required = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'SOLANA_RPC_URL']
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
    rpcUrl: env.SOLANA_RPC_URL!,
    programId: env.REGISTRY_PROGRAM_ID ? new PublicKey(env.REGISTRY_PROGRAM_ID) : PROGRAM_ID,
    listIndex: whole('LIST_INDEX', env.LIST_INDEX || '0', 0),
    databasePath: env.DATABASE_PATH || './data/issuer.sqlite',
    batchMax: whole('BATCH_MAX', env.BATCH_MAX || '50', 1),
    batchIntervalMs: whole('BATCH_INTERVAL_SECONDS', env.BATCH_INTERVAL_SECONDS || '3600', 1) * 1000,
    sessionLimitPerHour: whole('SESSION_LIMIT_PER_HOUR', env.SESSION_LIMIT_PER_HOUR || '5', 1),
    clientAddressHeader: env.CLIENT_ADDRESS_HEADER?.toLowerCase() || undefined,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

export type Issuer = {
  url: string
  server: Server
  store: Store
  batcher: Batcher
  /** Where the key from `ISSUER_KEYPAIR` was written; the file is gone by the time this returns. */
  keyFile?: string
  /** Stops taking requests, lets a running batch finish, and closes the file. */
  close(): Promise<void>
}

/**
 * The issuer's key: from its file, or, when it came in a sealed variable, written to a private file
 * in a temporary directory, loaded, and the file deleted at once. Nothing reads it again.
 */
function issuerKey(config: Config): { keypair: Keypair; keyFile?: string } {
  if (!config.issuerKeypair) return { keypair: loadKeypair(config.issuerKeypairPath!) }
  const file = writeKeyFile(config.issuerKeypair)
  try {
    return { keypair: loadKeypair(file.path), keyFile: file.path }
  } finally {
    file.remove()
  }
}

/**
 * Starts the service. Tests pass their own face check or list; otherwise it talks to Didit and to the
 * chain, and refuses to start unless the key is an insert key of the list.
 */
export async function startIssuer(
  config: Config,
  overrides: { faceCheck?: FaceCheck; list?: IssuerList; log?: (line: string) => void } = {},
): Promise<Issuer> {
  const key = overrides.list ? undefined : issuerKey(config)
  const list =
    overrides.list ??
    (await ChainList.open({
      connection: new Connection(config.rpcUrl, 'confirmed'),
      issuer: key!.keypair,
      listIndex: config.listIndex,
      programId: config.programId,
    }))
  const faceCheck =
    overrides.faceCheck ??
    new DiditClient({
      apiKey: config.diditApiKey,
      workflowId: config.diditWorkflowId,
      baseUrl: config.diditBaseUrl,
    })

  mkdirSync(dirname(config.databasePath), { recursive: true })
  const store = new Store(config.databasePath)
  const batcher = new Batcher(store, list, {
    max: config.batchMax,
    intervalMs: config.batchIntervalMs,
    log: overrides.log,
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

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    store,
    batcher,
    keyFile: key?.keyFile,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await batcher.close()
      store.close()
    },
  }
}
