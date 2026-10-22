// End to end, on loopback, over real HTTP: the standard's reference host; two profiles with real
// note proofs from a stand-in issuer key the index lists; an offer and a review; the index reading
// the host on its own schedule, counting the review, and serving the rating. Then `rebuild`: every
// table dropped but when each proof was first seen and the signed roots, read again, the same.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openStore } from '../src/store.ts'
import { at, index, issuer, post, profile, publishProfile, startHost, startRpc } from './world.ts'

test('a review between two checked profiles, read from a host, counted, and served', async () => {
  const host = await startHost()
  const rpc = await startRpc()
  const by = issuer()
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  await publishProfile(host.url, tutor)
  await publishProfile(host.url, student)
  const offer = `${tutor.key.address}/offer/maths`
  await post(host.url, [at(tutor, 'offer/maths', { description: 'Maths for secondary school, online.', subjects: ['maths'], levels: ['secondary'], place: { online: true }, price: { amount: '25', currency: 'USD', per: 'hour' } })])
  await post(host.url, [at(student, 'review/maths', { subject: tutor.key.address, score: '8.5', text: 'Patient and clear.', offer })])

  const keys = [{ key: by.key, issuer: by.name, label: 'face check', points: 1 }]
  // On its own schedule, a pass every second, as main.ts runs one every READ_SECONDS.
  const i = await index({ hosts: [host.url], keys }, rpc.url, { port: 0, readSeconds: 1 })
  const get = async <T>(path: string) => {
    const res = await fetch(`${i.url}${path}`)
    return { status: res.status, body: (await res.json()) as T }
  }
  type Profile = { checks: unknown[]; rating: { value: number | null; reviews: number; withPayment: number }; posts: Array<{ listed: boolean }> }
  let p: Profile | undefined
  for (const until = Date.now() + 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
    const got = await get<Profile>(`/profiles/${tutor.key.address}.json`)
    if (got.status === 200 && got.body.rating.reviews === 1) {
      p = got.body
      break
    }
  }
  assert.ok(p, 'the index served the rating within a minute')
  assert.deepEqual(p.checks, [{ issuer: by.name, key: by.key, label: 'face check' }])
  assert.deepEqual({ value: p.rating.value, reviews: p.rating.reviews, withPayment: p.rating.withPayment }, { value: 8.5, reviews: 1, withPayment: 0 })
  assert.equal(p.posts[0]!.listed, true)
  const found = (await get<{ total: number; results: Array<{ post: { address: string }; rating: { value: number } }> }>('/search.json?q=maths&market=tutoring&role=tutor')).body
  assert.equal(found.total, 1)
  assert.equal(found.results[0]!.post.address, offer)
  assert.equal(found.results[0]!.rating.value, 8.5)
  const html = await (await fetch(`${i.url}/profiles/${tutor.key.address}`)).text()
  assert.match(html, /8\.5 from 1 review, 0 with a payment/)
  const tree = (await get<{ root: string; leaves: number }>('/v1/reputation')).body
  assert.equal(tree.leaves, 1)
  const first = i.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first
  await i.close()

  // rebuild: drops what the hosts and the chain give back, keeps when each proof was first seen and every root.
  const store = openStore(i.dataDir)
  store.drop()
  assert.equal(store.db.prepare('select count(*) n from records').get()!.n, 0)
  store.close()
  const again = await index({ hosts: [host.url], keys }, rpc.url, { dataDir: i.dataDir })
  assert.equal(again.address, i.address)
  await again.pass()
  assert.equal(again.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first, first)
  assert.equal(again.store.db.prepare('select value from ratings where profile = ?').get(tutor.key.address)!.value, 8.5)
  assert.equal(again.store.db.prepare('select root from roots order by time desc limit 1').get()!.root, tree.root)
  await again.close()
  await host.close()
  await rpc.close()
})
