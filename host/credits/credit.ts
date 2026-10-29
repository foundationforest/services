// The host's credits, what a credit is: its challenge, its id, and the check the host makes when a
// list of them is spent into a folder's balance; a buy's reference and price, and what a sponsor's
// ticket signs, as the seller (seller.ts) reads them. See README.md, "Credits".
//
// A credit is a Privacy Pass credit of type 2 (RFC 9578): an RSA signature the host made blind, over
// a nonce only the buyer's app knows, so when it comes back to be spent the host sees a good
// signature and nothing that ties it to the buy. The checks are Cloudflare's privacypass-ts,
// unchanged.

import { Token, TokenChallenge, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad } from '@scure/base'

const { BLIND_RSA, BlindRSAMode, convertRSASSAPSSToEnc } = publicVerif

/** The Privacy Pass credit type a credit is: Blind RSA (2048-bit), RSABSSA-SHA384-PSS-Deterministic. */
export const CREDIT_TYPE = 0x0002
/** Where a service publishes its credit key and its price: Privacy Pass's issuer directory. */
export const DIRECTORY_PATH = '/.well-known/private-token-issuer-directory'
/** The header a buy is collected with, naming what paid it: `ticket <ticket>`. */
export const PAYMENT_HEADER = 'forest-payment'

const suite = () => BLIND_RSA.suite[BlindRSAMode.PSS]()
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const b64u = base64urlnopad
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function base58Bytes(text: unknown, what: string): Uint8Array {
  try {
    const bytes = base58.decode(text as string)
    if (bytes.length === 32 && base58.encode(bytes) === text) return bytes
  } catch {
    // Refused below.
  }
  throw new Error(`${what} is 32 bytes in base58`)
}

/** An origin as a profile entry's `hosts` writes it, and its host, the name its credits' challenge carries. */
function originOf(origin: string): { origin: string; host: string } {
  const url = new URL(origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('a service is an origin: https, or http on loopback for tests')
  }
  return { origin, host: url.host }
}

/** The one challenge every credit of this service answers: type 2, its host, no redemption context, no origin info, so credits can be bought ahead and kept. */
export function challengeOf(origin: string): TokenChallenge {
  return new TokenChallenge(CREDIT_TYPE, originOf(origin).host, new Uint8Array(0))
}

const importKey = (key: Uint8Array) => crypto.subtle.importKey('spki', convertRSASSAPSSToEnc(key) as Uint8Array<ArrayBuffer>, BLIND_RSA.rsaParams, true, ['verify'])

/** A buy's reference, which a ticket names: SHA-256 of its bytes, in base58. */
export async function referenceOf(buy: Uint8Array): Promise<string> {
  return base58.encode(await sha256(own(buy)))
}

/** What `count` credits cost: `count` times `price`, exactly, in decimal text. */
export function amountOf(price: string, count: number): string {
  const [whole, fraction = ''] = price.split('.')
  const total = (BigInt(whole + fraction) * BigInt(count)).toString().padStart(fraction.length + 1, '0')
  const cut = total.length - fraction.length
  const out = fraction.length ? `${total.slice(0, cut)}.${total.slice(cut)}` : total
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/**
 * What a sponsor signs, with Ed25519, to pay for a buy: the service, the buy's reference and how many
 * credits it holds. So a ticket pays for that buy at that service, of that many credits, and no other.
 */
export function ticketMessage(origin: string, reference: string, credits: number): Uint8Array {
  originOf(origin)
  base58Bytes(reference, 'reference')
  if (!Number.isSafeInteger(credits) || credits < 1) throw new RangeError('a ticket is for one credit or more')
  return new TextEncoder().encode(`forest credit ticket\n${origin}\n${reference}\n${credits}`)
}

/** A credit's size: type, nonce, challenge digest, key id, and the 256-byte signature. */
export const CREDIT_BYTES = 2 + 32 + 32 + 32 + 256

/**
 * Bytes in an array of their own. privacypass-ts reads a view's whole underlying buffer from its
 * start, so a credit or an answer that is a slice of a larger one (a Node Buffer from the pool, say)
 * would be read wrong without this copy.
 */
const own = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

/** A credit's bytes, as shown or in base64url: exactly CREDIT_BYTES, in an array of their own. */
function bytesOf(credit: Uint8Array | string): Uint8Array {
  const bytes = own(credit instanceof Uint8Array ? credit : b64u.decode(credit))
  if (bytes.length !== CREDIT_BYTES) throw new Error(`not a credit: a credit is ${CREDIT_BYTES} bytes`)
  return bytes
}

/** What a credit is named by on a service's spent list: its nonce, lowercase hex. */
export function creditId(credit: Uint8Array | string): string {
  const token = Token.deserialize(BLIND_RSA, bytesOf(credit))
  return Array.from(token.authInput.nonce, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * For the host: does this credit hold? Type 2, its challenge, one of `keys` (the keys whose
 * credits it still counts), and the signature. Gives its id for the spent list; throws on anything
 * else. Whether it is spent, or held by a request in flight, is the spent list's to say.
 */
export async function checkCredit(credit: Uint8Array | string, service: { origin: string; keys: Uint8Array[] }): Promise<string> {
  let token: Token
  let bytes: Uint8Array
  try {
    bytes = bytesOf(credit)
    token = Token.deserialize(BLIND_RSA, bytes)
  } catch {
    throw new Error('not a credit')
  }
  if (!same(token.serialize(), bytes)) throw new Error('not a credit: not in its one spelling')
  const input = token.authInput
  if (input.tokenType !== CREDIT_TYPE) throw new Error('not a credit: another credit type')
  if (!same(input.challengeDigest, await sha256(challengeOf(service.origin).serialize()))) throw new Error("not this service's credit")
  let keyBytes: Uint8Array | undefined
  for (const k of service.keys) if (same(input.tokenKeyId, await sha256(k))) keyBytes = k
  if (!keyBytes) throw new Error('not under a key this service counts')
  if (!(await suite().verify(await importKey(keyBytes), token.authenticator, input.serialize()))) throw new Error('the signature does not hold')
  return creditId(bytes)
}

/**
 * For the host: several credits shown together, as a spend's body lists them (each credit's bytes,
 * base64url). At least one and at most `max`, each one
 * that holds (`checkCredit`), and no credit twice. Gives their ids, in order; throws on anything
 * else, so the host takes none of them.
 */
export async function checkCredits(list: unknown, service: { origin: string; keys: Uint8Array[] }, max: number): Promise<string[]> {
  if (!Array.isArray(list) || list.length < 1 || list.length > max) throw new Error(`show from 1 to ${max} credits`)
  const ids: string[] = []
  for (const credit of list) {
    if (typeof credit !== 'string') throw new Error('not a credit')
    ids.push(await checkCredit(credit, service))
  }
  if (new Set(ids).size !== ids.length) throw new Error('the same credit twice')
  return ids
}
