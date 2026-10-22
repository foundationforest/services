// The tree: the served leaves rebuild the served root, which the index's key signed as the
// reputation client expects; a reputation proof made from those leaves shows on the profile that
// carries it, and not on another, nor once its root is past the newest `roots`.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { seedScalar, unpackSignature, verifyBytes } from '@foundationforest/keys'
import { toBytes32 } from '@foundationforest/note'
import { b64u, hex } from '@foundationforest/records'
import { buildTree, proofBytes, proveReputation, signedBytes } from '@foundationforest/reputation'

import type { ProfilePage } from '../src/pages/profile.ts'
import { at, index, issuer, post, profile, publishProfile, REPUTATION_FILES, startHost, startRpc, twin } from './world.ts'

const first = issuer('first.test.example')
const second = issuer('second.test.example')
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

type Served = { index: string; root: string; time: number; signature: string; leaves: number }
type Leaves = { root: string; leaves: Array<{ stamp: string; scope: string; score: number; count: number }> }

test('the tree, its signed root, and a reputation proof on a profile', async () => {
  const tutor = await profile('tutoring/tutor', [first, second])
  const student = await profile('tutoring/student', [first])
  const later = await profile('tutoring/student', [first])
  for (const p of [tutor, student, later]) await publishProfile(host.url, p)
  await post(host.url, [at(student, 'review/one', { subject: tutor.key.address, score: '9' })])

  const keys = [first, second].map((i) => ({ key: i.key, issuer: i.name, label: 'face check', points: 1 }))
  const i = await index({ hosts: [host.url], keys, roots: 1 }, rpc.url)
  assert.equal((await twin(i, '/v1/reputation')).status, 404)
  await i.pass()

  const served = (await twin<Served>(i, '/v1/reputation')).body
  const { leaves } = (await twin<Leaves>(i, '/v1/reputation/leaves')).body
  assert.equal(served.index, i.address)
  // One leaf per stamp: the tutor's two, one for each issuer; the student has no rating.
  assert.deepEqual(leaves.map((l) => l.stamp).sort(), tutor.proofs.map((p) => p.stamp).sort())
  assert.deepEqual(leaves.map((l) => [l.score, l.count]), [[90, 1], [90, 1]])
  const asLeaves = leaves.map((l) => ({ stamp: BigInt('0x' + l.stamp), scope: BigInt('0x' + l.scope), score: BigInt(l.score), count: BigInt(l.count) }))
  const root = buildTree(asLeaves).root
  assert.equal(hex.encode(toBytes32(root)), served.root)
  assert.ok(verifyBytes(i.address, signedBytes(root, served.time), unpackSignature(b64u.decode(served.signature))!))

  // A pass with nothing new keeps the root.
  await i.pass()
  assert.deepEqual((await twin<Served>(i, '/v1/reputation')).body, served)

  // The tutor proves its rating from the tree, on its own profile, and shows it; the student shows a copy.
  const r = await proveReputation({
    seedScalar: await seedScalar(tutor.seed),
    sources: [{ label: 'tutoring/tutor', issuerName: first.name }],
    leaves: asLeaves,
    profileLabel: 'tutoring/tutor',
    show: true,
    artifacts: REPUTATION_FILES,
  })
  const shown = { circuit: 'reputation', index: i.address, root: served.root, time: served.time, signature: served.signature, score: Number(r.score), label: 'tutoring/tutor', proof: b64u.encode(proofBytes(r.proof)) }
  const bytes = b64u.decode(shown.proof)
  bytes[10] ^= 1
  const changed = { ...shown, proof: b64u.encode(bytes) }
  await publishProfile(host.url, { ...tutor, proofs: [...tutor.proofs, shown, changed] as never })
  await publishProfile(host.url, { ...student, proofs: [...student.proofs, shown] as never })
  await i.pass()
  const results = async (p: typeof tutor) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body.proofs
  const t = await results(tutor)
  assert.deepEqual(t.map((x) => x.result), ['counts', 'counts', 'shown', 'it does not check'])
  assert.deepEqual({ ...t[2] }, { circuit: 'reputation', index: i.address, rating: 9, label: 'tutoring/tutor', time: served.time, result: 'shown' })
  assert.equal((await results(student))[1]!.result, 'it does not check')
  assert.deepEqual((await twin<Served>(i, '/v1/reputation')).body, served)

  // A new rating moves the tree; with roots at 1, the proof's root is past the newest.
  await post(host.url, [at(later, 'review/two', { subject: tutor.key.address, score: '5' })])
  await i.pass()
  assert.notEqual((await twin<Served>(i, '/v1/reputation')).body.root, served.root)
  assert.equal((await results(tutor))[2]!.result, "its root is not one of this index's newest 1")
  await i.close()
})
