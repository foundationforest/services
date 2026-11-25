// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { serviceKey } from '@foundationforest/keys'
import { stampSigned } from '@foundationforest/proofs'
import { canonical } from '@foundationforest/folders'

import { DiditClient, type FaceCheck } from './didit.ts'
import { type Embedder, sface, standIn } from './face.ts'
import type { Gift } from './gift.ts'
import { FACE_FACTS, ID_FACTS, RECIPE } from './facts.ts'
import { INFO, SEED_FILE, loadOrMakeSeed } from './seed.ts'
import { HOLDS_EVERY_MS, SWEEP_EVERY_MS, errorKind, handler, sweep, sweepHolds, why } from './server.ts'
import { Store } from './store.ts'
import { type Payments, type Prices, StripeClient } from './stripe.ts'

/**
 * The ID check's consent screen: what an app shows before the ID check, word for word, served in
 * `GET /` as `consent`. It is the foundation's legal text, with the tries a payment gives and how long
 * the foundation's Didit plan keeps a check, so another verifier running this code writes its own
 * here. It names no price: the app shows the one `GET /` gives beside it, as Stripe's Price says it.
 * README.md quotes it, and test/readme.test.ts holds the two together; so for the texts below.
 */
export const CONSENT =
  "The check's price is held through Stripe for the Open Forest Foundation and covers up to three tries in a day: it is taken only if the check gives you a new stamp, and is otherwise released within two days. Stripe keeps your payment details and email; Forest keeps of the payment only a one-way hash and how it was used, never beside your stamp. Forest, run by the Open Forest Foundation, checks your face and a government ID with Didit, its provider, to make sure each person is counted once. Didit checks the birth date on your ID: Forest is for people 18 and older. When the check passes, Didit keeps it up to five years, so it can tell if the same person comes back: photos of your ID and what it reads on it (your name, date of birth and document number), your selfie, a short video and a template of your face. A check that does not pass is deleted at Didit once Forest has its answer, a day after it began at the latest, and one left unfinished a day after it began. For a person with a stamp, Didit also keeps its record of the full name, date of birth and country it read. Forest keeps nothing about who you are: only the stamps it signed you, a one-way hash of what each check saw, so it can hand them back if you lose them. It gives you an ID stamp, with every text field read from your ID beside it (your name, date of birth, document number and the rest), for you to keep, and a face stamp from the same selfie if you have none yet; a profile that shows either says only that you were checked."

/** The face check's consent screen: what an app shows before the face check, served in `GET /` as `face.consent`. */
export const FACE_CONSENT =
  "Forest, run by the Open Forest Foundation, checks your face with Didit, its provider, to make sure each person is counted once. The check is free, once, and within it you can take your selfie up to three times. Didit also uses your selfie to estimate your age: Forest is for people 18 and older, and a face it estimates to be under 21 is refused, so you take the ID check, which reads your birth date. Didit keeps your selfie and a short video while it checks. An hour after your stamp is signed, Forest deletes the check at Didit, which still keeps a template of your face (numbers, no photo) up to five years, so it can tell if you come back; it keeps none when you already hold a face stamp. A check that does not pass is deleted at Didit once Forest has its answer, a day after it began at the latest, and one left unfinished a day after it began. Forest keeps nothing about who you are: only the stamp it signed you, a one-way hash of what the check saw, so it can hand it back if you lose it. It gives you a face stamp, with the face model's name and the 128 numbers it makes from your selfie beside it, for you to keep; a profile that shows it says only that you were checked."

/** The one line an app has the person tick, before either check, served in `GET /` as `agree`. */
export const AGREE = 'I am 18 or older and I agree'

/** The line the person agrees to before the ID check, so it starts at once, served in `GET /` as `id.cancelRight`. */
export const CANCEL_RIGHT = 'I ask for the ID check to start now, and I understand that I lose my right to cancel it once it is done.'

export type Config = {
  /** The verifier's name: what a person's stamp number at it is derived from (the standard's `stampNumberOf`), and what every stamp it signs carries. */
  verifierName: string
  /** The key of the one Didit application both checks run in, so each face is compared with every face of either check: a face search sees only its own application's. */
  diditApiKey: string
  /** The face check's workflow: liveness, with Didit's face search. */
  diditFaceWorkflowId: string
  /** The ID check's workflow: document, liveness and face match. */
  diditIdWorkflowId: string
  diditBaseUrl: string
  /** `sface`, or `stand-in`: one fixed embedding, only with a stand-in Didit on this machine. */
  faceModel: 'sface' | 'stand-in'
  /** The gifts: the host's origin and how many of its credits each check gives. Unset: none. */
  gift?: Gift
  /** The origins an app may ask the person to come back to after a check (`returnUrl`); empty for none. */
  appOrigins: string[]
  /**
   * Stripe's key, its publishable key, for the payment page, and the two Prices the ID check sells:
   * for a stamp number's first ID stamp, and for each one after. Unset: the ID check is not for sale.
   */
  stripe?: { secretKey: string; publishableKey: string; price: string; addedPrice: string }
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
    const credits = { face: whole('FACE_CREDITS', env.FACE_CREDITS || '10', 0), id: whole('ID_CREDITS', env.ID_CREDITS || '100', 0) }
    if (credits.face > 0 || credits.id > 0) gift = { origin: origin('HOST_URL', env.HOST_URL), credits }
  }
  const { STRIPE_ID_PRICE: price, STRIPE_ADDED_ID_PRICE: addedPrice, STRIPE_PUBLISHABLE_KEY: publishableKey } = env
  for (const [name, value] of [['STRIPE_ID_PRICE', price], ['STRIPE_ADDED_ID_PRICE', addedPrice]] as const) {
    if (value && !/^price_[A-Za-z0-9]+$/.test(value)) throw new Error(`${name} is a Stripe Price: price_…`)
  }
  // Public, but quoted no more than the secret key is.
  if (publishableKey && !/^pk_(test|live)_[A-Za-z0-9]+$/.test(publishableKey)) throw new Error('STRIPE_PUBLISHABLE_KEY is a Stripe publishable key, pk_…')
  let stripe: Config['stripe']
  if (env.STRIPE_SECRET_KEY) {
    // Never quoted: it is a secret.
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY)) throw new Error('STRIPE_SECRET_KEY is a Stripe secret key, sk_…, or a restricted one, rk_…')
    if (!price || !addedPrice) throw new Error('STRIPE_SECRET_KEY needs STRIPE_ID_PRICE and STRIPE_ADDED_ID_PRICE, the Prices the ID check sells')
    if (!publishableKey) throw new Error('STRIPE_SECRET_KEY needs STRIPE_PUBLISHABLE_KEY, its publishable key, for the payment page')
    // A test key's sessions are unknown to a live publishable key, and the other way round.
    if (/_test_/.test(env.STRIPE_SECRET_KEY) !== publishableKey.startsWith('pk_test_')) throw new Error('STRIPE_PUBLISHABLE_KEY is of another mode than STRIPE_SECRET_KEY: both test, or both live')
    stripe = { secretKey: env.STRIPE_SECRET_KEY, publishableKey, price, addedPrice }
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
    stripe,
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
  /**
   * What the sweep does every minute: deletes in Didit the sessions signed an hour ago or more, and
   * those that gave no stamp and opened a day ago or more; an hour after its last answered search,
   * cancels the old holds at Stripe; and, until Stripe has said them, asks it for the two prices.
   */
  sweep(): Promise<void>
  /** Stops taking requests, and closes the file. */
  close(): Promise<void>
}

/**
 * Starts the service. Tests and the sandbox run pass their own checks and embedder, and tests their
 * own Stripe; otherwise it talks to Didit and, with a key, Stripe, and loads the face models (or,
 * with `FACE_MODEL=stand-in`, the stand-in).
 */
export async function startVerifier(
  config: Config,
  overrides: {
    faceCheck?: FaceCheck
    idCheck?: FaceCheck
    embedder?: Embedder
    payments?: Payments
    log?: (line: string) => void
    now?: () => number
  } = {},
): Promise<Verifier> {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  const { seed, made: madeSeed } = loadOrMakeSeed(join(dirname(config.databasePath), SEED_FILE))
  const stampKeys = { face: serviceKey(await seed.derive(INFO.face)), id: serviceKey(await seed.derive(INFO.id)) }
  const keys = { face: stampKeys.face.address, id: stampKeys.id.address }
  const sponsor = await seed.ed25519(INFO.sponsor)
  const hashKeys = { vendorData: await seed.derive(INFO.vendorData), salt: await seed.derive(INFO.salt) }
  const paymentKey = await seed.derive(INFO.payment)
  const baseUrl = config.diditBaseUrl
  const apiKey = config.diditApiKey
  const faceCheck = overrides.faceCheck ?? new DiditClient({ apiKey, baseUrl, workflowId: config.diditFaceWorkflowId })
  const idCheck = overrides.idCheck ?? new DiditClient({ apiKey, baseUrl, workflowId: config.diditIdWorkflowId })
  const embedder = overrides.embedder ?? (config.faceModel === 'stand-in' ? standIn() : await sface())
  const payments = overrides.payments ?? (config.stripe && new StripeClient(config.stripe))

  const store = new Store(config.databasePath)
  // The first stamp each key signed for a stamp number is the one handed back: a kept stamp its key did
  // not sign, as from a key whose recipe this code no longer uses, is forgotten, so its stamp number's
  // next check keeps a new one.
  for (const check of ['face', 'id'] as const) {
    store.dropUnsigned(check, (stampNumber, stamp) => stampSigned({ stampNumber, ...stamp, verifierName: config.verifierName, verifier: keys[check] }))
  }

  const gift = config.gift && { gift: config.gift, sponsor }
  const log = overrides.log ?? ((line: string) => console.log(line))
  const aboutWith = (prices: Prices | null) =>
    canonical({
      name: config.verifierName,
      // Each key with the names of its facts, in their list's order (facts.ts), and the face check's consent screen.
      face: { key: keys.face, facts: [...FACE_FACTS], consent: FACE_CONSENT },
      // Beside the ID key, as the ID check is the one sold: whether it is for sale, through the same
      // Stripe its routes use, so this never says so while they answer `not_for_sale`; whether its
      // payments run on a test key; and its two prices, as Stripe's Prices say, so no app writes one.
      // All always there, false and null without a key, the prices null until Stripe has said them,
      // so an app reads them with no rule for one left out.
      id: { key: keys.id, facts: [...ID_FACTS], forSale: payments !== undefined, testPayments: payments?.test ?? false, price: prices?.price ?? null, addedPrice: prices?.addedPrice ?? null, cancelRight: CANCEL_RIGHT },
      recipe: RECIPE,
      // The ID check's consent screen, where apps read it before the face check had its own.
      consent: CONSENT,
      agree: AGREE,
      ...(gift && { gift: { face: gift.gift.credits.face, host: gift.gift.origin, id: gift.gift.credits.id, sponsor: sponsor.address } }),
    })
  // The prices are Stripe's to say, and the face check never waits for Stripe: the verifier starts
  // without them, asks now and at every sweep till Stripe answers, and makes no payment before.
  let prices: Prices | null = null
  let about = aboutWith(null)
  const askPrices = async () => {
    if (!payments || prices) return
    try {
      prices = await payments.prices()
      about = aboutWith(prices)
    } catch (error) {
      log(`verifier: Stripe has not said the ID check's prices, asked again at the next sweep (${why(error)})`)
    }
  }
  void askPrices()

  const server = createServer(
    handler({
      verifierName: config.verifierName,
      face: { kind: 'face', check: faceCheck, workflowId: config.diditFaceWorkflowId },
      id: { kind: 'id', check: idCheck, workflowId: config.diditIdWorkflowId },
      store,
      embedder,
      stampKeys,
      hashKeys,
      paymentKey,
      about: () => about,
      prices: () => prices,
      gift,
      appOrigins: config.appOrigins,
      payments,
      log: overrides.log,
      now: overrides.now,
    }),
  )
  // One sweep at a time: a slow Didit never has two deleting the same sessions. The holds' search
  // runs at the first sweep and an hour after each one Stripe answered.
  const clock = overrides.now ?? Date.now
  let searchedAt = -Infinity
  let sweeping: Promise<void> | undefined
  const sweepNow = () =>
    (sweeping ??= (async () => {
      await sweep({ store, checks: { face: faceCheck, id: idCheck }, vendorKey: hashKeys.vendorData, now: clock, log: overrides.log })
      if (payments && clock() - searchedAt >= HOLDS_EVERY_MS && (await sweepHolds({ payments, now: clock, log: overrides.log }))) searchedAt = clock()
      await askPrices()
    })().finally(() => {
      sweeping = undefined
    }))
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
