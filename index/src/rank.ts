// The ranking: pure functions for one market, with no database inside, so another ranking is
// another file. README.md, How it scores, says the same in words; every number is in
// config/scoring.json, and each verifier key's confidence in lists/verifiers.json.
//
// A review, a vouch or a report counts only between two profiles of one market (reviews.ts), so
// each market is ranked on its own. Each part is its own function, with its own knobs:
//
//   uniqueness   u = 1 - prod(1 - c), over the keys a profile's verifications count for (filter.ts)
//   words        each writer has one word per subject: a report if its latest counted entry about
//                it is a report, otherwise a vouch (it rated or vouched); a word weighs its giver's
//                u times trust
//   vouch part   V = 1 - 0.5 vouchStep^v, v the sum of the vouches' weights: 0.5 with none, never 1
//   report part  R = reportCut^r, r the sum of the reports' weights: 1 with none
//   trust        T = u V R, never above u
//   pickiness    scores on 0 to 1 as (s - 1) / 9; P = 0.5 + 0.5 sum(Rt - s) / (1 + n), over the n
//                subjects a rater scored, Rt each one's current rating on the same scale
//   ratings      each score weighs its rater's u T (s P + (1 - s)(1 - P)); a rating is the weighted
//                average of its scores, shown as it is, with how many raters
//   order        search sorts by the same average with marketWeight of the market's average added
//
// A rater's reviews of one subject (one per post) are one score, their mean; each review's weight is
// that score's weight split equally among them. P weighs each score; the index shows no pickiness.
//
// Settling: from T = u / 2 and P = 0.5, each round works out every trust, pickiness and rating from
// the round before only, so the order of anything changes nothing. A round moves each trust and
// pickiness the whole way to its new value until the biggest move stops shrinking: reports can make
// whole moves flip for ever (trust high, so heavy reports, so trust low, so light reports, so trust
// high), and each time the biggest move stops shrinking, every later round moves half as far as
// before. It ends when nothing moves by more than `tolerance`, or after `maxRounds`.

export type RankProfile = { address: string; uniqueness: number }
/** A counted review with a score, from 1 to 10. */
export type RankRating = { writer: string; subject: string; score: number }
/** A counted review, vouch or report, for its writer's word: by its entry's time, then its address. */
export type Said = { writer: string; subject: string; kind: 'rating' | 'vouch' | 'report'; time: number; address: string }
export type Word = { writer: string; subject: string; word: 'vouch' | 'report' }
export type Numbers = {
  vouchStep: number
  reportCut: number
  marketWeight: number
  tolerance: number
  maxRounds: number
}
/** `value` is null for a profile no weighed score is about; `count` is how many raters scored it; `order` is what search sorts it by. */
export type Rating = { value: number | null; count: number; order: number | null }
export type Ranked = {
  trust: Map<string, number>
  /** Each profile's P, from 0 to 1. */
  pickiness: Map<string, number>
  ratings: Map<string, Rating>
  /** Each rating's weight, in the order given; 0 for one that does not count. */
  weights: number[]
  words: Array<Word & { weight: number }>
  /** The weighted average of every score in the market, or null with none. */
  average: number | null
  rounds: number
}

/** The chance that at least one of these checks holds: 0 with none. */
export function uniqueness(confidences: number[]): number {
  return 1 - confidences.reduce((left, c) => left * (1 - c), 1)
}

/** Each writer's one word about each subject, from its latest counted entry about it. */
export function wordsOf(said: Said[]): Word[] {
  const latest = new Map<string, Said>()
  for (const s of said) {
    const pair = JSON.stringify([s.writer, s.subject])
    const held = latest.get(pair)
    if (!held || s.time > held.time || (s.time === held.time && s.address > held.address)) latest.set(pair, s)
  }
  return [...latest.values()].map((s) => ({ writer: s.writer, subject: s.subject, word: s.kind === 'report' ? 'report' : 'vouch' }))
}

/** `v`, the sum of a profile's vouches' weights. */
export const vouchPart = (v: number, { vouchStep }: Pick<Numbers, 'vouchStep'>) => 1 - 0.5 * vouchStep ** v

/** `r`, the sum of a profile's reports' weights. */
export const reportPart = (r: number, { reportCut }: Pick<Numbers, 'reportCut'>) => reportCut ** r

export const trustOf = (u: number, V: number, R: number) => u * V * R

/** A score from 1 to 10 on 0 to 1. */
export const scaled = (score: number) => (score - 1) / 9

/** A rater's P, from what it scored each subject and each one's current rating, both on 0 to 1; a subject with no rating adds nothing. */
export function pickinessOf(scored: Array<{ score: number; rating: number | null }>): number {
  const sum = scored.reduce((a, x) => (x.rating === null ? a : a + x.rating - x.score), 0)
  return 0.5 + (0.5 * sum) / (1 + scored.length)
}

/** How much a score `s`, on 0 to 1, weighs from a rater of pickiness P. */
export const scoreWeight = (s: number, P: number) => s * P + (1 - s) * (1 - P)

/** What search sorts a profile by: its scores' weighted sum and their weights, with `marketWeight` of the market's average added; null in a market with none. */
export const searchOrder = (sum: number, weight: number, average: number | null, { marketWeight }: Pick<Numbers, 'marketWeight'>) =>
  average === null ? null : (sum + marketWeight * average) / (weight + marketWeight)

type Edge = { writer: string; subject: string; score: number; reviews: number[] }

/** Ratings and said things whose writer or subject is not among `profiles`, or that are about their writer, are left out: they do not count. */
export function rank(profiles: RankProfile[], ratings: RankRating[], said: Said[], numbers: Numbers): Ranked {
  const u = new Map(profiles.map((p) => [p.address, p.uniqueness]))
  const counts = (writer: string, subject: string) => u.has(writer) && u.has(subject) && writer !== subject

  const byPair = new Map<string, Edge>()
  ratings.forEach((r, i) => {
    if (!counts(r.writer, r.subject)) return
    const pair = JSON.stringify([r.writer, r.subject])
    const edge = byPair.get(pair) ?? byPair.set(pair, { writer: r.writer, subject: r.subject, score: 0, reviews: [] }).get(pair)!
    edge.score += r.score
    edge.reviews.push(i)
  })
  const edges = [...byPair.values()]
  for (const e of edges) e.score /= e.reviews.length
  const scoredBy = new Map<string, Edge[]>()
  for (const e of edges) (scoredBy.get(e.writer) ?? scoredBy.set(e.writer, []).get(e.writer)!).push(e)
  const words = wordsOf(said.filter((s) => counts(s.writer, s.subject)))

  const weightOf = (e: Edge, trust: Map<string, number>, picky: Map<string, number>) => u.get(e.writer)! * trust.get(e.writer)! * scoreWeight(scaled(e.score), picky.get(e.writer)!)
  /** Each subject's weighted sum of scores, from 1 to 10, and their weights. */
  const sumsOf = (trust: Map<string, number>, picky: Map<string, number>) => {
    const sums = new Map<string, { sum: number; weight: number }>()
    for (const e of edges) {
      const w = weightOf(e, trust, picky)
      const s = sums.get(e.subject) ?? { sum: 0, weight: 0 }
      sums.set(e.subject, { sum: s.sum + w * e.score, weight: s.weight + w })
    }
    return sums
  }

  let trust = new Map(profiles.map((p) => [p.address, p.uniqueness / 2]))
  let picky = new Map(profiles.map((p) => [p.address, 0.5]))
  let step = 1
  let last = Infinity
  let rounds = 0
  while (rounds < numbers.maxRounds) {
    rounds++
    const v = new Map<string, number>()
    const r = new Map<string, number>()
    for (const w of words) {
      const sums = w.word === 'vouch' ? v : r
      sums.set(w.subject, (sums.get(w.subject) ?? 0) + u.get(w.writer)! * trust.get(w.writer)!)
    }
    const nextTrust = new Map([...u].map(([a, x]) => [a, trustOf(x, vouchPart(v.get(a) ?? 0, numbers), reportPart(r.get(a) ?? 0, numbers))]))
    const sums = sumsOf(trust, picky)
    const ratingOf = (subject: string) => {
      const s = sums.get(subject)
      return s && s.weight > 0 ? scaled(s.sum / s.weight) : null
    }
    const nextPicky = new Map([...u].map(([a]) => [a, pickinessOf((scoredBy.get(a) ?? []).map((e) => ({ score: scaled(e.score), rating: ratingOf(e.subject) })))]))

    let moved = 0
    for (const [a, x] of nextTrust) moved = Math.max(moved, Math.abs(x - trust.get(a)!))
    for (const [a, x] of nextPicky) moved = Math.max(moved, Math.abs(x - picky.get(a)!))
    if (moved <= numbers.tolerance) {
      trust = nextTrust
      picky = nextPicky
      break
    }
    if (moved >= last) step /= 2
    last = moved
    const toward = (now: Map<string, number>, next: Map<string, number>) => new Map([...now].map(([a, x]) => [a, x + step * (next.get(a)! - x)]))
    trust = toward(trust, nextTrust)
    picky = toward(picky, nextPicky)
  }

  const sums = sumsOf(trust, picky)
  let all = { sum: 0, weight: 0 }
  for (const s of sums.values()) all = { sum: all.sum + s.sum, weight: all.weight + s.weight }
  const average = all.weight > 0 ? all.sum / all.weight : null
  const raters = new Map<string, number>()
  for (const e of edges) raters.set(e.subject, (raters.get(e.subject) ?? 0) + 1)
  const out = new Map<string, Rating>()
  for (const p of profiles) {
    const s = sums.get(p.address) ?? { sum: 0, weight: 0 }
    out.set(p.address, { value: s.weight > 0 ? s.sum / s.weight : null, count: raters.get(p.address) ?? 0, order: searchOrder(s.sum, s.weight, average, numbers) })
  }
  const weights = ratings.map(() => 0)
  for (const e of edges) for (const i of e.reviews) weights[i] = weightOf(e, trust, picky) / e.reviews.length
  return {
    trust,
    pickiness: picky,
    ratings: out,
    weights,
    words: words.map((w) => ({ ...w, weight: u.get(w.writer)! * trust.get(w.writer)! })),
    average,
    rounds,
  }
}
