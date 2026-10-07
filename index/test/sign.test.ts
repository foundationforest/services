// A served score's signature: it verifies against the index's public key, and a score changed after
// signing, or another index's key, fails.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { indexKeys, parseStatement, publicKeys, sign, statementText, verify } from '../src/scores/sign.ts'

const seed = new Uint8Array(32).fill(9)
const keys = indexKeys(seed)
const pub = publicKeys(keys)

test('the same seed gives the same keys, and another seed other keys', () => {
  assert.deepEqual(publicKeys(indexKeys(new Uint8Array(32).fill(9))), pub)
  assert.notDeepEqual(publicKeys(indexKeys(new Uint8Array(32).fill(8))), pub)
})

test('a statement reads back as written, for each kind; an unknown kind is refused', () => {
  const s = { kind: 'standing' as const, profile: 'EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu', label: '', value: -1_234_567n, at: 1_790_000_000n }
  assert.deepEqual(parseStatement(statementText(s)), s)
  const r = { kind: 'rating' as const, profile: 'EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu', label: '', value: 8_500_000n, at: 1_790_000_000n }
  assert.deepEqual(parseStatement(statementText(r)), r)
  assert.throws(() => parseStatement(statementText(s).replace('kind standing', 'kind trust')), /unknown kind/)
  assert.throws(() => parseStatement(statementText(s).replace('kind standing', 'kind toString')), /unknown kind/)
})

test('the signature verifies, and a changed score or another index’s key fails', () => {
  const s = { kind: 'uniqueness' as const, profile: 'EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu', label: 'online-tutors/seller', value: 1_000_000n, at: 1_790_000_000n }
  const signed = sign(s, keys)
  assert.deepEqual(Object.keys(signed), ['statement', 'ed25519'], 'one signature')
  assert.equal(verify(signed, pub), true)

  const inflated = sign({ ...s, value: 2_000_000n }, keys)
  assert.equal(verify({ ...signed, statement: inflated.statement }, pub), false)

  const other = publicKeys(indexKeys(new Uint8Array(32).fill(1)))
  assert.equal(verify(signed, other), false, "another index's key")
})
