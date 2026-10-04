// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { base58 } from '../../forest/records/src/bytes.ts'
import { Batcher } from './batch.ts'
import { DiditClient, type FaceCheck } from './didit.ts'
import { loadKeypair, writeKeyFile, type IssuerKey } from './key.ts'
import { RateLimit } from './limit.ts'
import { IssuerList } from './list.ts'
import { RpcPayments, type Payments } from './payment.ts'
import { handler, type PaymentDeps } from './server.ts'
import { Store } from './store.ts'

export type Config = {
  diditApiKey: string
  diditWorkflowId: string
  /** The ID check's workflow: document, liveness and face match. */
  diditIdWorkflowId: string
  diditBaseUrl: string
  /** The ID check's price in the dollar's smallest unit; 0 is free. */
  idTierPrice: bigint
  /** The dollar it is paid in, by its mint's address. Required when the price is above 0. */
  idTierMint?: string
  /** The address that receives it; never one of the issuer's signing keys. Required when the price is above 0. */
  idTierPayTo?: string
  /** The Solana RPC a payment is looked for through. Required when the price is above 0. */
  rpcUrl?: string
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
  port: number
}

/** A Solana address in its one spelling: 32 bytes in base58. */
function isAddress(text: string): boolean {
  try {
    const bytes = base58.decode(text)
    return bytes.length === 32 && base58.encode(bytes) === text
  } catch {
    return false
  }
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
  const required = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_ID_WORKFLOW_ID']
  const missing = required.filter((name) => !env[name])
  if (!env.ISSUER_KEYPAIR && !env.ISSUER_KEYPAIR_PATH) missing.push('ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH')
  const price = env.ID_TIER_PRICE || '0'
  if (!/^(0|[1-9][0-9]{0,19})$/.test(price)) throw new Error('ID_TIER_PRICE must be a whole number: the price in the dollar’s smallest unit')
  if (BigInt(price) > 0n) missing.push(...['ID_TIER_MINT', 'ID_TIER_PAY_TO', 'RPC_URL'].filter((name) => !env[name]))
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  for (const name of ['ID_TIER_MINT', 'ID_TIER_PAY_TO']) {
    if (env[name] && !isAddress(env[name])) throw new Error(`${name} is not an address`)
  }
  if (env.ISSUER_KEYPAIR && env.ISSUER_KEYPAIR_PATH) {
    throw new Error('set ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH, not both')
  }
  const issuerKeypair = env.ISSUER_KEYPAIR || undefined
  delete env.ISSUER_KEYPAIR
  return {
    diditApiKey: env.DIDIT_API_KEY!,
    diditWorkflowId: env.DIDIT_WORKFLOW_ID!,
    diditIdWorkflowId: env.DIDIT_ID_WORKFLOW_ID!,
    diditBaseUrl: env.DIDIT_BASE_URL || 'https://verification.didit.me',
    idTierPrice: BigInt(price),
    idTierMint: env.ID_TIER_MINT || undefined,
    idTierPayTo: env.ID_TIER_PAY_TO || undefined,
    rpcUrl: env.RPC_URL || undefined,
    issuerKeypairPath: env.ISSUER_KEYPAIR_PATH || undefined,
    issuerKeypair,
    databasePath: env.DATABASE_PATH || './data/issuer.sqlite',
    batchMax: whole('BATCH_MAX', env.BATCH_MAX || '50', 1),
    batchIntervalMs: whole('BATCH_INTERVAL_SECONDS', env.BATCH_INTERVAL_SECONDS || '3600', 1) * 1000,
    sessionLimitPerHour: whole('SESSION_LIMIT_PER_HOUR', env.SESSION_LIMIT_PER_HOUR || '5', 1),
    clientAddressHeader: env.CLIENT_ADDRESS_HEADER?.toLowerCase() || undefined,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

/** One list's parts: its tables, the list, and its batch. */
export type ListParts = { store: Store; list: IssuerList; batcher: Batcher }

export type Issuer = {
  url: string
  server: Server
  /** The face list's parts. */
  store: Store
  list: IssuerList
  batcher: Batcher
  /** The ID list's, signed by the key mixed from the issuer's seed under `id`. */
  id: ListParts
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
 * Starts the service. Tests pass their own checks, payments and clock; otherwise it talks to Didit
 * and to the RPC. Each list is the file's own, read at start.
 */
export async function startIssuer(
  config: Config,
  overrides: {
    faceCheck?: FaceCheck
    idCheck?: FaceCheck
    payments?: Payments
    log?: (line: string) => void
    now?: () => number
  } = {},
): Promise<Issuer> {
  const key = issuerKey(config)
  const idKey = await key.keypair.derive('id')
  if (config.idTierPayTo === key.keypair.address || config.idTierPayTo === idKey.address) {
    throw new Error("ID_TIER_PAY_TO is one of the issuer's signing keys; payments go to an address of their own")
  }
  const didit = { apiKey: config.diditApiKey, baseUrl: config.diditBaseUrl }
  const faceCheck = overrides.faceCheck ?? new DiditClient({ ...didit, workflowId: config.diditWorkflowId, tier: 'face' })
  const idCheck = overrides.idCheck ?? new DiditClient({ ...didit, workflowId: config.diditIdWorkflowId, tier: 'id' })

  mkdirSync(dirname(config.databasePath), { recursive: true })
  const batch = { max: config.batchMax, intervalMs: config.batchIntervalMs, log: overrides.log, now: overrides.now }
  const store = new Store(config.databasePath)
  const list = new IssuerList(store, key.keypair)
  const batcher = new Batcher(store, list, batch)
  const idStore = new Store(config.databasePath, 'id')
  const idList = new IssuerList(idStore, idKey)
  const idBatcher = new Batcher(idStore, idList, { ...batch, name: 'ID list' })

  let payment: PaymentDeps | undefined
  if (config.idTierPrice > 0n) {
    const price = { amount: config.idTierPrice, mint: config.idTierMint!, payTo: config.idTierPayTo! }
    payment = {
      price,
      payments: overrides.payments ?? new RpcPayments({ rpcUrl: config.rpcUrl!, price }),
      reference: async (paymentId) => (await key.keypair.derive(`reference/${paymentId}`)).address,
    }
  }

  const limit = new RateLimit({ max: config.sessionLimitPerHour, windowMs: 3_600_000 })
  const server = createServer(
    handler({
      face: { tier: 'face', store, check: faceCheck, list, batcher, workflowId: config.diditWorkflowId },
      id: { tier: 'id', store: idStore, check: idCheck, list: idList, batcher: idBatcher, workflowId: config.diditIdWorkflowId },
      payment,
      limit,
      clientAddressHeader: config.clientAddressHeader,
      log: overrides.log,
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })
  batcher.start()
  idBatcher.start()

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    store,
    list,
    batcher,
    id: { store: idStore, list: idList, batcher: idBatcher },
    keyFile: key.keyFile,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await Promise.all([batcher.close(), idBatcher.close()])
      store.close()
      idStore.close()
    },
  }
}
