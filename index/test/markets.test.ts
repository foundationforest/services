// The markets: read from the pinned checkout; a post that does not fit its market is kept, not
// listed, and says why; the escrow this index reads is the one the pinned standard records.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ESCROW_PROGRAM } from '../src/chain.ts'
import { loadMarkets } from '../src/markets.ts'
import type { MarketPage } from '../src/pages/market.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
import { at, index, issuer, MARKETS, post, profile, publishProfile, STANDARD, startHost, startRpc, twin } from './world.ts'

test('the escrow this index reads is the program the pinned standard records', () => {
  const record = JSON.parse(readFileSync(join(STANDARD, 'escrows/solana/devnet/devnet.json'), 'utf8')) as { escrow: { programId: string } }
  assert.equal(ESCROW_PROGRAM, record.escrow.programId)
})

test("each market's check reads its file: fields, choices, lists, roles", () => {
  const m = loadMarkets(MARKETS)
  assert.deepEqual(
    m.list.map((x) => x.name),
    (JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string }> }).markets.map((x) => x.name),
  )
  const place = { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid' }
  assert.equal(m.checkPost('tutoring', 'tutor', { description: 'Maths', price: { amount: '30', currency: 'USD', per: 'hour' }, subjects: ['maths'], place }), null)
  assert.match(m.checkPost('tutoring', 'tutor', { description: 'Maths', colour: 'red' })!, /does not name: colour/)
  assert.match(m.checkPost('tutoring', 'tutor', { subjects: ['knitting'] })!, /its subjects is not a list of choice/)
  assert.match(m.checkPost('tutoring', 'tutor', { subjects: ['maths', 'maths'] })!, /its subjects is not a list of choice/)
  assert.match(m.checkPost('tutoring', 'tutor', { price: { amount: 30, currency: 'USD' } })!, /its price is not a money/)
  assert.match(m.checkPost('electronics', 'buyer', { photos: [] })!, /photos is a field for seller/)
  assert.equal(m.checkPost('electronics', 'seller', { photos: [] }), null)
  assert.match(m.checkPost('tutoring', 'seller', {})!, /seller is not a role in the tutoring market/)
  assert.match(m.checkPost('knitting', 'maker', {})!, /knitting is not a market/)
  assert.equal(m.checkReview('tennis-matches', 'player', { subject: '9bpPbLYCPwNWq9BZqnJr3EqRNqymFZ4g58Zk9K86azDC', score: '8.5', showedUp: 'yes' }), null)
  assert.match(m.checkReview('tennis-matches', 'player', { subject: '9bpPbLYCPwNWq9BZqnJr3EqRNqymFZ4g58Zk9K86azDC', evidence: 'x' })!, /reviews hold no evidence/)
  assert.match(m.checkReview('tutoring', null, { subject: '9bpPbLYCPwNWq9BZqnJr3EqRNqymFZ4g58Zk9K86azDC', score: '11' })!, /score is not "1" to "10"/)
  assert.match(m.checkReview('tutoring', null, { subject: '9bpPbLYCPwNWq9BZqnJr3EqRNqymFZ4g58Zk9K86azDC', offer: 'maths' })!, /offer is not a post's address/)
})

const by = issuer()
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

test('a post that does not fit its market is kept, not listed, and its profile page says why', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  for (const p of [tutor, student]) await publishProfile(host.url, p)
  await post(host.url, [
    at(tutor, 'offer/good', { description: 'Maths, any level.', subjects: ['maths'] }),
    at(tutor, 'offer/odd', { description: 'Maths.', colour: 'red' }),
    at(student, 'offer/physics', { description: 'Help with physics, please.', subjects: ['physics'] }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, issuer: by.name, label: 'face check', points: 1 }] }, rpc.url)
  await i.pass()

  const m = (await twin<MarketPage>(i, '/markets/tutoring.json')).body
  assert.deepEqual(Object.keys(m.posts), ['tutor', 'student'])
  assert.deepEqual(m.posts.tutor!.map((r) => r.post.address), [`${tutor.key.address}/offer/good`])
  assert.deepEqual(m.posts.student!.map((r) => r.post.address), [`${student.key.address}/offer/physics`])

  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  const odd = t.posts.find((p) => p.address.endsWith('/offer/odd'))!
  assert.equal(odd.listed, false)
  assert.equal(odd.why, 'it has a field the tutoring market does not name: colour')
  assert.deepEqual(odd.body, { description: 'Maths.', colour: 'red' })
  assert.equal(t.posts.find((p) => p.address.endsWith('/offer/good'))!.listed, true)
  assert.equal('why' in t.posts.find((p) => p.address.endsWith('/offer/good'))!, false)
  await i.close()
})
