// Forest credits, the buyer's side: what an app does to buy a host's credits and spend them. A
// credit is a prepaid unit of one host's writes, a Privacy Pass credit of type 2 (RFC 9578): an RSA
// signature the host made blind, over a nonce only the buyer's app knows, so when it comes back to
// be spent the host sees a good signature and nothing that ties it to the buy. See the host's
// README.md, "Credits".
//
// The service, from its directory, which takes a payment on Solana or sells only for sponsors'
// tickets; the buy, and its pay link when there is a payment to make; finishing the credits from the
// service's answer; listing them for a spend. It talks to no network of its own. The blinding and
// the signatures are Cloudflare's privacypass-ts, unchanged; its type 2 client keeps the blinding in
// memory only, so the buy here keeps it as bytes, to finish later, from what the app keeps. The
// host checks and sells credits with its own code (../credits/), on the same wire format. The e2e
// loop buys with this, and so do the verifier's tests.

import { AuthenticatorInput, Token, TokenChallenge, genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad } from '@scure/base'

const { BLIND_RSA, BlindRSAMode, TokenRequest, convertRSASSAPSSToEnc } = publicVerif

/** The Privacy Pass credit type a credit is: Blind RSA (2048-bit), RSABSSA-SHA384-PSS-Deterministic. */
export const CREDIT_TYPE = 0x0002
/** Where a service publishes its credit key and its price: Privacy Pass's issuer directory. */
export const DIRECTORY_PATH = '/.well-known/private-token-issuer-directory'
/** The header a buy is collected with, naming what paid it: `solana <signature>` or `ticket <ticket>`. */
export const PAYMENT_HEADER = 'forest-payment'

const suite = () => BLIND_RSA.suite[BlindRSAMode.PSS]()
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const b64u = base64urlnopad

/** A service that sells credits, as its directory describes it. */
export type Service = {
  /** Its origin, `https://host[:port]`. Its credits answer a challenge naming its host. */
  origin: string
  /** Its credit key: RSA-2048 in SubjectPublicKeyInfo with the RSASSA-PSS identifier, as Privacy Pass publishes it. */
  key: Uint8Array
  /** Where a buy is sent: the directory's issuer-request-uri. */
  requestUri: string
  /** What one credit buys, in the service's own words: its unit is its own. */
  unit: string
  /** The Solana address a buy is paid to; absent when only sponsors' tickets buy. */
  address?: string
  /** What it is paid in: a dollar's mint address, or SOL; absent with the address. */
  mint?: string
  /** The price of one credit, in whole dollars, decimal text. */
  price: string
}

/** A credit, as the app keeps it: the service's origin, and the credit's bytes in base64url. */
export type Credit = { service: string; credit: string }

/** A buy waiting for its answer, as the app keeps it: what `finish` needs, all of it bytes. */
export type Pending = {
  service: string
  /** The service's credit key, base64url. */
  key: string
  /** The buy as sent, base64url: its SHA-256 is the payment's reference. */
  buy: string
  /** One per credit: the nonce it will carry and the blinding's inverse, each base64url. */
  blinds: { nonce: string; inverse: string }[]
}

const isObject = (v: unknown): v is { [key: string]: unknown } => v !== null && typeof v === 'object' && !Array.isArray(v)
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/

function addressBytes(text: unknown, what: string): Uint8Array {
  try {
    const bytes = base58.decode(text as string)
    if (bytes.length === 32 && base58.encode(bytes) === text) return bytes
  } catch {
    // Refused below.
  }
  throw new Error(`${what} is a Solana address`)
}

/** An origin as a profile entry's `hosts` writes it, and its host, the name its credits' challenge carries. */
function originOf(origin: string): { origin: string; host: string } {
  const url = new URL(origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('a service is an origin: https, or http on loopback for tests')
  }
  return { origin, host: url.host }
}

/**
 * The service, from its Privacy Pass issuer directory (RFC 9578 §4) read at `origin`: the type 2
 * key that counts at `now` (the latest whose not-before has passed), where a buy goes, and the
 * directory's `forest-credit` entry: what one credit buys and its price, and, when it takes a
 * payment on Solana, where it is paid and in which dollar. Without them, only tickets buy.
 */
export function serviceOf(origin: string, directory: unknown, now: number = Date.now()): Service {
  originOf(origin)
  if (!isObject(directory)) throw new Error('a directory is an object')
  const uri = directory['issuer-request-uri']
  if (typeof uri !== 'string') throw new Error('the directory names its issuer-request-uri')
  const keys = Array.isArray(directory['token-keys']) ? directory['token-keys'] : []
  const current = keys
    .filter((k): k is { [key: string]: unknown } => isObject(k) && k['token-type'] === CREDIT_TYPE && typeof k['token-key'] === 'string')
    .filter((k) => k['not-before'] === undefined || (typeof k['not-before'] === 'number' && k['not-before'] * 1000 <= now))
    .sort((a, b) => ((b['not-before'] as number | undefined) ?? 0) - ((a['not-before'] as number | undefined) ?? 0))[0]
  if (!current) throw new Error('the directory lists no type 2 key that counts now')
  const forest = directory['forest-credit']
  if (!isObject(forest)) throw new Error('the directory has no forest-credit entry')
  if (typeof forest.unit !== 'string' || !forest.unit) throw new Error('a service says what one credit buys')
  if ((forest.address === undefined) !== (forest.mint === undefined)) throw new Error('a payment names its address and its mint, or neither')
  if (forest.address !== undefined) {
    addressBytes(forest.address, 'address')
    if (forest.mint !== 'SOL') addressBytes(forest.mint, 'mint')
  }
  if (typeof forest.price !== 'string' || !DECIMAL.test(forest.price) || !/[1-9]/.test(forest.price)) throw new Error('price is decimal text above 0')
  return {
    origin,
    key: b64u.decode((current['token-key'] as string).replace(/=+$/, '')),
    requestUri: new URL(uri, origin).href,
    unit: forest.unit,
    ...(forest.address !== undefined && { address: forest.address as string, mint: forest.mint as string }),
    price: forest.price,
  }
}

/** The one challenge every credit of this service answers: type 2, its host, no redemption context, no origin info, so credits can be bought ahead and kept. */
export function challengeOf(origin: string): TokenChallenge {
  return new TokenChallenge(CREDIT_TYPE, originOf(origin).host, new Uint8Array(0))
}

/** The bytes a credit's signature covers: type 2, the nonce, the challenge's digest, the key's id. */
async function tokenInput(origin: string, key: Uint8Array, nonce: Uint8Array): Promise<AuthenticatorInput> {
  return new AuthenticatorInput(BLIND_RSA, CREDIT_TYPE, nonce, await sha256(challengeOf(origin).serialize()), await sha256(key))
}

const importKey = (key: Uint8Array) => crypto.subtle.importKey('spki', convertRSASSAPSSToEnc(key) as Uint8Array<ArrayBuffer>, BLIND_RSA.rsaParams, true, ['verify'])

/** The payment's reference for a buy: SHA-256 of its bytes, written as a Solana address. */
export async function referenceOf(buy: Uint8Array): Promise<string> {
  return base58.encode(await sha256(own(buy)))
}

/** What `count` credits cost: `count` times `price`, exactly, in decimal text. A buy's pay link asks for it, and a service checks the payment against it. */
export function amountOf(price: string, count: number): string {
  const [whole, fraction = ''] = price.split('.')
  const total = (BigInt(whole + fraction) * BigInt(count)).toString().padStart(fraction.length + 1, '0')
  const cut = total.length - fraction.length
  const out = fraction.length ? `${total.slice(0, cut)}.${total.slice(cut)}` : total
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/**
 * A buy of `count` credits: the requests, blinded so the service never sees what it signs; the
 * reference a payment or a sponsor's ticket names this buy by; when the service takes a payment, the
 * pay link anyone pays it with; and what the app keeps to finish the credits. Whoever
 * holds the buy can collect it, once paid; only the app holding `pending` can finish the credits.
 */
export async function buy(service: Service, count: number): Promise<{ buy: Uint8Array; reference: string; payLink?: string; pending: Pending }> {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('a buy is of one credit or more')
  const key = await importKey(service.key)
  const keyId = await sha256(service.key)
  const requests: InstanceType<typeof genericBatched.TokenRequest>[] = []
  const blinds: Pending['blinds'] = []
  for (let i = 0; i < count; i++) {
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const { blindedMsg, inv } = await suite().blind(key, (await tokenInput(service.origin, service.key, nonce)).serialize())
    requests.push(new genericBatched.TokenRequest(new TokenRequest(keyId[keyId.length - 1]!, blindedMsg, BLIND_RSA)))
    blinds.push({ nonce: b64u.encode(nonce), inverse: b64u.encode(inv) })
  }
  const bytes = new genericBatched.BatchedTokenRequest(requests).serialize()
  const reference = await referenceOf(bytes)
  const pending = { service: service.origin, key: b64u.encode(service.key), buy: b64u.encode(bytes), blinds }
  if (service.address === undefined) return { buy: bytes, reference, pending }
  const payLink =
    `solana:${service.address}?amount=${amountOf(service.price, count)}` +
    (service.mint === 'SOL' ? '' : `&spl-token=${service.mint}`) +
    `&reference=${reference}&label=${encodeURIComponent(originOf(service.origin).host)}`
  return { buy: bytes, reference, payLink, pending }
}

/** A pending buy's shape, as the app keeps it. Throws on any other. */
export function checkPending(value: unknown): asserts value is Pending {
  if (!isObject(value)) throw new Error('a pending buy is an object')
  for (const k of Object.keys(value)) if (!['service', 'key', 'buy', 'blinds'].includes(k)) throw new Error(`unknown pending field ${k}`)
  originOf(value.service as string)
  for (const k of ['key', 'buy'] as const) if (typeof value[k] !== 'string') throw new Error(`${k} is base64url`)
  if (!Array.isArray(value.blinds) || !value.blinds.length) throw new Error('blinds is a list, one per credit')
  for (const b of value.blinds as unknown[]) {
    if (!isObject(b) || Object.keys(b).sort().join() !== 'inverse,nonce' || typeof b.nonce !== 'string' || typeof b.inverse !== 'string') throw new Error('a blind is { nonce, inverse }')
  }
}

/**
 * The credits, from the service's answer to a buy: each one unblinded and its signature checked
 * against the service's key, so the app knows what it holds. Refuses an answer with an empty slot,
 * a slot of another type, or a signature that does not hold, as for another buy; the buy can be
 * collected again, and the same answer comes back.
 */
export async function finish(pending: Pending, answer: Uint8Array): Promise<Credit[]> {
  checkPending(pending)
  const keyBytes = b64u.decode(pending.key)
  const key = await importKey(keyBytes)
  const slots = [...genericBatched.GenericBatchTokenResponse.deserialize(own(answer))]
  if (slots.length !== pending.blinds.length) throw new Error(`the answer has ${slots.length} slots for ${pending.blinds.length} credits`)
  const credits: Credit[] = []
  for (const [i, slot] of slots.entries()) {
    const response = slot.tokenResponse
    if (!(response instanceof publicVerif.TokenResponse)) throw new Error(`slot ${i} holds no credit`)
    const blind = pending.blinds[i]!
    const input = await tokenInput(pending.service, keyBytes, b64u.decode(blind.nonce))
    let signature: Uint8Array
    try {
      signature = await suite().finalize(key, input.serialize(), response.blindSig, b64u.decode(blind.inverse))
    } catch {
      throw new Error(`slot ${i}: the signature does not hold for this buy`)
    }
    credits.push({ service: pending.service, credit: b64u.encode(new Token(BLIND_RSA, input, signature).serialize()) })
  }
  return credits
}

/** A credit's size: type, nonce, challenge digest, key id, and the 256-byte signature. */
export const CREDIT_BYTES = 2 + 32 + 32 + 32 + 256

/**
 * Bytes in an array of their own. privacypass-ts reads a view's whole underlying buffer from its
 * start, so a credit or an answer that is a slice of a larger one (a Node Buffer from the pool, say)
 * would be read wrong without this copy.
 */
const own = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

/** A credit's bytes, from the form the app keeps or as they are: exactly CREDIT_BYTES, in an array of their own. */
function bytesOf(credit: Credit | Uint8Array | string): Uint8Array {
  const bytes = own(credit instanceof Uint8Array ? credit : b64u.decode(typeof credit === 'string' ? credit : credit.credit))
  if (bytes.length !== CREDIT_BYTES) throw new Error(`not a credit: a credit is ${CREDIT_BYTES} bytes`)
  return bytes
}

/**
 * Credits spent with one request, as its body lists them: each credit's bytes, base64url, in order.
 * The host takes up to 100 in one spend into a folder's balance, and all of them or none.
 */
export function creditList(credits: (Credit | Uint8Array | string)[]): string[] {
  return credits.map((credit) => b64u.encode(bytesOf(credit)))
}
