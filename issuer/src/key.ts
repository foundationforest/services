// The issuer's seed: an Ed25519 keypair, whose 32-byte secret every key the issuer uses is mixed from.
// The keypair itself signs nothing.
//
// It is made on the issuer's own machine, the first time the issuer starts without one, and kept in
// one file beside its database (`issuer-keypair.json` in DATABASE_PATH's directory), on the same
// volume: the key and the record of which checks it signed for are lost or kept together. It is
// written down as `solana-keygen` writes a key: a JSON list of 64 numbers, the 32-byte secret then
// the 32-byte public key. Nothing prints or logs it.
//
// What is mixed from the secret, the same every time:
//   - with the standard's `hkdf` under `issuer/notes`: the note key, a Baby Jubjub private key that signs
//     every note (standard/registry/README.md, "The note and the person proof");
//   - with the standard's `hkdf` under `issuer/fingerprint`: the key of the document fingerprints (notes.ts);
//   - with the standard's recipe for a key under a label (`mainKey`): `reference/<n>`, the address a payment
//     for one document check names; and `sponsor`, the key that signs the welcome gift's tickets
//     (gift.ts). None holds money. The address a price is paid to (ID_TIER_PAY_TO) is not mixed
//     from it.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { hkdf } from '../../standard/keys/src/hkdf.ts'
import { mainKey } from '../../standard/keys/src/profile.ts'
import { base58 } from '../../standard/records/src/bytes.ts'

export type IssuerKey = {
  publicKey: Uint8Array
  /** The keypair's public key in base58. */
  address: string
  /** The key the standard's `mainKey` mixes from this key's secret under `label`. */
  derive(label: string): Promise<IssuerKey>
  /** 32 bytes the standard's `hkdf` mixes from this key's secret under `info`. */
  mix(info: string): Promise<Uint8Array>
  /** This key's Ed25519 signature of `message`: how the `sponsor` key signs the gift's tickets. */
  sign(message: Uint8Array): Uint8Array
}

/** PKCS #8 for an Ed25519 secret (RFC 8410): this fixed header, then the 32 bytes. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

function privateKey(secret: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, secret]), format: 'der', type: 'pkcs8' })
}

/** The public key an Ed25519 secret makes: the last 32 bytes of its SubjectPublicKeyInfo. */
function publicKeyOf(key: KeyObject): Uint8Array {
  return new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
}

/**
 * The key from its 64 numbers. On anything else it throws a message that quotes none of the input,
 * since the input is a secret key and an error message ends up in a log (JSON's own parse errors
 * quote the text they fail on).
 */
export function parseKeypair(text: string, source: string): IssuerKey {
  let numbers: unknown
  try {
    numbers = JSON.parse(text)
  } catch {
    numbers = undefined
  }
  const valid =
    Array.isArray(numbers) &&
    numbers.length === 64 &&
    numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  if (!valid) throw new Error(`${source} is not a Solana keypair: a JSON list of 64 numbers`)
  const bytes = Uint8Array.from(numbers as number[])
  const issuer = fromSecret(bytes.slice(0, 32))
  if (!Buffer.from(issuer.publicKey).equals(bytes.subarray(32))) {
    throw new Error(`${source} is not a Solana keypair: its two halves do not match`)
  }
  return issuer
}

/** A key from its 32-byte secret. The secret stays inside, for mixing other keys. */
function fromSecret(secret: Uint8Array): IssuerKey {
  const key = privateKey(secret)
  const publicKey = publicKeyOf(key)
  return {
    publicKey,
    address: base58.encode(publicKey),
    derive: async (label) => fromSecret((await mainKey(secret, label)).privateKey),
    mix: (info) => hkdf(secret, info),
    sign: (message) => new Uint8Array(sign(null, message, key)),
  }
}

/**
 * The issuer's seed from its file at `path`; with no file there, a fresh seed made here and written
 * to `path` first, readable by this user only and never over a file that exists. `made` says which.
 */
export function loadOrMakeKey(path: string): { key: IssuerKey; made: boolean } {
  const made = !existsSync(path)
  if (made) {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    writeFileSync(path, JSON.stringify([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')]), { flag: 'wx', mode: 0o600 })
  }
  return { key: parseKeypair(readFileSync(path, 'utf8'), `the key file ${path}`), made }
}
