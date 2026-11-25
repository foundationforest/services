// The verifier's secret: 32 random bytes that every key the verifier uses is derived from. The
// secret itself signs nothing. The code's names for it, `Seed` and the standard's `newSeed`, and the
// file's name stay as they are.
//
// It is made on the verifier's own machine, the first time the verifier starts without one (the
// standard's `newSeed`), and kept in one file beside its database (`verifier-seed.json` in
// DATABASE_PATH's directory), on the same volume. The file is `{"seed":"<64 hex>"}`, readable by the
// verifier's own user only. Nothing prints or logs it. A copy of the file, locked with a passphrase,
// is kept away from the volume, so a lost volume does not lose it (README.md, "The image and the
// commands"); this code does not make it.
//
// What is derived from it, with the standard's `hkdf`, the same every time:
//
//   face-facts    the face key: a service key (the standard's `serviceKey`) from these 32 bytes,
//                 which `signStamp` takes, and which signs every face stamp: its facts are the
//                 standard's list (facts.ts)
//   id-facts      the ID key, a service key the same way, which signs every ID stamp
//   sponsor       the sponsor key, Ed25519, which signs the gift's tickets (gift.ts)
//   vendor-data   the key of the hash of a stamp number each Didit session carries in its
//                 `vendor_data` (didit.ts), so the verifier knows which stamp number a session it
//                 meets was opened for
//   fact-salt     the key each fact's salt is derived with, for its session and its name (facts.ts)
//   payment       the AES-256-GCM key a payment's stamp number is locked under, inside the payment
//                 the verifier answers (server.ts), so the payment opens ID sessions for that stamp
//                 number only and nothing keeps the two side by side
//   fingerprint   the key of the person codes an ID stamp keeps (fingerprint.ts)
//
// Each stamp key's facts recipe is fixed for good: a new recipe is a new key, under a new text here.
// Never `face`, `id` or `id-fields`, the texts of the keys of the recipes before: their stamps are
// dropped at each start (service.ts). None of these keys holds money.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { hkdf, newSeed } from '@foundationforest/keys'
import { base58, hex } from '@foundationforest/folders'

/** The seed file's name, in the database's directory. */
export const SEED_FILE = 'verifier-seed.json'

/** The texts each key is derived under. */
export const INFO = {
  face: 'face-facts',
  id: 'id-facts',
  sponsor: 'sponsor',
  vendorData: 'vendor-data',
  salt: 'fact-salt',
  payment: 'payment',
  // The text of an earlier version's key of the same kind, whose codes it dropped: the codes this one
  // keeps are its own, and none of that version's is left.
  fingerprint: 'fingerprint',
} as const

/** An Ed25519 key: its address (the public key in base58), and its signature of a message. */
export type Ed25519Key = { address: string; sign(message: Uint8Array): Uint8Array }

export type Seed = {
  /** 32 bytes the standard's `hkdf` derives from the seed under `info`. */
  derive(info: string): Promise<Uint8Array>
  /** The Ed25519 key whose secret is `derive(info)`. */
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

/** The seed from its 32 bytes. The bytes stay inside, for deriving. */
export function seedFrom(bytes: Uint8Array): Seed {
  const secret = new Uint8Array(bytes)
  return {
    derive: (info) => hkdf(secret, info),
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
