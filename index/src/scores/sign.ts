// Every score the index serves is signed with ed25519 over its statement, as text, so anyone with an
// ordinary library can check it:
//
//   forest.foundation/index/v2/score
//   kind <uniqueness|standing|rating>
//   profile <the profile's address>
//   label <the row's label, or empty for standing and rating>
//   value <millionths, a signed whole number>
//   at <unix seconds>
//
// A rating's value is its 1.0 to 10.0 in millionths. The key comes from the index's 32-byte seed by
// HKDF-SHA256; the same key signs the roots of the reputation tree (reputation.ts).

import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const STATEMENT_HEADER = 'forest.foundation/index/v2/score'
export const KINDS = ['uniqueness', 'standing', 'rating'] as const

export type Kind = (typeof KINDS)[number]
export type Statement = { kind: Kind; profile: string; label: string; value: bigint; at: bigint }

export type IndexKeys = { ed25519: { secret: Uint8Array; publicKey: Uint8Array } }

export type Signed = { statement: string; ed25519: string }

const utf8 = (s: string) => new TextEncoder().encode(s)

/** The signing key from the 32-byte seed, by HKDF-SHA256 under its label, as standard/keys/ derives its keys. */
export function indexKeys(seed: Uint8Array): IndexKeys {
  if (seed.length !== 32) throw new RangeError('the index seed is 32 bytes')
  const secret = hkdf(sha256, seed, new Uint8Array(0), utf8('forest.foundation/index/ed25519/v1'), 32)
  return { ed25519: { secret, publicKey: ed25519.getPublicKey(secret) } }
}

export function statementText(s: Statement): string {
  return [
    STATEMENT_HEADER,
    `kind ${s.kind}`,
    `profile ${s.profile}`,
    `label ${s.label}`,
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
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error('unknown kind')
  return { kind: kind as Kind, profile: field(2, 'profile'), label: field(3, 'label'), value: BigInt(field(4, 'value')), at: BigInt(field(5, 'at')) }
}

export function sign(s: Statement, keys: IndexKeys): Signed {
  const statement = statementText(s)
  return { statement, ed25519: Buffer.from(ed25519.sign(utf8(statement), keys.ed25519.secret)).toString('hex') }
}

/** The public half, as served at `/`: what anyone needs to check a score. */
export function publicKeys(keys: IndexKeys) {
  return { ed25519: Buffer.from(keys.ed25519.publicKey).toString('hex') }
}

/** Whether the signature checks against the index's public key, and the statement is one. What a reader of a score does; the tests do it too. */
export function verify(signed: Signed, pub: ReturnType<typeof publicKeys>): boolean {
  parseStatement(signed.statement)
  return ed25519.verify(new Uint8Array(Buffer.from(signed.ed25519, 'hex')), utf8(signed.statement), new Uint8Array(Buffer.from(pub.ed25519, 'hex')))
}
