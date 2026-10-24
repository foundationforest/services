// The verifier's seed: 32 random bytes that every key the verifier uses is mixed from. The seed itself
// signs nothing.
//
// It is made on the verifier's own machine, the first time the verifier starts without one (the
// standard's `newSeed`), and kept in one file beside its database (`verifier-seed.json` in
// DATABASE_PATH's directory), on the same volume: the seed and the record of which checks it signed
// for are kept, or lost, together. The file is `{"seed":"<64 hex>"}`, readable by the verifier's own
// user only. Nothing prints or logs it.
//
// What is mixed from it, with the standard's `hkdf`, the same every time:
//
//   issuer/face             the face key: a service key (the standard's `serviceKey`) from these 32
//                           bytes, which `signStamp` takes, and which sign every face stamp
//   issuer/id               the ID key, a service key the same way, which signs every ID stamp
//   issuer/fingerprint      the key of the ID check's fingerprints (facts.ts)
//   issuer/sponsor          the sponsor key, Ed25519, which signs the gift's tickets (gift.ts)
//   issuer/reference/<id>   an Ed25519 key whose address a payment for one ID check names (payment.ts)
//
// Each stamp key's facts recipe is fixed for good (facts.ts): a new recipe is a new key, under a
// new text here. None of these keys holds money.
//
// The texts keep the word issuer, the verifier's old name: a text a recipe mixes under keeps its
// bytes, as the standard's own do (`forest/v1/issuer`), since a new text would give new keys.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { hkdf, newSeed } from '@foundationforest/keys'
import { base58, hex } from '@foundationforest/records'

/** The seed file's name, in the database's directory. */
export const SEED_FILE = 'verifier-seed.json'

/** The texts each key is mixed under. */
export const INFO = {
  face: 'issuer/face',
  id: 'issuer/id',
  fingerprint: 'issuer/fingerprint',
  sponsor: 'issuer/sponsor',
  reference: (paymentId: string) => `issuer/reference/${paymentId}`,
} as const

/** An Ed25519 key: its address (the public key in base58), and its signature of a message. */
export type Ed25519Key = { address: string; sign(message: Uint8Array): Uint8Array }

export type Seed = {
  /** 32 bytes the standard's `hkdf` mixes from the seed under `info`. */
  mix(info: string): Promise<Uint8Array>
  /** The Ed25519 key whose secret is `mix(info)`. */
  ed25519(info: string): Promise<Ed25519Key>
}

/** PKCS #8 for an Ed25519 secret (RFC 8410): this fixed header, then the 32 bytes. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The Ed25519 key with this 32-byte secret. */
export function ed25519(secret: Uint8Array): Ed25519Key {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, secret]), format: 'der', type: 'pkcs8' })
  // The public key: the last 32 bytes of its SubjectPublicKeyInfo.
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  return { address: base58.encode(publicKey), sign: (message) => new Uint8Array(sign(null, message, key)) }
}

/** The seed from its 32 bytes. The bytes stay inside, for mixing. */
export function seedFrom(bytes: Uint8Array): Seed {
  const secret = new Uint8Array(bytes)
  return {
    mix: (info) => hkdf(secret, info),
    ed25519: async (info) => ed25519(await hkdf(secret, info)),
  }
}

/**
 * The seed from its file's text. On anything else it throws a message that quotes none of the
 * text, since the text is the seed and an error message ends up in a log (JSON's own parse errors
 * quote the text they fail on).
 */
export function parseSeed(text: string, source: string): Seed {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  const seed = (value as { seed?: unknown } | undefined)?.seed
  const valid = typeof value === 'object' && value !== null && Object.keys(value).join() === 'seed' && typeof seed === 'string' && /^[0-9a-f]{64}$/.test(seed)
  if (!valid) throw new Error(`${source} is not the verifier's seed: {"seed":"<64 lowercase hex>"}`)
  return seedFrom(hex.decode(seed as string))
}

/**
 * The seed from its file at `path`; with no file there, a new seed made here and written to `path`
 * first, readable by this user only and never over a file that exists. `made` says which.
 */
export function loadOrMakeSeed(path: string): { seed: Seed; made: boolean } {
  const made = !existsSync(path)
  if (made) writeFileSync(path, JSON.stringify({ seed: hex.encode(newSeed()) }), { flag: 'wx', mode: 0o600 })
  return { seed: parseSeed(readFileSync(path, 'utf8'), `the seed file ${path}`), made }
}
