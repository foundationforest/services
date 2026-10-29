// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { serviceKey } from '@foundationforest/keys'
import { canonical } from '@foundationforest/folders'

import { DiditClient, type FaceCheck } from './didit.ts'
import { type Embedder, sface, standIn } from './face.ts'
import type { Gift } from './gift.ts'
import { RECIPES } from './facts.ts'
import { INFO, SEED_FILE, loadOrMakeSeed } from './seed.ts'
import { SWEEP_EVERY_MS, errorKind, handler, sweep } from './server.ts'
import { Store } from './store.ts'

export type Config = {
  /** The verifier's name: what a person's stamp number at it is mixed from (the standard's `stampNumberOf`), and what every stamp it signs carries. */
  verifierName: string
  diditApiKey: string
  /** The face check's workflow: liveness, with Didit's face search. */
  diditFaceWorkflowId: string
  /** The ID check's workflow: document, liveness and face match. */
  diditIdWorkflowId: string
  diditBaseUrl: string
  /** `sface`, or `stand-in`: one fixed embedding, only with a stand-in Didit on this machine. */
  faceModel: 'sface' | 'stand-in'
  /** The welcome gift: the host's origin and how many of its credits. Unset: none. */
  gift?: Gift
  /** The origins an app may ask the person to come back to after a check (`returnUrl`); empty for none. */
  appOrigins: string[]
  /** The one file; the verifier's seed file sits beside it (`SEED_FILE`). */
  databasePath: string
  port: number
}

/** The name this verifier has unless told otherwise: every person's stamp number hangs off it. */
export const VERIFIER_NAME = 'verifier.forest.foundation'

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

/**
 * Reads the variables `README.md` lists. Fails naming every required one that is missing. The seed is
 * no variable: it is the seed file beside the database (`SEED_FILE`).
 */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['DIDIT_API_KEY', 'DIDIT_FACE_WORKFLOW_ID', 'DIDIT_ID_WORKFLOW_ID'].filter((name) => !env[name])
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)

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
    verifierName: env.VERIFIER_NAME || VERIFIER_NAME,
    diditApiKey: env.DIDIT_API_KEY!,
    diditFaceWorkflowId: env.DIDIT_FACE_WORKFLOW_ID!,
    diditIdWorkflowId: env.DIDIT_ID_WORKFLOW_ID!,
    diditBaseUrl,
    faceModel,
    gift,
    appOrigins,
    databasePath: env.DATABASE_PATH || './data/verifier.sqlite',
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

export type Verifier = {
  url: string
  server: Server
  store: Store
  /** The two stamp keys, as addresses: what readers trust. */
  keys: { face: string; id: string }
  /** The sponsor key's address, with a gift. */
  sponsor?: string
  /** Whether this start made the verifier's seed, finding none beside the database. */
  madeSeed: boolean
  /** Deletes in Didit the sessions signed an hour ago or more, as the sweep does every minute. */
  sweep(): Promise<void>
  /** Stops taking requests, and closes the file. */
  close(): Promise<void>
}

/**
 * Starts the service. Tests and the sandbox run pass their own checks and embedder; otherwise it
 * talks to Didit, and loads the face models (or, with `FACE_MODEL=stand-in`, the stand-in).
 */
export async function startVerifier(
  config: Config,
  overrides: {
    faceCheck?: FaceCheck
    idCheck?: FaceCheck
    embedder?: Embedder
    log?: (line: string) => void
    now?: () => number
  } = {},
): Promise<Verifier> {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  const { seed, made: madeSeed } = loadOrMakeSeed(join(dirname(config.databasePath), SEED_FILE))
  const stampKeys = { face: serviceKey(await seed.mix(INFO.face)), id: serviceKey(await seed.mix(INFO.id)) }
  const keys = { face: stampKeys.face.address, id: stampKeys.id.address }
  const fingerprintKey = await seed.mix(INFO.fingerprint)
  const sponsor = await seed.ed25519(INFO.sponsor)
  const didit = { apiKey: config.diditApiKey, baseUrl: config.diditBaseUrl }
  const faceCheck = overrides.faceCheck ?? new DiditClient({ ...didit, workflowId: config.diditFaceWorkflowId, check: 'face' })
  const idCheck = overrides.idCheck ?? new DiditClient({ ...didit, workflowId: config.diditIdWorkflowId, check: 'id' })
  const embedder = overrides.embedder ?? (config.faceModel === 'stand-in' ? standIn() : await sface())

  const store = new Store(config.databasePath)

  const gift = config.gift && { gift: config.gift, sponsor }
  const about = canonical({
    name: config.verifierName,
    face: { key: keys.face, facts: RECIPES.face },
    id: { key: keys.id, facts: RECIPES.id },
    h: RECIPES.h,
    ...(gift && { gift: { host: gift.gift.origin, credits: gift.gift.credits, sponsor: sponsor.address } }),
  })

  const server = createServer(
    handler({
      verifierName: config.verifierName,
      face: { kind: 'face', check: faceCheck, workflowId: config.diditFaceWorkflowId },
      id: { kind: 'id', check: idCheck, workflowId: config.diditIdWorkflowId },
      store,
      embedder,
      stampKeys,
      fingerprintKey,
      about,
      gift,
      appOrigins: config.appOrigins,
      log: overrides.log,
      now: overrides.now,
    }),
  )
  // One sweep at a time: a slow Didit never has two deleting the same sessions.
  let sweeping: Promise<void> | undefined
  const sweepNow = () =>
    (sweeping ??= sweep({ store, checks: { face: faceCheck, id: idCheck }, now: overrides.now, log: overrides.log }).finally(() => {
      sweeping = undefined
    }))
  const log = overrides.log ?? ((line: string) => console.log(line))
  const sweeper = setInterval(() => void sweepNow().catch((error) => log(`verifier: the sweep failed (${errorKind(error)})`)), SWEEP_EVERY_MS)
  sweeper.unref()
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
    sweep: sweepNow,
    async close() {
      clearInterval(sweeper)
      await sweeping
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      store.close()
    },
  }
}
