// The ranking, on fixtures: pure functions for one market, no database, with this index's own
// numbers (config/scoring.json). Each part is tested on its own, then what rank() makes of them
// together: the guarantees README.md, How it scores, says the ranking keeps.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  type Numbers,
  pickinessWord,
  rank,
  type RankProfile,
  type RankRating,
  reportPart,
  type Said,
  scoreWeight,
  searchOrder,
  trustOf,
  uniqueness,
  vouchPart,
  wordsOf,
} from '../src/rank.ts'

const numbers = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8')) as Numbers
const FACE = 0.75
const ID = 0.95
const face = (address: string): RankProfile => ({ address, uniqueness: FACE })
const near = (a: number, b: number, within = 1e-9) => Math.abs(a - b) <= within

let clock = 0
const rating = (writer: string, subject: string, score: number, evidence = 1): RankRating => ({ writer, subject, score, evidence })
const said = (writer: string, subject: string, kind: Said['kind']): Said => ({ writer, subject, kind, time: ++clock, address: `${writer}/${kind}/${clock}` })
/** Ratings, each also said as a rating, for its writer's word. */
const rated = (...ratings: RankRating[]) => ({ ratings, said: ratings.map((r) => said(r.writer, r.subject, 'rating')) })

test("uniqueness: the chance at least one check holds; a face check's 0.75, with an ID check's 0.9875", () => {
  assert.equal(uniqueness([]), 0)
  assert.equal(uniqueness([FACE]), FACE)
  assert.ok(near(uniqueness([FACE, ID]), 1 - 0.25 * 0.05))
})

test("a newcomer's trust is half its uniqueness", () => {
  const r = rank([face('new'), { address: 'both', uniqueness: uniqueness([FACE, ID]) }], [], [], numbers)
  assert.equal(r.trust.get('new'), FACE / 2)
  assert.ok(near(r.trust.get('both')!, uniqueness([FACE, ID]) / 2))
  assert.equal(r.pickiness.get('new'), 0.5)
  assert.equal(pickinessWord(r.pickiness.get('new')!, numbers), 'average')
})

test('one full vouch closes half the gap to uniqueness, and each more closes half of what is left; never all of it', () => {
  assert.equal(vouchPart(0, numbers), 0.5)
  assert.equal(vouchPart(1, numbers), 0.75)
  assert.equal(vouchPart(2, numbers), 0.875)
  assert.ok(vouchPart(40, numbers) < 1)
  assert.equal(trustOf(FACE, vouchPart(1, numbers), 1), FACE / 2 + (FACE - FACE / 2) / 2)
  // rank() puts them together: a vouch weighs its giver's uniqueness times trust.
  const r = rank([face('giver'), face('x')], [], [said('giver', 'x', 'vouch')], numbers)
  const [word] = r.words
  assert.deepEqual({ ...word, weight: undefined }, { writer: 'giver', subject: 'x', word: 'vouch', weight: undefined })
  assert.equal(word!.weight, FACE * (FACE / 2))
  assert.ok(near(r.trust.get('x')!, trustOf(FACE, vouchPart(word!.weight, numbers), 1)))
})

test('one full report cuts trust to a quarter', () => {
  assert.equal(reportPart(0, numbers), 1)
  assert.equal(reportPart(1, numbers), 0.25)
  assert.equal(trustOf(FACE, vouchPart(0, numbers), reportPart(1, numbers)), FACE / 2 / 4)
  const r = rank([face('reporter'), face('x')], [], [said('reporter', 'x', 'report')], numbers)
  assert.ok(near(r.trust.get('x')!, (FACE / 2) * reportPart(FACE * (FACE / 2), numbers)))
})

test('the vouch part and the report part each change without touching the other', () => {
  const profiles = [face('voucher'), face('reporter'), face('x')]
  const nothing = rank(profiles, [], [], numbers).trust.get('x')!
  const vouched = rank(profiles, [], [said('voucher', 'x', 'vouch')], numbers).trust.get('x')!
  const reported = rank(profiles, [], [said('reporter', 'x', 'report')], numbers).trust.get('x')!
  const both = rank(profiles, [], [said('voucher', 'x', 'vouch'), said('reporter', 'x', 'report')], numbers).trust.get('x')!
  // A report scales trust by the same part with or without the vouch, and the vouch by the same
  // part with or without the report.
  assert.ok(near(both / vouched, reported / nothing))
  assert.ok(near(both / reported, vouched / nothing))
  assert.ok(vouched > nothing && reported < nothing)
})

test('trust never passes uniqueness, a self-vouching ring included', () => {
  const ring = Array.from({ length: 10 }, (_, i) => ({ address: `ring-${i}`, uniqueness: 1 }))
  const { ratings, said: saidRing } = rated(...ring.flatMap((w) => ring.filter((s) => s !== w).map((s) => rating(w.address, s.address, 10))))
  const r = rank(ring, ratings, [...saidRing, ...ring.flatMap((w) => ring.filter((s) => s !== w).map((s) => said(w.address, s.address, 'vouch')))], numbers)
  assert.ok(r.rounds < numbers.maxRounds)
  for (const p of ring) {
    const t = r.trust.get(p.address)!
    assert.ok(t > 0.9 && t < p.uniqueness, `${t}`)
    // Shown as a whole number from 0 to 100, it may round up to its uniqueness, never past it.
    assert.ok(Math.round(t * 100) <= Math.round(p.uniqueness * 100))
  }
  // And on random graphs of ratings, vouches and reports, by a seeded generator.
  let seed = 11
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let g = 0; g < 40; g++) {
    const profiles = Array.from({ length: 3 + Math.floor(random() * 15) }, (_, i) => ({ address: `p${i}`, uniqueness: [FACE, ID, uniqueness([FACE, ID])][Math.floor(random() * 3)]! }))
    const ratings: RankRating[] = []
    const words: Said[] = []
    for (const w of profiles) {
      for (const s of profiles) {
        const roll = random()
        if (w === s || roll > 0.5) continue
        if (roll < 0.25) ratings.push(rating(w.address, s.address, 1 + Math.floor(random() * 10))), words.push(said(w.address, s.address, 'rating'))
        else words.push(said(w.address, s.address, roll < 0.38 ? 'vouch' : 'report'))
      }
    }
    const out = rank(profiles, ratings, words, numbers)
    assert.ok(out.rounds < numbers.maxRounds, `graph ${g} settled`)
    for (const p of profiles) assert.ok(out.trust.get(p.address)! <= p.uniqueness, `graph ${g}`)
  }
})

test('reports that push trust both ways still settle: thirty profiles all reporting each other', () => {
  // Moved the whole way each round, these flip for ever: trust high, so heavy reports, so trust
  // low, so light reports. Moving half as far once the biggest move stops shrinking, they settle
  // where trust equals what the reports leave of it.
  const ring = Array.from({ length: 30 }, (_, i) => ({ address: `r${i}`, uniqueness: 1 }))
  const r = rank(ring, [], ring.flatMap((w) => ring.filter((s) => s !== w).map((s) => said(w.address, s.address, 'report'))), numbers)
  assert.ok(r.rounds < numbers.maxRounds, `${r.rounds}`)
  const t = r.trust.get('r0')!
  for (const p of ring) assert.ok(near(r.trust.get(p.address)!, t, 1e-7))
  assert.ok(near(t, trustOf(1, vouchPart(0, numbers), reportPart(29 * t, numbers)), 1e-7), `${t}`)
})

test("a rater who gives 1s to well-rated places counts less on low scores than a neutral rater", () => {
  // Three places, each rated 10 by three raters; the harsh rater gives each a 1. Then the harsh
  // rater and a neutral one, who has scored nothing else, each give the target a 1. Neither has
  // received a word, so both have the same trust.
  const places = ['p1', 'p2', 'p3']
  const fans = ['f1', 'f2', 'f3']
  const { ratings, said: words } = rated(
    ...places.flatMap((p) => fans.map((f) => rating(f, p, 10))),
    ...places.map((p) => rating('harsh', p, 1)),
    rating('harsh', 'target', 1),
    rating('neutral', 'target', 1),
  )
  const r = rank([...places, ...fans, 'harsh', 'neutral', 'target'].map(face), ratings, words, numbers)
  assert.equal(r.trust.get('harsh'), r.trust.get('neutral'))
  assert.ok(r.pickiness.get('harsh')! > 0.5)
  assert.equal(pickinessWord(r.pickiness.get('harsh')!, numbers), 'tough')
  assert.equal(r.pickiness.get('neutral'), 0.5)
  const weightOf = (writer: string) => r.weights[ratings.findIndex((x) => x.writer === writer && x.subject === 'target')]!
  assert.ok(weightOf('harsh') < weightOf('neutral'), `${weightOf('harsh')} against ${weightOf('neutral')}`)
  // As the part says: a 1 is 0 on 0 to 1, so it weighs 1 - P.
  assert.ok(near(weightOf('harsh') / weightOf('neutral'), scoreWeight(0, r.pickiness.get('harsh')!) / scoreWeight(0, 0.5)))
})

test("words: each writer's one word, by its latest counted record: a report, or else a vouch, a rating of 1 among them", () => {
  const word = (...kinds: Said['kind'][]) => wordsOf(kinds.map((k) => said('w', 's', k)))[0]!.word
  assert.equal(word('rating', 'report'), 'report')
  assert.equal(word('report', 'rating'), 'vouch')
  assert.equal(word('vouch', 'report', 'vouch'), 'vouch')
  assert.equal(word('report'), 'report')
  // Two writers, two words; a word about its own writer, or by or about a profile not given, is
  // none.
  const r = rank([face('a'), face('b')], [rating('a', 'b', 1)], [said('a', 'b', 'rating'), said('b', 'a', 'report'), said('a', 'a', 'vouch'), said('nobody', 'a', 'report'), said('a', 'nobody', 'vouch')], numbers)
  assert.deepEqual(
    r.words.map((w) => [w.writer, w.subject, w.word]),
    [
      ['a', 'b', 'vouch'],
      ['b', 'a', 'report'],
    ],
  )
})

test('ratings: the weighted average of their scores, shown as it is, with how many raters', () => {
  const { ratings, said: words } = rated(rating('w', 's', 10), rating('w', 's', 6), rating('v', 's', 9))
  const r = rank([face('w'), face('v'), face('s')], ratings, words, numbers)
  const s = r.ratings.get('s')!
  assert.equal(s.count, 2)
  // w's two reviews of s are one score, their mean, 8, and each weighs half of it.
  assert.equal(r.weights[0], r.weights[1])
  const w = r.weights[0]! + r.weights[1]!
  assert.ok(near(s.value!, (w * 8 + r.weights[2]! * 9) / (w + r.weights[2]!)))
  // One rater's 10 is a 10, however little it weighs.
  const ten = rated(rating('w', 's', 10))
  const one = rank([face('w'), face('s')], ten.ratings, ten.said, numbers)
  assert.deepEqual({ ...one.ratings.get('s'), order: undefined }, { value: 10, count: 1, order: undefined })
  // The evidence factor scales a score's weight; a writer takes the largest of its reviews'.
  const full = rank([face('w'), face('s')], [rating('w', 's', 9, 1)], [], numbers).weights[0]!
  assert.ok(near(rank([face('w'), face('s')], [rating('w', 's', 9, 0.5)], [], numbers).weights[0]!, full / 2))
  assert.ok(near(rank([face('w'), face('s')], [rating('w', 's', 9, 0.5), rating('w', 's', 9, 1)], [], numbers).weights[1]! * 2, full))
})

test("search's order: each profile's ratings with marketWeight of the market's average added; an unrated one at the average", () => {
  const { ratings, said: words } = rated(rating('w', 'top', 10), rating('w', 'low', 2))
  const r = rank([face('w'), face('top'), face('low'), face('new')], ratings, words, numbers)
  const [top, low] = [0, 1].map((i) => r.weights[i]!)
  const average = (top! * 10 + low! * 2) / (top! + low!)
  assert.ok(near(r.average!, average))
  assert.ok(near(r.ratings.get('top')!.order!, searchOrder(top! * 10, top!, average, numbers)!))
  assert.ok(near(r.ratings.get('new')!.order!, average))
  assert.ok(r.ratings.get('top')!.order! > r.ratings.get('new')!.order! && r.ratings.get('new')!.order! > r.ratings.get('low')!.order!)
  assert.deepEqual(r.ratings.get('new'), { value: null, count: 0, order: average })
  // A market with no score at all has no average, and no order.
  const none = rank([face('a'), face('b')], [], [], numbers)
  assert.equal(none.average, null)
  assert.deepEqual(none.ratings.get('a'), { value: null, count: 0, order: null })
})

test('a rating of oneself, or by or of a profile not given, counts for nothing', () => {
  const r = rank([face('a'), face('b')], [rating('a', 'a', 10), rating('nobody', 'b', 10), rating('a', 'nobody', 10)], [], numbers)
  assert.deepEqual(r.weights, [0, 0, 0])
  assert.equal(r.ratings.get('a')!.count, 0)
  assert.equal(r.ratings.get('b')!.value, null)
})
