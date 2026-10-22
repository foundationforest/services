// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { issuerKeyOf } from '@foundationforest/note'
import { base58, canonical } from '@foundationforest/records'

import { DiditClient, type FaceCheck } from './didit.ts'
import { type Embedder, sface, standIn } from './face.ts'
import type { Gift } from './gift.ts'
import { RateLimit } from './limit.ts'
import { RECIPES } from './notes.ts'
import { RpcPayments, type Payments, type Price } from './payment.ts'
import { INFO, SEED_FILE, loadOrMakeSeed } from './seed.ts'
import { handler, type PaymentDeps } from './server.ts'
import { Store } from './store.ts'

export type Config = {
  /** The issuer's name: what a person's secret for it is mixed from (the standard's `issuerSecret`). */
  issuerName: string
  diditApiKey: string
  /** The face check's workflow: liveness, with Didit's face search. */
  diditFaceWorkflowId: string
  /** The ID check's workflow: document, liveness and face match. */
  diditIdWorkflowId: string
  diditBaseUrl: string
  /** `sface`, or `stand-in`: one fixed embedding, only with a stand-in Didit on this machine. */
  faceModel: 'sface' | 'stand-in'
  /** The ID check's price, its dollar and where it is paid. Unset: the ID check is not offered. */
  idPrice?: Price
  /** The Solana RPC a payment is looked for through. Set with the price, and only then. */
  rpcUrl?: string
  /** The welcome gift: the host's origin and how many of its credits. Unset: none. */
  gift?: Gift
  /** The origins an app may ask the person to come back to after a face check (`returnUrl`); empty for none. */
  appOrigins: string[]
  /** The one file; the issuer's seed file sits beside it (`SEED_FILE`). */
  databasePath: string
  /** How many sessions one address may open in an hour. */
  sessionLimitPerHour: number
  /** The header a proxy in front puts the client's address in (`x-real-ip` on Railway); unset, the connection's. */
  clientAddressHeader?: string
  port: number
}

/** The name this issuer has unless told otherwise: every person's note number and stamps hang off it. */
export const ISSUER_NAME = 'issuer.forest.foundation'

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
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/** The ID check's four settings: all of them, or none, and then it is not offered. */
const ID_SETTINGS = ['ID_PRICE', 'ID_PAY_TO', 'ID_MINT', 'RPC_URL']

/**
 * Reads the variables `README.md` lists. Fails naming every required one that is missing. The seed is
 * no variable: it is the seed file beside the database (`SEED_FILE`).
 */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['DIDIT_API_KEY', 'DIDIT_FACE_WORKFLOW_ID', 'DIDIT_ID_WORKFLOW_ID'].filter((name) => !env[name])
  const priced = ID_SETTINGS.some((name) => env[name])
  if (priced) missing.push(...ID_SETTINGS.filter((name) => !env[name]))
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)

  let idPrice: Price | undefined
  if (priced) {
    if (!/^[1-9][0-9]{0,19}$/.test(env.ID_PRICE!)) throw new Error('ID_PRICE must be a whole number above 0: the price in the dollar’s smallest unit')
    for (const name of ['ID_PAY_TO', 'ID_MINT']) if (!isAddress(env[name]!)) throw new Error(`${name} is not an address`)
    idPrice = { amount: BigInt(env.ID_PRICE!), payTo: env.ID_PAY_TO!, mint: env.ID_MINT! }
  }
  let gift: Gift | undefined
  if (env.HOST_URL) {
    const credits = whole('HOST_CREDITS', env.HOST_CREDITS || '10', 0)
    if (credits > 0) gift = { origin: origin('HOST_URL', env.HOST_URL), credits }
  }
  const appOrigins = (env.APP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => origin('APP_ORIGINS', o))
  const faceModel = env.FACE_MODEL || 'sface'
  if (faceModel !== 'sface' && faceModel !== 'stand-in') throw new Error('FACE_MODEL is sface or stand-in')
  const diditBaseUrl = env.DIDIT_BASE_URL || 'https://verification.didit.me'
  if (faceModel === 'stand-in' && !onThisMachine(diditBaseUrl)) {
    throw new Error('FACE_MODEL=stand-in is for a stand-in Didit on this machine only: DIDIT_BASE_URL is not on loopback')
  }
  return {
    issuerName: env.ISSUER_NAME || ISSUER_NAME,
    diditApiKey: env.DIDIT_API_KEY!,
    diditFaceWorkflowId: env.DIDIT_FACE_WORKFLOW_ID!,
    diditIdWorkflowId: env.DIDIT_ID_WORKFLOW_ID!,
    diditBaseUrl,
    faceModel,
    idPrice,
    rpcUrl: priced ? env.RPC_URL : undefined,
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
  /** The two note keys, as addresses: what readers trust. */
  keys: { face: string; id: string }
  /** The sponsor key's address, with a gift. */
  sponsor?: string
  /** Whether this start made the issuer's seed, finding none beside the database. */
  madeSeed: boolean
  /** Stops taking requests, and closes the file. */
  close(): Promise<void>
}

/**
 * Starts the service. Tests and the sandbox run pass their own checks, payments and embedder;
 * otherwise it talks to Didit and to the RPC, and loads the face models (or, with
 * `FACE_MODEL=stand-in`, the stand-in).
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
  const { seed, made: madeSeed } = loadOrMakeSeed(join(dirname(config.databasePath), SEED_FILE))
  const noteKeys = { face: await seed.mix(INFO.face), id: await seed.mix(INFO.id) }
  const keys = { face: issuerKeyOf(noteKeys.face), id: issuerKeyOf(noteKeys.id) }
  const fingerprintKey = await seed.mix(INFO.fingerprint)
  const sponsor = await seed.ed25519(INFO.sponsor)
  if (config.idPrice?.payTo === sponsor.address) {
    throw new Error("ID_PAY_TO is the issuer's own sponsor key; payments go to an address of their own")
  }
  const didit = { apiKey: config.diditApiKey, baseUrl: config.diditBaseUrl }
  const faceCheck = overrides.faceCheck ?? new DiditClient({ ...didit, workflowId: config.diditFaceWorkflowId, check: 'face' })
  const idCheck = overrides.idCheck ?? new DiditClient({ ...didit, workflowId: config.diditIdWorkflowId, check: 'id' })
  const embedder = overrides.embedder ?? (config.faceModel === 'stand-in' ? standIn() : await sface())

  const store = new Store(config.databasePath)

  let payment: PaymentDeps | undefined
  if (config.idPrice) {
    const price = config.idPrice
    payment = {
      price,
      payments: overrides.payments ?? new RpcPayments({ rpcUrl: config.rpcUrl!, price }),
      reference: async (paymentId) => (await seed.ed25519(INFO.reference(paymentId))).address,
    }
  }

  const gift = config.gift && { gift: config.gift, sponsor }
  const about = canonical({
    name: config.issuerName,
    face: { key: keys.face, attributes: RECIPES.face },
    id: { key: keys.id, attributes: RECIPES.id },
    h: RECIPES.h,
    ...(gift && { gift: { host: gift.gift.origin, credits: gift.gift.credits, sponsor: sponsor.address } }),
  })

  const limit = new RateLimit({ max: config.sessionLimitPerHour, windowMs: 3_600_000 })
  const server = createServer(
    handler({
      face: { kind: 'face', check: faceCheck, workflowId: config.diditFaceWorkflowId },
      id: { kind: 'id', check: idCheck, workflowId: config.diditIdWorkflowId },
      store,
      embedder,
      noteKeys,
      fingerprintKey,
      about,
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
    keys,
    sponsor: gift ? sponsor.address : undefined,
    madeSeed,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      store.close()
    },
  }
}
