// The issuer's key: an Ed25519 key that signs each snapshot of the list and nothing else. Its address
// (base58 of its 32-byte public key) is the issuer's name: what a registry row records and what a
// reader trusts (forest/keys/README.md, "The recipe").
//
// It is written down as `solana-keygen` writes a key: a JSON list of 64 numbers, the 32-byte secret
// then the 32-byte public key. Signing is Node's own Ed25519 (RFC 8032, deterministic).

import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { base58 } from '../../forest/records/src/bytes.ts'

export type IssuerKey = {
  publicKey: Uint8Array
  /** The issuer's name: its public key in base58. */
  address: string
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
  const key = privateKey(bytes.subarray(0, 32))
  const publicKey = publicKeyOf(key)
  if (!Buffer.from(publicKey).equals(bytes.subarray(32))) {
    throw new Error(`${source} is not a Solana keypair: its two halves do not match`)
  }
  return {
    publicKey,
    address: base58.encode(publicKey),
    sign: (message) => new Uint8Array(sign(null, message, key)),
  }
}

/** The issuer's key, from a keypair file. */
export function loadKeypair(path: string): IssuerKey {
  return parseKeypair(readFileSync(path, 'utf8'), `the key file ${path}`)
}

/**
 * The issuer's key from the contents of a sealed variable (`ISSUER_KEYPAIR`), written to a file of
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
