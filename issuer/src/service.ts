// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { base58 } from '../../standard/records/src/bytes.ts'
import { canonical } from '../../standard/records/src/canonical.ts'
import { type IssuerKey as NoteKey, issuerKeyOf } from '../../standard/registry/client/src/person.ts'
import { DiditClient, type FaceCheck } from './didit.ts'
import { type Embedder, sface, standIn } from './face.ts'
import type { Gift } from './gift.ts'
import { loadOrMakeKey } from './key.ts'
import { RateLimit } from './limit.ts'
import { issuerHex } from './notes.ts'
import { RpcPayments, type Payments } from './payment.ts'
import { handler, type PaymentDeps } from './server.ts'
import { Store } from './store.ts'

/** The hkdf labels the note key and the fingerprint key are mixed under, from the issuer's seed. */
export const NOTE_KEY_INFO = 'issuer/notes'
export const FINGERPRINT_KEY_INFO = 'issuer/fingerprint'
/** The label the key that signs the welcome gift's tickets is mixed under, from the issuer's seed (the standard's `mainKey`). */
export const SPONSOR_KEY_LABEL = 'sponsor'

export type Config = {
  /** The issuer's name: what a person's secret for it is mixed from (the standard's `issuerSecret`). */
  issuerName: string
  diditApiKey: string
  diditWorkflowId: string
  /** The document check's workflow: document, liveness and face match. */
  diditIdWorkflowId: string
  diditBaseUrl: string
  /** `sface`, or `stand-in`: one fixed embedding, only with a stand-in Didit on this machine. */
  faceModel: 'sface' | 'stand-in'
  /** The document check's price in the dollar's smallest unit; 0 is free. */
  idTierPrice: bigint
  /** The dollar it is paid in, by its mint's address. Required when the price is above 0. */
  idTierMint?: string
  /** The address that receives it; never the issuer's own. Required when the price is above 0. */
  idTierPayTo?: string
  /** The Solana RPC a payment is looked for through. Required when the price is above 0. */
  rpcUrl?: string
  /** The welcome gift: for each service, its origin and how many of its credits; empty for none. */
  gift: Gift
  /** The origins an app may ask the person to come back to after a check (`returnUrl`); empty for none. */
  appOrigins: string[]
  /** The one file; the issuer's key file sits beside it (`KEY_FILE`). */
  databasePath: string
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

/** Whether a URL is on this machine: the only place a stand-in Didit may be. */
function onThisMachine(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A setting that names an origin: `https://host`, written as its origin is. */
function origin(name: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is an origin: https://host`)
  }
  if (url.origin !== value) throw new Error(`${name} is an origin: https://host`)
  return value
}

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/**
 * Reads the variables `README.md` lists. Fails naming every required one that is missing. The seed is
 * no variable: it is the key file beside the database (`KEY_FILE`).
 */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ['ISSUER_NAME', 'DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_ID_WORKFLOW_ID']
  const missing = required.filter((name) => !env[name])
  const price = env.ID_TIER_PRICE || '0'
  if (!/^(0|[1-9][0-9]{0,19})$/.test(price)) throw new Error('ID_TIER_PRICE must be a whole number: the price in the dollar’s smallest unit')
  if (BigInt(price) > 0n) missing.push(...['ID_TIER_MINT', 'ID_TIER_PAY_TO', 'RPC_URL'].filter((name) => !env[name]))
  const gift: Gift = {}
  for (const [role, url, count, fallback] of [['registryPayer', 'REGISTRY_PAYER_URL', 'REGISTRY_CREDITS', '10'], ['host', 'HOST_URL', 'HOST_CREDITS', '10']] as const) {
    if (!env[url]) continue
    const at = origin(url, env[url]!)
    const credits = whole(count, env[count] || fallback, 0)
    if (credits > 0) gift[role] = { origin: at, credits }
  }
  const appOrigins = (env.APP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => origin('APP_ORIGINS', o))
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  for (const name of ['ID_TIER_MINT', 'ID_TIER_PAY_TO']) {
    if (env[name] && !isAddress(env[name])) throw new Error(`${name} is not an address`)
  }
  const faceModel = env.FACE_MODEL || 'sface'
  if (faceModel !== 'sface' && faceModel !== 'stand-in') throw new Error('FACE_MODEL is sface or stand-in')
  const diditBaseUrl = env.DIDIT_BASE_URL || 'https://verification.didit.me'
  if (faceModel === 'stand-in' && !onThisMachine(diditBaseUrl)) {
    throw new Error('FACE_MODEL=stand-in is for a stand-in Didit on this machine only: DIDIT_BASE_URL is not on loopback')
  }
  return {
    issuerName: env.ISSUER_NAME!,
    diditApiKey: env.DIDIT_API_KEY!,
    diditWorkflowId: env.DIDIT_WORKFLOW_ID!,
    diditIdWorkflowId: env.DIDIT_ID_WORKFLOW_ID!,
    diditBaseUrl,
    faceModel,
    idTierPrice: BigInt(price),
    idTierMint: env.ID_TIER_MINT || undefined,
    idTierPayTo: env.ID_TIER_PAY_TO || undefined,
    rpcUrl: env.RPC_URL || undefined,
    gift,
    appOrigins,
    databasePath: env.DATABASE_PATH || './data/issuer.sqlite',
    sessionLimitPerHour: whole('SESSION_LIMIT_PER_HOUR', env.SESSION_LIMIT_PER_HOUR || '5', 1),
    clientAddressHeader: env.CLIENT_ADDRESS_HEADER?.toLowerCase() || undefined,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

export type Issuer = {
  url: string
  server: Server
  store: Store
  /** The note key's public half: what a row names, and what readers trust. */
  noteKey: NoteKey
  /** Whether this start made the issuer's key, finding none beside the database. */
  madeKey: boolean
  /** Stops taking requests, and closes the file. */
  close(): Promise<void>
}

/** The issuer's key file's name, in the database's directory. */
export const KEY_FILE = 'issuer-keypair.json'

/**
 * Starts the service. Tests pass their own checks, payments and embedder; otherwise it talks to Didit
 * and to the RPC, and loads the face models (or, with `FACE_MODEL=stand-in`, the stand-in).
 */
export async function startIssuer(
  config: Config,
  overrides: {
    faceCheck?: FaceCheck
    idCheck?: FaceCheck
    payments?: Payments
    embedder?: Embedder
    log?: (line: string) => void
  } = {},
): Promise<Issuer> {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  const { key: seed, made: madeKey } = loadOrMakeKey(join(dirname(config.databasePath), KEY_FILE))
  if (config.idTierPayTo === seed.address) {
    throw new Error("ID_TIER_PAY_TO is the issuer's own key; payments go to an address of their own")
  }
  const notePrivate = await seed.mix(NOTE_KEY_INFO)
  const noteKey = issuerKeyOf(notePrivate)
  const fingerprintKey = await seed.mix(FINGERPRINT_KEY_INFO)
  const didit = { apiKey: config.diditApiKey, baseUrl: config.diditBaseUrl }
  const faceCheck = overrides.faceCheck ?? new DiditClient({ ...didit, workflowId: config.diditWorkflowId, tier: 'face' })
  const idCheck = overrides.idCheck ?? new DiditClient({ ...didit, workflowId: config.diditIdWorkflowId, tier: 'id' })
  const embedder = overrides.embedder ?? (config.faceModel === 'stand-in' ? standIn() : await sface())

  const store = new Store(config.databasePath)

  let payment: PaymentDeps | undefined
  if (config.idTierPrice > 0n) {
    const price = { amount: config.idTierPrice, mint: config.idTierMint!, payTo: config.idTierPayTo! }
    payment = {
      price,
      payments: overrides.payments ?? new RpcPayments({ rpcUrl: config.rpcUrl!, price }),
      reference: async (paymentId) => (await seed.derive(`reference/${paymentId}`)).address,
    }
  }

  const gift = Object.keys(config.gift).length ? { gift: config.gift, sponsor: await seed.derive(SPONSOR_KEY_LABEL) } : undefined

  const limit = new RateLimit({ max: config.sessionLimitPerHour, windowMs: 3_600_000 })
  const server = createServer(
    handler({
      face: { tier: 'face', check: faceCheck, workflowId: config.diditWorkflowId },
      id: { tier: 'id', check: idCheck, workflowId: config.diditIdWorkflowId },
      store,
      embedder,
      noteKey: { privateKey: notePrivate, key: noteKey },
      fingerprintKey,
      about: canonical({ v: 1, name: config.issuerName, key: issuerHex(noteKey), ...(gift && { gift: config.gift, sponsor: gift.sponsor.address }) }),
      payment,
      gift,
      appOrigins: config.appOrigins,
      limit,
      clientAddressHeader: config.clientAddressHeader,
      log: overrides.log,
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    store,
    noteKey,
    madeKey,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      store.close()
    },
  }
}
