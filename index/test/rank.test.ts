// The ranking, on fixtures: one pure function, no database.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rank, type RankProfile, type RankReview } from '../src/rank.ts'

const numbers = { damping: 0.85, tolerance: 1e-9, maxRounds: 100, shrink: 3 }
const people = (n: number, market = 'tutoring', points = 1): RankProfile[] => Array.from({ length: n }, (_, i) => ({ address: `${market}-${i}`, market, points }))
const sum = (m: Map<string, number>, only?: string[]) => [...m].filter(([k]) => !only || only.includes(k)).reduce((a, [, v]) => a + v, 0)

test('a ring of ten profiles reviewing each other ends with at most ten points among them', () => {
  const ring = people(10)
  const reviews: RankReview[] = []
  for (const w of ring) for (const s of ring) if (w !== s) reviews.push({ writer: w.address, subject: s.address, score: 10, evidence: 1 })
  const r = rank(ring, reviews, numbers)
  assert.ok(sum(r.points) <= 10 + 1e-6, `${sum(r.points)}`)
  // A ring alone in a bigger crowd still ends with no more than it started with.
  const crowd = [...ring, ...people(5, 'cleaning', 2)]
  const r2 = rank(crowd, reviews, numbers)
  assert.ok(sum(r2.points, ring.map((p) => p.address)) <= 10 + 1e-6)
})

test('a writer of a hundred reviews passes a hundredth of its share to each', () => {
  const writer = { address: 'writer', market: 'tutoring', points: 1 }
  const subjects = people(100)
  const reviews = subjects.map((s) => ({ writer: 'writer', subject: s.address, score: 10, evidence: 1 }))
  const r = rank([writer, ...subjects], reviews, numbers)
  // Each subject keeps (1 - d) of its own point and gets d x 1 / 100 x 10/10 from the writer, who keeps (1 - d).
  for (const s of subjects) assert.ok(Math.abs(r.points.get(s.address)! - (0.15 + 0.85 * 0.15 / 100)) < 1e-9)
  // One review alone passes the whole share.
  const one = rank([writer, subjects[0]!], [reviews[0]!], numbers)
  assert.ok(Math.abs(one.points.get(subjects[0]!.address)! - (0.15 + 0.85 * 0.15)) < 1e-9)
})

test('scores and evidence scale what flows; the rating weighs each score by its writer\'s points times its evidence', () => {
  const [a, b, c] = [{ address: 'a', market: 'm', points: 2 }, { address: 'b', market: 'm', points: 1 }, { address: 'c', market: 'm', points: 1 }]
  const r = rank([a, b, c], [{ writer: 'a', subject: 'c', score: 9, evidence: 1 }, { writer: 'b', subject: 'c', score: 3, evidence: 1 }], numbers)
  const pa = r.points.get('a')!
  const pb = r.points.get('b')!
  assert.ok(Math.abs(r.ratings.get('c')!.value! - (pa * 9 + pb * 3) / (pa + pb)) < 1e-12)
  assert.equal(r.ratings.get('c')!.reviews, 2)
  assert.deepEqual(r.weights, [pa, pb])
  assert.equal(r.ratings.get('a')!.value, null)

  const half = rank([a, b, c], [{ writer: 'a', subject: 'c', score: 9, evidence: 0.5 }, { writer: 'b', subject: 'c', score: 3, evidence: 1 }], numbers)
  assert.ok(Math.abs(half.ratings.get('c')!.value! - (half.points.get('a')! * 0.5 * 9 + half.points.get('b')! * 3) / (half.points.get('a')! * 0.5 + half.points.get('b')!)) < 1e-12)
  assert.ok(half.points.get('c')! < r.points.get('c')!)
})

test('the shrunk rating pulls a rating with little weight toward its market\'s mean rating, m = 3', () => {
  const ps = [...people(3), { address: 'new', market: 'tutoring', points: 1 }, { address: 'elsewhere', market: 'cleaning', points: 1 }]
  const reviews = [
    { writer: 'tutoring-0', subject: 'tutoring-1', score: 10, evidence: 1 },
    { writer: 'tutoring-1', subject: 'tutoring-2', score: 4, evidence: 1 },
  ]
  const r = rank(ps, reviews, numbers)
  const one = r.ratings.get('tutoring-1')!
  const two = r.ratings.get('tutoring-2')!
  const mean = (one.value! + two.value!) / 2
  assert.ok(Math.abs(one.shrunk! - (one.weight * one.value! + 3 * mean) / (one.weight + 3)) < 1e-12)
  // No reviews: the market's mean. A market with no rating: none.
  assert.ok(Math.abs(r.ratings.get('new')!.shrunk! - mean) < 1e-12)
  assert.equal(r.ratings.get('elsewhere')!.shrunk, null)
})

test('it stops at the tolerance, or after maxRounds; a review of oneself or by a profile not given does not count', () => {
  const ps = people(3)
  const reviews = [
    { writer: 'tutoring-0', subject: 'tutoring-1', score: 8, evidence: 1 },
    { writer: 'tutoring-1', subject: 'tutoring-0', score: 8, evidence: 1 },
    { writer: 'tutoring-2', subject: 'tutoring-2', score: 10, evidence: 1 },
    { writer: 'nobody', subject: 'tutoring-2', score: 10, evidence: 1 },
  ]
  const r = rank(ps, reviews, numbers)
  assert.ok(r.rounds > 1 && r.rounds < 100)
  assert.equal(rank(ps, reviews, { ...numbers, maxRounds: 3 }).rounds, 3)
  assert.equal(r.ratings.get('tutoring-2')!.reviews, 0)
  // Nothing flows to it, so it keeps (1 - d) of its starting points.
  assert.ok(Math.abs(r.points.get('tutoring-2')! - 0.15) < 1e-12)
  assert.deepEqual(r.weights.slice(2), [0, 0])
})
