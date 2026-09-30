// A served score's two signatures: both verify against the index's public keys, and a score that
// was changed after signing fails both.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { KIND, VALUE_OFFSET, indexKeys, messageOf, parseStatement, publicKeys, sign, statementText, verify } from '../src/scores/sign.ts'

const seed = new Uint8Array(32).fill(9)
const keys = indexKeys(seed)
const pub = publicKeys(keys)

test('the same seed gives the same keys, and another seed other keys', () => {
  assert.deepEqual(publicKeys(indexKeys(new Uint8Array(32).fill(9))), pub)
  assert.notDeepEqual(publicKeys(indexKeys(new Uint8Array(32).fill(8))), pub)
})

test('a statement reads back as written, for each kind; an unknown kind is refused', () => {
  const s = { kind: 'standing' as const, did: 'did:plc:abc', scope: '', value: -1_234_567n, at: 1_790_000_000n }
  assert.deepEqual(parseStatement(statementText(s)), s)
  const r = { kind: 'rating' as const, did: 'did:plc:abc', scope: '', value: 8_500_000n, at: 1_790_000_000n }
  assert.deepEqual(parseStatement(statementText(r)), r)
  assert.throws(() => parseStatement(statementText(s).replace('kind standing', 'kind trust')), /unknown kind/)
  assert.throws(() => parseStatement(statementText(s).replace('kind standing', 'kind toString')), /unknown kind/)
})

test('both signatures verify, and a changed score fails both', () => {
  const s = { kind: 'uniqueness' as const, did: 'did:plc:abc', scope: 'online-tutors', value: 1_000_000n, at: 1_790_000_000n }
  const signed = sign(s, keys)
  assert.deepEqual(verify(signed, pub), { ed25519: true, eddsaPoseidon: true })

  const inflated = sign({ ...s, value: 2_000_000n }, keys)
  const forged = { ...signed, statement: inflated.statement, message: inflated.message }
  assert.deepEqual(verify(forged, pub), { ed25519: false, eddsaPoseidon: false })

  const other = publicKeys(indexKeys(new Uint8Array(32).fill(1)))
  assert.deepEqual(verify(signed, other), { ed25519: false, eddsaPoseidon: false }, "another index's keys")
})

test('the field message separates kinds, scopes and signs of value', () => {
  const base = { kind: 'standing' as const, did: 'did:plc:abc', scope: '', value: 5n, at: 1n }
  const m = messageOf(base)
  assert.notEqual(messageOf({ ...base, kind: 'uniqueness' }), m)
  assert.notEqual(messageOf({ ...base, kind: 'rating' }), m)
  assert.notEqual(messageOf({ ...base, value: -5n }), m)
  assert.notEqual(messageOf({ ...base, scope: 'online-tutors' }), m)
  assert.deepEqual(KIND, { uniqueness: 1n, standing: 2n, rating: 3n }, 'standing keeps trust’s code')
  assert.ok(-5n + VALUE_OFFSET > 0n, 'a negative value is still a positive field element')
})
