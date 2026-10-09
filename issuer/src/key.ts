// The issuer's seed: the Ed25519 keypair in ISSUER_KEYPAIR, whose 32-byte secret every key the issuer
// uses is mixed from. The keypair itself signs nothing.
//
// It is written down as `solana-keygen` writes a key: a JSON list of 64 numbers, the 32-byte secret
// then the 32-byte public key.
//
// What is mixed from the secret, the same every time:
//   - with forest's `hkdf` under `issuer/notes`: the note key, a Baby Jubjub private key that signs
//     every note (standard/registry/README.md, "The note and the person proof");
//   - with forest's `hkdf` under `issuer/fingerprint`: the key of the document fingerprints (notes.ts);
//   - with forest's recipe for a key under a label (`mainKey`): `reference/<n>`, the address a payment
//     for one document check names, and `payments`, the devnet address payments go to once there is a
//     price.

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hkdf } from '../../standard/keys/src/hkdf.ts'
import { mainKey } from '../../standard/keys/src/profile.ts'
import { base58 } from '../../standard/records/src/bytes.ts'

export type IssuerKey = {
  publicKey: Uint8Array
  /** The keypair's public key in base58. */
  address: string
  /** The key forest's `mainKey` mixes from this key's secret under `label`. */
  derive(label: string): Promise<IssuerKey>
  /** 32 bytes forest's `hkdf` mixes from this key's secret under `info`. */
  mix(info: string): Promise<Uint8Array>
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
  const publicKey = publicKeyOf(privateKey(secret))
  return {
    publicKey,
    address: base58.encode(publicKey),
    derive: async (label) => fromSecret((await mainKey(secret, label)).privateKey),
    mix: (info) => hkdf(secret, info),
  }
}

/** The issuer's seed, from a keypair file. */
export function loadKeypair(path: string): IssuerKey {
  return parseKeypair(readFileSync(path, 'utf8'), `the key file ${path}`)
}

/**
 * The issuer's seed from the contents of a sealed variable (`ISSUER_KEYPAIR`), written to a file of
 * its own: a new directory under the system's temporary directory, readable by this process's user
 * only (0700), holding one file readable by it only (0600). Never under the repo or the build, and
 * `remove` deletes it. The service loads the key and removes the file at once.
 */
export function writeKeyFile(contents: string): { path: string; remove(): void } {
  parseKeypair(contents, 'ISSUER_KEYPAIR')
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-key-'))
  const path = join(dir, 'issuer-keypair.json')
  writeFileSync(path, JSON.stringify(JSON.parse(contents)), { mode: 0o600, flag: 'wx' })
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
