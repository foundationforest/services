// Every score the index serves is signed twice:
//
//   ed25519         over the statement as text, for anyone with an ordinary library;
//   eddsa-poseidon  EdDSA over Poseidon on BabyJubJub (zk-kit's, the one Semaphore itself uses),
//                   over one field element, so a later zero-knowledge proof checks the index's
//                   word with a few hundred constraints instead of a SHA-256 and an ed25519.
//
// The statement:
//
//   forest.foundation/index/v1/score
//   kind <uniqueness|standing|rating>
//   did <the profile's DID>
//   scope <the badge's scope, or empty for standing and rating>
//   value <millionths, a signed whole number>
//   at <unix seconds>
//
// The field element: Poseidon(domain, kind, did, scope, value + 2^63, at), where
//   domain = fieldHash('forest.foundation/index/v1/score')
//   kind   = 1 for uniqueness, 2 for standing, 3 for rating
//   did    = fieldHash('forest.foundation/index/v1/did/', did)
//   scope  = the registry's own scopeOf(scope), the number a registration proof carries as its
//            scope, so a later circuit ties a uniqueness score to a badge's code; 0 otherwise
// fieldHash is the registry client's: keccak256 of the namespace and the bytes, shifted right a
// byte. The value is offset by 2^63 so a negative standing is still a small positive number a
// circuit can range-check. A rating's value is its 1.0 to 10.0 in millionths.

import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { derivePublicKey, signMessage, verifySignature } from '@zk-kit/eddsa-poseidon'
import { poseidon6 } from 'poseidon-lite/poseidon6'

import { fieldHash, scopeOf } from '../../../registry/client/src/field.ts'

export const STATEMENT_HEADER = 'forest.foundation/index/v1/score'
export const DOMAIN = fieldHash('forest.foundation/index/v1/score')
export const DID_NS = 'forest.foundation/index/v1/did/'
export const KIND = { uniqueness: 1n, standing: 2n, rating: 3n } as const
export const VALUE_OFFSET = 1n << 63n

export type Kind = keyof typeof KIND
export type Statement = { kind: Kind; did: string; scope: string; value: bigint; at: bigint }

export type IndexKeys = {
  ed25519: { secret: Uint8Array; publicKey: Uint8Array }
  eddsa: { secret: Uint8Array; publicKey: [bigint, bigint] }
}

export type Signed = {
  statement: string
  message: string
  ed25519: string
  eddsaPoseidon: { R8: [string, string]; S: string }
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** Both keys from one 32-byte seed, each by HKDF-SHA256 under its own label, as keys/ derives its keys. */
export function indexKeys(seed: Uint8Array): IndexKeys {
  if (seed.length !== 32) throw new RangeError('the index seed is 32 bytes')
  const edSecret = hkdf(sha256, seed, new Uint8Array(0), utf8('forest.foundation/index/ed25519/v1'), 32)
  const bjSecret = hkdf(sha256, seed, new Uint8Array(0), utf8('forest.foundation/index/eddsa-poseidon/v1'), 32)
  const bj = derivePublicKey(bjSecret)
  return {
    ed25519: { secret: edSecret, publicKey: ed25519.getPublicKey(edSecret) },
    eddsa: { secret: bjSecret, publicKey: [BigInt(bj[0]), BigInt(bj[1])] },
  }
}

export function statementText(s: Statement): string {
  return [
    STATEMENT_HEADER,
    `kind ${s.kind}`,
    `did ${s.did}`,
    `scope ${s.scope}`,
    `value ${s.value}`,
    `at ${s.at}`,
  ].join('\n')
}

export function parseStatement(text: string): Statement {
  const lines = text.split('\n')
  if (lines.length !== 6 || lines[0] !== STATEMENT_HEADER) throw new Error('not a score statement')
  const field = (i: number, name: string) => {
    const prefix = `${name} `
    if (!lines[i].startsWith(prefix)) throw new Error(`line ${i + 1} is not "${name}"`)
    return lines[i].slice(prefix.length)
  }
  const kind = field(1, 'kind')
  if (!Object.hasOwn(KIND, kind)) throw new Error('unknown kind')
  return { kind: kind as Kind, did: field(2, 'did'), scope: field(3, 'scope'), value: BigInt(field(4, 'value')), at: BigInt(field(5, 'at')) }
}

export function messageOf(s: Statement): bigint {
  return poseidon6([
    DOMAIN,
    KIND[s.kind],
    fieldHash(DID_NS, s.did),
    s.scope === '' ? 0n : scopeOf(s.scope),
    s.value + VALUE_OFFSET,
    s.at,
  ])
}

export function sign(s: Statement, keys: IndexKeys): Signed {
  const statement = statementText(s)
  const message = messageOf(s)
  const bj = signMessage(keys.eddsa.secret, message)
  return {
    statement,
    message: message.toString(),
    ed25519: Buffer.from(ed25519.sign(utf8(statement), keys.ed25519.secret)).toString('hex'),
    eddsaPoseidon: { R8: [BigInt(bj.R8[0]).toString(), BigInt(bj.R8[1]).toString()], S: BigInt(bj.S).toString() },
  }
}

/** The public half, as served at `/`: what anyone needs to check a score. */
export function publicKeys(keys: IndexKeys) {
  return {
    ed25519: Buffer.from(keys.ed25519.publicKey).toString('hex'),
    eddsaPoseidon: [keys.eddsa.publicKey[0].toString(), keys.eddsa.publicKey[1].toString()] as [string, string],
  }
}

/**
 * Checks both signatures against the index's public keys, and that the served message is the
 * statement's. What a reader of a score does; the tests do it too.
 */
export function verify(signed: Signed, pub: ReturnType<typeof publicKeys>): { ed25519: boolean; eddsaPoseidon: boolean } {
  const s = parseStatement(signed.statement)
  const message = messageOf(s)
  const ed = ed25519.verify(
    new Uint8Array(Buffer.from(signed.ed25519, 'hex')),
    utf8(signed.statement),
    new Uint8Array(Buffer.from(pub.ed25519, 'hex')),
  )
  const bj =
    message.toString() === signed.message &&
    verifySignature(
      message,
      { R8: [BigInt(signed.eddsaPoseidon.R8[0]), BigInt(signed.eddsaPoseidon.R8[1])], S: BigInt(signed.eddsaPoseidon.S) },
      [BigInt(pub.eddsaPoseidon[0]), BigInt(pub.eddsaPoseidon[1])],
    )
  return { ed25519: ed, eddsaPoseidon: bj }
}
