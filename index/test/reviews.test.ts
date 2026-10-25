// Which reviews count, and why the others do not, a review from another market among them; a
// deleted post keeps its body, so a review's offer still finds it.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ProfilePage } from '../src/pages/profile.ts'
import { WHY } from '../src/reviews.ts'
import { at, index, verifier, post, profile, publishProfile, startHost, startRpc, twin } from './world.ts'

const by = verifier()
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

test('reviews: who counts, the latest per writer, subject and post, and why the rest do not', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  const another = await profile('tutoring/student', [by])
  const stranger = await profile('tutoring/student')
  const coach = await profile('sports-coaching/coach', [by])
  for (const p of [tutor, student, another, stranger, coach]) await publishProfile(host.url, p)
  const maths = `${tutor.key.address}/offer/maths`
  await post(host.url, [at(tutor, 'offer/maths', { description: 'Maths, any level.', subjects: ['maths'] })])

  const review = (subject: string, score: string | undefined, more: { [key: string]: unknown } = {}) => ({ subject, ...(score && { score }), ...more })
  await post(host.url, [
    at(student, 'review/first', review(tutor.key.address, '4', { offer: maths })),
    at(student, 'review/second', review(tutor.key.address, '9', { offer: maths, text: 'Clear and patient.' })),
    at(student, 'review/general', review(tutor.key.address, '8')),
    at(another, 'review/maths', review(tutor.key.address, '10', { offer: maths })),
    at(another, 'review/bare', review(tutor.key.address, undefined)),
    at(another, 'review/odd', review(tutor.key.address, '7', { stars: '5' })),
    at(stranger, 'review/maths', review(tutor.key.address, '1', { offer: maths })),
    at(tutor, 'review/me', review(tutor.key.address, '10')),
    at(student, 'review/stranger', review(stranger.key.address, '6')),
    at(coach, 'review/tutor', review(tutor.key.address, '9')),
  ])
  // The tutor takes the post down; it stays here with its last body.
  await post(host.url, [at(tutor, 'offer/maths', null)])

  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', points: 1 }] }, rpc.url)
  await i.pass()
  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  const received = new Map(t.reviews.received.map((r) => [r.address, r]))
  const got = (p: typeof tutor, id: string) => received.get(`${p.key.address}/review/${id}`)!

  assert.equal(got(student, 'second').counted, true)
  assert.equal(got(student, 'general').counted, true)
  assert.equal(got(another, 'maths').counted, true)
  assert.deepEqual([got(student, 'first').counted, got(student, 'first').why], [false, WHY.later])
  assert.deepEqual([got(another, 'bare').counted, got(another, 'bare').why], [false, WHY.score])
  assert.match(got(another, 'odd').why!, /^it has a field the tutoring market does not name: stars/)
  assert.deepEqual([got(stranger, 'maths').counted, got(stranger, 'maths').why], [false, WHY.writer])
  assert.deepEqual([got(tutor, 'me').counted, got(tutor, 'me').why], [false, WHY.itself])
  assert.deepEqual([got(coach, 'tutor').counted, got(coach, 'tutor').why], [false, WHY.market])
  for (const r of t.reviews.received) {
    assert.equal(r.evidence, 'without')
    if (!r.counted) assert.equal(r.weight, 0)
  }

  const s = (await twin<ProfilePage>(i, `/profiles/${student.key.address}.json`)).body
  assert.equal(s.reviews.given.find((r) => r.address.endsWith('/review/stranger'))!.why, WHY.subject)

  // Three counted reviews from two writers: the review count is the writers', and the backing is
  // the sum of the reviews' weights, the student's two sharing its one weight.
  const counted = t.reviews.received.filter((r) => r.counted)
  assert.equal(counted.length, 3)
  assert.equal(t.rating.reviews, 2)
  assert.equal(got(student, 'second').weight, got(student, 'general').weight)
  assert.equal(t.rating.backing, Math.round(counted.reduce((a, r) => a + r.weight, 0) * 10) / 10)
  assert.ok(t.rating.value! >= 1 && t.rating.value! <= 10)

  // The post the reviews name is deleted, and kept with its body.
  assert.deepEqual(t.posts, [{ address: maths, body: { description: 'Maths, any level.', subjects: ['maths'] }, listed: false, why: 'deleted' }])
  await i.close()
})
