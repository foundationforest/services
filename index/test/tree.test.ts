// The tree: the served leaves, each carrying its rating and its backing times ten, rebuild the
// served root, which the index's key signed as the reputation client expects; a reputation proof
// made from those leaves shows on the profile that carries it, and not on another, nor against a
// root this index signed more than maxAgeDays ago, unless it is the newest.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { checkBytes, seedScalar, unpackSignature } from '@foundationforest/keys'
import { b64u, hex } from '@foundationforest/records'
import { buildTree, proofBytes, proveReputation, signedBytes } from '@foundationforest/reputation'
import { toBytes32 } from '@foundationforest/stamp'

import type { ProfilePage } from '../src/pages/profile.ts'
import { at, index, verifier, post, profile, publishProfile, REPUTATION_FILES, startHost, startRpc, twin } from './world.ts'

const first = verifier('first.test.example')
const second = verifier('second.test.example')
const DAY = 24 * 60 * 60 * 1000
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
type Leaves = { root: string; leaves: Array<{ tag: string; scope: string; score: number; count: number }> }

test('the tree, its signed root, and a reputation proof on a profile, by its root\'s age', async () => {
  const tutor = await profile('tutoring/tutor', [first, second])
  const students = [await profile('tutoring/student', [first]), await profile('tutoring/student', [first]), await profile('tutoring/student', [first])]
  const later = await profile('tutoring/student', [first])
  for (const p of [tutor, ...students, later]) await publishProfile(host.url, p)
  await post(host.url, students.map((s) => at(s, 'review/one', { subject: tutor.key.address, score: '9' })))

  const keys = [first, second].map((v) => ({ key: v.key, verifier: v.name, label: 'face check', points: 1 }))
  let clock = Date.now()
  const i = await index({ hosts: [host.url], keys }, rpc.url, { now: () => clock })
  assert.equal((await twin(i, '/v1/reputation')).status, 404)
  await i.pass()

  const served = (await twin<Served>(i, '/v1/reputation')).body
  const { leaves } = (await twin<Leaves>(i, '/v1/reputation/leaves')).body
  assert.equal(served.index, i.address)
  // One leaf per tag: the tutor's two, one for each verifier; the students have no rating. Each
  // carries the tutor's rating and backing times ten: three writers' backing, more than one review's.
  assert.deepEqual(leaves.map((l) => l.tag).sort(), tutor.proofs.map((p) => p.tag).sort())
  const rating = async () => (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body.rating
  const { value, backing } = await rating()
  assert.ok(Math.round(backing * 10) > 1, `${backing}`)
  assert.deepEqual(leaves.map((l) => [l.score, l.count]), [0, 1].map(() => [Math.round(value! * 10), Math.round(backing * 10)]))
  const asLeaves = (ls: Leaves['leaves']) => ls.map((l) => ({ tag: BigInt('0x' + l.tag), scope: BigInt('0x' + l.scope), score: BigInt(l.score), count: BigInt(l.count) }))
  const root = buildTree(asLeaves(leaves)).root
  assert.equal(hex.encode(toBytes32(root)), served.root)
  assert.ok(checkBytes(i.address, signedBytes(root, served.time), unpackSignature(b64u.decode(served.signature))!))

  // A pass with nothing new keeps the root.
  await i.pass()
  assert.deepEqual((await twin<Served>(i, '/v1/reputation')).body, served)

  // The tutor proves its rating from the tree, on its own profile, and shows it; a student shows a copy.
  const prove = async (ls: Leaves['leaves'], against: Served) => {
    const r = await proveReputation({
      seedScalar: await seedScalar(tutor.seed),
      sources: [{ label: 'tutoring/tutor', verifierName: first.name }],
      leaves: asLeaves(ls),
      profileLabel: 'tutoring/tutor',
      show: true,
      artifacts: REPUTATION_FILES,
    })
    return { circuit: 'reputation', index: i.address, root: against.root, time: against.time, signature: against.signature, score: Number(r.score), label: 'tutoring/tutor', proof: b64u.encode(proofBytes(r.proof)) }
  }
  const shown = await prove(leaves, served)
  const bytes = b64u.decode(shown.proof)
  bytes[10] ^= 1
  const changed = { ...shown, proof: b64u.encode(bytes) }
  await publishProfile(host.url, { ...tutor, proofs: [...tutor.proofs, shown, changed] as never })
  await publishProfile(host.url, { ...students[0]!, proofs: [...students[0]!.proofs, shown] as never })
  clock = Date.now()
  await i.pass()
  const results = async (p: typeof tutor) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body.proofs
  const t = await results(tutor)
  assert.deepEqual(t.map((x) => x.result), ['counts', 'counts', 'shown', 'it does not check'])
  assert.deepEqual({ ...t[2] }, { circuit: 'reputation', index: i.address, rating: value, label: 'tutoring/tutor', time: served.time, result: 'shown' })
  assert.equal((await results(students[0]!))[1]!.result, 'it does not check')
  assert.deepEqual((await twin<Served>(i, '/v1/reputation')).body, served)

  // A new rating moves the tree a day on; the proof's root, no longer the newest, shows while this
  // index signed it within 30 days: 29 days on it does, 31 days on it does not.
  await post(host.url, [at(later, 'review/two', { subject: tutor.key.address, score: '5' })])
  clock = served.time + DAY
  await i.pass()
  const moved = (await twin<Served>(i, '/v1/reputation')).body
  assert.notEqual(moved.root, served.root)
  for (const [days, result] of [[29, 'shown'], [31, "its root is neither this index's newest nor one it signed in the last 30 days"]] as const) {
    clock = served.time + days * DAY
    await i.pass()
    assert.equal((await results(tutor))[2]!.result, result, `${days} days on`)
  }

  // A proof against the newest root shows however old the root is: the tree has not moved since.
  const newest = await prove((await twin<Leaves>(i, '/v1/reputation/leaves')).body.leaves, moved)
  await publishProfile(host.url, { ...tutor, proofs: [...tutor.proofs, shown, newest] as never })
  clock = moved.time + 40 * DAY
  await i.pass()
  assert.deepEqual((await results(tutor)).map((x) => x.result).slice(2), ["its root is neither this index's newest nor one it signed in the last 30 days", 'shown'])
  assert.equal((await twin<Served>(i, '/v1/reputation')).body.root, moved.root)
  await i.close()
})
