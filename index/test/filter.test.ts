// Which profiles count: a note proof that checks, for a key the lists name, under that key's issuer
// name, for the profile's own market and role, first seen no later than the key's until.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ProfilePage } from '../src/pages/profile.ts'
import { index, issuer, profile, publishProfile, startHost, startRpc, twin } from './world.ts'

const listed = issuer('issuer.test.example')
const other = issuer('other.test.example')
const leaked = issuer('leaked.test.example')
let host: Awaited<ReturnType<typeof startHost>>
let rpc: Awaited<ReturnType<typeof startRpc>>

before(async () => {
  host = await startHost()
  rpc = await startRpc()
})
after(async () => {
  await host.close()
  await rpc.close()
})

const keys = () => [
  { key: listed.key, issuer: listed.name, label: 'face check', points: 1 },
  { key: other.key, issuer: 'someone.else.example', label: 'face check', points: 1 },
  { key: leaked.key, issuer: leaked.name, label: 'face check', points: 1, until: '2020-01-01T00:00:00Z' },
]

test('a profile counts only with a note proof that checks, for a listed key, under its name, for its own market and role', async () => {
  const good = await profile('tutoring/tutor', [listed])
  const changed = await profile('tutoring/tutor', [listed])
  changed.proofs[0]!.proof = changed.proofs[0]!.proof.slice(0, 40) + (changed.proofs[0]!.proof[40] === 'A' ? 'B' : 'A') + changed.proofs[0]!.proof.slice(41)
  const unlisted = await profile('tutoring/tutor', [issuer('unlisted.example')])
  const wrongName = await profile('tutoring/tutor', [other])
  const wrongLabel = await profile('tutoring/tutor')
  wrongLabel.proofs = (await profile('tutoring/student', [listed], wrongLabel.seed)).proofs
  const noMarket = await profile('knitting/maker', [listed])
  const noRole = await profile('tutoring/seller', [listed])
  const afterUntil = await profile('tutoring/tutor', [leaked])
  const all = { good, changed, unlisted, wrongName, wrongLabel, noMarket, noRole, afterUntil }
  for (const p of Object.values(all)) await publishProfile(host.url, p)

  const i = await index({ hosts: [host.url], keys: keys() }, rpc.url)
  await i.pass()
  const seen = async (p: typeof good) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body

  const counted = await seen(good)
  assert.deepEqual(counted.checks, [{ issuer: listed.name, key: listed.key, label: 'face check' }])
  assert.equal(counted.proofs[0]!.result, 'counts')
  assert.equal(i.store.db.prepare('select counted from profiles where address = ?').get(good.key.address)!.counted, 1)

  const why = async (p: typeof good) => {
    const o = await seen(p)
    assert.deepEqual(o.checks, [], p.label)
    return o.proofs[0]!.result
  }
  assert.equal(await why(changed), 'it does not check')
  assert.equal(await why(unlisted), 'its key is not one this index lists')
  assert.match(await why(wrongName), /^its issuer name is not someone\.else\.example/)
  assert.match(await why(wrongLabel), /^its label is not tutoring\/tutor/)
  assert.match(await why(noMarket), /knitting\/maker, are not a market and one of its roles in the directory/)
  assert.match(await why(noRole), /tutoring\/seller, are not a market and one of its roles/)
  assert.match(await why(afterUntil), /^this index first saw it after 2020-01-01T00:00:00.000Z/)

  // When it first saw each proof is kept, with its stamp.
  const seenRow = i.store.db.prepare('select stamp, first from seen where profile = ? and key = ?').get(good.key.address, listed.key)!
  assert.equal(seenRow.stamp, good.proofs[0]!.stamp)
  assert.ok(Number(seenRow.first) <= Date.now())
  await i.close()
})
