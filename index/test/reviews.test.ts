// Which reviews, vouches and reports count, and why the others do not, one from another market among
// them; each writer's word; a deleted post keeps its body, so a review's offer still finds it.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ProfilePage } from '../src/pages/profile.ts'
import { WHY, whyOf } from '../src/reviews.ts'
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

  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] }, rpc.url)
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

  // Three counted reviews from two writers: the count is the raters', and the student's two share
  // its one score's weight. Each writer's word about the tutor is a vouch, by rating it.
  const counted = t.reviews.received.filter((r) => r.counted)
  assert.equal(counted.length, 3)
  assert.equal(t.ratings.count, 2)
  assert.equal(got(student, 'second').weight, got(student, 'general').weight)
  assert.ok(t.ratings.value! >= 1 && t.ratings.value! <= 10)
  assert.deepEqual(t.words.received.map((w) => [w.writer, w.word]).sort(), [[another.key.address, 'vouch'], [student.key.address, 'vouch']].sort())

  // The post the reviews name is deleted, and kept with its body.
  assert.deepEqual(t.posts, [{ address: maths, body: { description: 'Maths, any level.', subjects: ['maths'] }, listed: false, why: 'deleted' }])
  await i.close()
})

test("vouches and reports: who counts, the latest per writer and subject, why the rest do not, and each writer's word", async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  const another = await profile('tutoring/student', [by])
  const stranger = await profile('tutoring/student')
  const coach = await profile('sports-coaching/coach', [by])
  for (const p of [tutor, student, another, stranger, coach]) await publishProfile(host.url, p)
  const about = (text?: string, more: { [key: string]: unknown } = {}) => ({ subject: tutor.key.address, ...(text && { text }), ...more })
  // In this order, each later than the one before: the student vouches, vouches again and then
  // reports; another reports, then rates.
  await post(host.url, [
    at(student, 'vouch/first', about('Real.')),
    at(student, 'vouch/second', about('Real and honest.')),
    at(student, 'report/scam', about('Took the money and left.')),
    at(another, 'report/early', about()),
    at(another, 'review/late', about(undefined, { score: '7' })),
    at(another, 'vouch/odd', about('Real.', { score: '9' })),
    at(stranger, 'vouch/maths', about()),
    at(coach, 'vouch/tutor', about()),
    at(tutor, 'vouch/me', about()),
  ])

  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] }, rpc.url)
  await i.pass()
  const page = async () => (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  let t = await page()
  const vouch = (p: typeof tutor, id: string) => t.vouches.received.find((r) => r.address === `${p.key.address}/vouch/${id}`)!
  const report = (p: typeof tutor, id: string) => t.reports.received.find((r) => r.address === `${p.key.address}/report/${id}`)!
  const vouchWhy = whyOf('vouch')

  assert.deepEqual([vouch(student, 'second').counted, vouch(student, 'first').counted, vouch(student, 'first').why], [true, false, vouchWhy.later])
  assert.equal(report(student, 'scam').counted, true)
  assert.equal(report(another, 'early').counted, true)
  assert.equal(vouch(another, 'odd').why, "the tutoring market's vouches hold no score")
  assert.equal(vouch(stranger, 'maths').why, vouchWhy.writer)
  assert.equal(vouch(coach, 'tutor').why, vouchWhy.market)
  assert.deepEqual([vouch(tutor, 'me').counted, vouch(tutor, 'me').why], [false, 'it is a vouch of its own writer'])
  assert.equal(t.vouches.given.length, 1)
  assert.equal((await twin<ProfilePage>(i, `/profiles/${student.key.address}.json`)).body.reports.given[0]!.address, `${student.key.address}/report/scam`)

  // The student's latest is a report; another's, a rating, so a vouch. Each weighs its giver's
  // uniqueness times trust: two faces no one has said a word about, 0.75 times 0.375.
  const words = () => new Map(t.words.received.map((w) => [w.writer, w]))
  assert.equal(words().get(student.key.address)!.word, 'report')
  assert.equal(words().get(another.key.address)!.word, 'vouch')
  for (const w of t.words.received) assert.equal(w.weight, 0.75 * 0.375)
  assert.equal(t.words.received.length, 2)
  const reported = t.trust
  assert.equal(t.uniqueness, 75)

  // The student takes the report down: its word is a vouch again, and the tutor's trust rises.
  await post(host.url, [at(student, 'report/scam', null)])
  await i.pass()
  t = await page()
  assert.equal(t.reports.received.filter((r) => r.writer === student.key.address).length, 0)
  assert.equal(words().get(student.key.address)!.word, 'vouch')
  assert.ok(t.trust > reported, `${t.trust} against ${reported}`)
  await i.close()
})
