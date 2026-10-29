// Which profiles count: a verification that checks, for a key the lists name, under that key's
// verifier name, for the profile's own market and role, first seen no later than the key's until; and
// each counted profile's uniqueness, from the keys it counts for.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ProfilePage } from '../src/pages/profile.ts'
import { index, verifier, profile, publishProfile, startHost, twin } from './world.ts'

const listed = verifier('verifier.test.example')
const other = verifier('other.test.example')
const leaked = verifier('leaked.test.example')
const id = verifier('id.test.example')
let host: Awaited<ReturnType<typeof startHost>>

before(async () => {
  host = await startHost()
})
after(async () => {
  await host.close()
})

const keys = () => [
  { key: listed.key, verifier: listed.name, label: 'face check', confidence: 0.75 },
  { key: other.key, verifier: 'someone.else.example', label: 'face check', confidence: 0.75 },
  { key: leaked.key, verifier: leaked.name, label: 'face check', confidence: 0.75, until: '2020-01-01T00:00:00Z' },
  { key: id.key, verifier: id.name, label: 'ID check', confidence: 0.95 },
]

test('a profile counts only with a verification that checks, for a listed key, under its name, for its own market and role', async () => {
  const good = await profile('tutoring/tutor', [listed])
  const changed = await profile('tutoring/tutor', [listed])
  changed.proofs[0]!.proof = changed.proofs[0]!.proof.slice(0, 40) + (changed.proofs[0]!.proof[40] === 'A' ? 'B' : 'A') + changed.proofs[0]!.proof.slice(41)
  const unlisted = await profile('tutoring/tutor', [verifier('unlisted.example')])
  const wrongName = await profile('tutoring/tutor', [other])
  const wrongLabel = await profile('tutoring/tutor')
  wrongLabel.proofs = (await profile('tutoring/student', [listed], wrongLabel.seed)).proofs
  const noMarket = await profile('knitting/maker', [listed])
  const noRole = await profile('tutoring/seller', [listed])
  const afterUntil = await profile('tutoring/tutor', [leaked])
  const twice = await profile('tutoring/tutor', [listed, listed])
  const both = await profile('tutoring/tutor', [listed, id])
  const all = { good, changed, unlisted, wrongName, wrongLabel, noMarket, noRole, afterUntil, twice, both }
  for (const p of Object.values(all)) await publishProfile(host.url, p)

  const i = await index({ hosts: [host.url], keys: keys() })
  await i.pass()
  const seen = async (p: typeof good) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body

  const counted = await seen(good)
  assert.deepEqual(counted.checks, [{ verifier: listed.name, key: listed.key, label: 'face check' }])
  assert.equal(counted.proofs[0]!.result, 'counts')
  assert.equal(i.store.db.prepare('select counted from profiles where address = ?').get(good.key.address)!.counted, 1)
  // Its uniqueness is its key's confidence; a key counts once, however many proofs show it; a face
  // check and an ID check together, 1 - 0.25 x 0.05.
  assert.equal(counted.uniqueness, 75)
  assert.equal((await seen(twice)).uniqueness, 75)
  assert.deepEqual([(await seen(both)).uniqueness, (await seen(both)).checks.map((c) => c.label)], [99, ['face check', 'ID check']])

  const why = async (p: typeof good) => {
    const o = await seen(p)
    assert.deepEqual(o.checks, [], p.label)
    return o.proofs[0]!.result
  }
  assert.equal(await why(changed), 'it does not check')
  assert.equal(await why(unlisted), 'its key is not one this index lists')
  assert.match(await why(wrongName), /^its verifier name is not someone\.else\.example/)
  assert.match(await why(wrongLabel), /^its label is not tutoring\/tutor/)
  assert.match(await why(noMarket), /knitting\/maker, are not a market and one of its roles in the directory/)
  assert.match(await why(noRole), /tutoring\/seller, are not a market and one of its roles/)
  assert.match(await why(afterUntil), /^this index first saw it after 2020-01-01T00:00:00.000Z/)

  // When it first saw each is kept by the profile's key and the verifier's: one row for the pair,
  // however many of its verifications show that key.
  const seenRows = (p: typeof good, key: string) => i.store.db.prepare('select first from seen where profile = ? and key = ?').all(p.key.address, key)
  assert.ok(Number(seenRows(good, listed.key)[0]!.first) <= Date.now())
  assert.equal(seenRows(twice, listed.key).length, 1)
  assert.deepEqual(i.store.db.prepare('select key from seen where profile = ? order by key').all(both.key.address).map((r) => r.key), [listed.key, id.key].sort())
  await i.close()
})
