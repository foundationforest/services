// The index's seed: made at its first start, readable by its own user only, its key the same after.

import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { hex, publicKeyFromAddress } from '@foundationforest/folders'
import { serviceKey } from '@foundationforest/keys'

import { loadOrMakeKey, SEED_FILE } from '../src/seed.ts'
import { cleanup, tmp } from './world.ts'

test('the seed is made at the first start, kept for its user only, and is the same key after', async () => {
  const dir = tmp('seed')
  const first = await loadOrMakeKey(dir)
  assert.equal(first.made, true)
  assert.ok(publicKeyFromAddress(first.key.address))
  assert.equal(statSync(join(dir, SEED_FILE)).mode & 0o777, 0o600)
  const text = readFileSync(join(dir, SEED_FILE), 'utf8')
  assert.match(text, /^\{"seed":"[0-9a-f]{64}"\}$/)
  assert.equal(first.key.address, serviceKey(hex.decode(JSON.parse(text).seed)).address, 'the seed is the key, with no text')
  const again = await loadOrMakeKey(dir)
  assert.equal(again.made, false)
  assert.equal(again.key.address, first.key.address)

  writeFileSync(join(dir, SEED_FILE), '{"seed":"not a seed, and a secret"}')
  await assert.rejects(loadOrMakeKey(dir), (err: Error) => !err.message.includes('secret') && /is not the index's seed/.test(err.message))
  cleanup(dir)
})
