// The host's credits, what a credit is: its id, and the check the host makes when one is spent,
// into a folder's balance or with an inbox entry; and a buy's price. The wire format (the challenge,
// a buy's reference, what a sponsor's ticket and a folder's balance payment sign) is the buyer's
// side's, read from ../client/client.ts, so the two never differ. See README.md, "Credits".
//
// A credit is a Privacy Pass credit of type 2 (RFC 9578): an RSA signature the host made blind, over
// a nonce only the buyer's app knows, so when it comes back to be spent the host sees a good
// signature and nothing that ties it to the buy. The checks are Cloudflare's privacypass-ts,
// unchanged.

import { Token, publicVerif } from '@cloudflare/privacypass-ts'

import { CREDIT_TYPE, challengeOf, creditBytes, importKey } from '../client/client.ts'

export { BUY_TYPE, CREDIT_BYTES, CREDIT_TYPE, DIRECTORY_PATH, PAYMENT_HEADER, SPEND_PATH, balanceMessage, challengeOf, referenceOf, ticketMessage } from '../client/client.ts'

const { BLIND_RSA, BlindRSAMode } = publicVerif

const suite = () => BLIND_RSA.suite[BlindRSAMode.PSS]()
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** What `count` credits cost: `count` times `price`, exactly, in decimal text. */
export function amountOf(price: string, count: number): string {
  const [whole, fraction = ''] = price.split('.')
  const total = (BigInt(whole + fraction) * BigInt(count)).toString().padStart(fraction.length + 1, '0')
  const cut = total.length - fraction.length
  const out = fraction.length ? `${total.slice(0, cut)}.${total.slice(cut)}` : total
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/** What a credit is named by on a service's spent list: its nonce, lowercase hex. */
export function creditId(credit: Uint8Array | string): string {
  const token = Token.deserialize(BLIND_RSA, creditBytes(credit))
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
    bytes = creditBytes(credit)
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
