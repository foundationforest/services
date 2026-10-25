// The ranking, on fixtures: one pure function for one market, no database, with this index's own
// numbers (config/scoring.json). Every profile here is a face check's, 1 point, so each starts with
// (1 - alpha) of a point, 0.4.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { type Numbers, rank, type RankProfile, type RankReview } from '../src/rank.ts'

const numbers = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8')) as Numbers
const face = (address: string): RankProfile => ({ address, points: 1 })
const review = (writer: string, subject: string, score: number, evidence = 1): RankReview => ({ writer, subject, score, evidence })
const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within
const tenth = (v: number) => Math.round(v * 10) / 10

/** Ten faces all rating each other 10. */
function ring(): { profiles: RankProfile[]; reviews: RankReview[] } {
  const profiles = Array.from({ length: 10 }, (_, i) => face(`ring-${i}`))
  return { profiles, reviews: profiles.flatMap((w) => profiles.filter((s) => s !== w).map((s) => review(w.address, s.address, 10))) }
}

test("a ring of ten faces rating each other 10 ends each with a backing below 1 and a rating within 1 of its market's baseline", () => {
  const { profiles, reviews } = ring()
  const r = rank(profiles, reviews, numbers)
  for (const p of profiles) {
    const rating = r.ratings.get(p.address)!
    assert.equal(rating.reviews, 9)
    assert.ok(rating.backing < 1, `${rating.backing}`)
    assert.ok(Math.abs(rating.value! - r.baseline) < 1, `${rating.value} against ${r.baseline}`)
  }
  // The baseline weighs each score by its writer's weight: the ring's ninety scores of 10 move it
  // only as far as the trust behind them, not to their plain mean with mu0's five, 9.87.
  assert.ok(r.baseline < 9, `${r.baseline}`)
})

test('a star of five puppets, each writing only one review, gives its boss about 0.67 backing', () => {
  const puppets = Array.from({ length: 5 }, (_, i) => face(`puppet-${i}`))
  const r = rank([face('boss'), ...puppets], puppets.map((p) => review(p.address, 'boss', 10)), numbers)
  // Each puppet passes its 0.4 over its one review and sink: 0.4 / 3 each.
  assert.ok(near(r.ratings.get('boss')!.backing, 2 / 3, 0.005), `${r.ratings.get('boss')!.backing}`)
})

test("one face's two roles rating each other give each about 0.13 backing", () => {
  const r = rank([face('tutor'), face('student')], [review('tutor', 'student', 10), review('student', 'tutor', 10)], numbers)
  for (const p of ['tutor', 'student']) assert.ok(near(r.ratings.get(p)!.backing, 0.4 / 3, 1e-12), `${r.ratings.get(p)!.backing}`)
})

test('mutual reviews pass no trust back and forth; trust from a third profile passes on', () => {
  const one = rank([face('a'), face('b')], [review('a', 'b', 10)], numbers)
  const both = rank([face('a'), face('b')], [review('a', 'b', 10), review('b', 'a', 10)], numbers)
  // b's review gives a trust, and none of it comes back to b.
  assert.ok(both.trust.get('a')! > one.trust.get('a')!)
  assert.ok(near(both.ratings.get('b')!.backing, one.ratings.get('b')!.backing, 1e-12))
  // c's review of a gives a trust that a passes on to b.
  const passed = rank([face('a'), face('b'), face('c')], [review('a', 'b', 10), review('b', 'a', 10), review('c', 'a', 10)], numbers)
  assert.ok(passed.ratings.get('b')!.backing > both.ratings.get('b')!.backing)
})

test('an honest provider rated by active, rated writers outranks a ring of ten in its market', () => {
  // Ten customers, as many writers as the ring has members, each rating the provider 9 and four other
  // providers 5, 6, 7 and 8, and each rated 9 by those four in turn.
  const { profiles, reviews } = ring()
  const customers = Array.from({ length: 10 }, (_, i) => face(`customer-${i}`))
  const others = [5, 6, 7, 8]
  for (const c of customers) {
    reviews.push(review(c.address, 'provider', 9))
    others.forEach((score, i) => reviews.push(review(c.address, `other-${i}`, score), review(`other-${i}`, c.address, 9)))
  }
  const r = rank([...profiles, face('provider'), ...others.map((_, i) => face(`other-${i}`)), ...customers], reviews, numbers)
  const provider = r.ratings.get('provider')!
  for (const p of profiles) {
    const member = r.ratings.get(p.address)!
    assert.ok(provider.value! > member.value!, `${provider.value} against ${member.value}`)
    // As the pages show and sort it too: one decimal.
    assert.ok(tenth(provider.value!) > tenth(member.value!), `${provider.value} against ${member.value}`)
    assert.ok(provider.backing > member.backing)
  }
})

test('a 9.5 from a writer averaging 6.5 weighs more in the rating than a 10 from a writer averaging 10', () => {
  // Two writers of equal trust and three reviews each: one gives x 9.5 and two others 5, the other gives y 10 and the same two 10.
  const profiles = ['harsh', 'easy', 'x', 'y', 'm', 'n'].map(face)
  const reviews = [review('harsh', 'x', 9.5), review('harsh', 'm', 5), review('harsh', 'n', 5), review('easy', 'y', 10), review('easy', 'm', 10), review('easy', 'n', 10)]
  const r = rank(profiles, reviews, numbers)
  const [x, y] = [r.ratings.get('x')!, r.ratings.get('y')!]
  assert.equal(x.backing, y.backing)
  assert.ok(x.value! > y.value!, `${x.value} against ${y.value}`)
})

test("a writer's reviews of one profile are one score, their mean; the review count is how many writers; each review weighs its share", () => {
  const profiles = [face('w'), face('v'), face('s')]
  const r = rank(profiles, [review('w', 's', 10), review('w', 's', 6), review('v', 's', 8)], numbers)
  const s = r.ratings.get('s')!
  assert.equal(s.reviews, 2)
  // w reviewed one profile, so its two reviews share its 0.4 / 3, and the backing is every review's weight.
  assert.equal(r.weights[0], r.weights[1])
  assert.ok(near(r.weights[0]! + r.weights[1]!, 0.4 / 3, 1e-12))
  assert.ok(near(s.backing, r.weights.reduce((a, b) => a + b, 0), 1e-12))
  // The same as one review of 8 from w.
  const mean = rank(profiles, [review('w', 's', 8), review('v', 's', 8)], numbers)
  assert.ok(near(s.value!, mean.ratings.get('s')!.value!, 1e-12))
})

test('the evidence factor scales a writer\'s weight, and a writer and subject take the largest of their reviews\'', () => {
  const two = [face('w'), face('s')]
  const full = rank(two, [review('w', 's', 9, 1)], numbers).ratings.get('s')!.backing
  assert.ok(near(rank(two, [review('w', 's', 9, 0.5)], numbers).ratings.get('s')!.backing, full / 2, 1e-12))
  assert.ok(near(rank(two, [review('w', 's', 9, 0.5), review('w', 's', 9, 1)], numbers).ratings.get('s')!.backing, full, 1e-12))
})

test('a profile no counted review is about has no rating; a review of oneself, or by or of a profile not given, counts for nothing', () => {
  const r = rank([face('a'), face('b')], [review('a', 'a', 10), review('nobody', 'b', 10), review('a', 'nobody', 10)], numbers)
  assert.deepEqual(r.ratings.get('a'), { value: null, backing: 0, reviews: 0 })
  assert.deepEqual(r.ratings.get('b'), { value: null, backing: 0, reviews: 0 })
  assert.deepEqual(r.weights, [0, 0, 0])
  // With no score at all, the baseline is mu0.
  assert.equal(r.baseline, numbers.mu0)
  assert.equal(r.trust.get('a'), 0.4)
})
