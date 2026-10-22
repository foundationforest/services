// The ranking: one pure function, with no database inside, so another ranking is another file.
// README.md, How it scores, says the same in words.
//
// Every counted profile starts with its points (filter.ts). Points flow along counted reviews: each
// round, a profile keeps (1 - damping) of its starting points, and each review passes its subject
// damping times its writer's points, split equally across all the writer's counted reviews, times
// score / 10, times its evidence weight:
//
//   x(p) = (1 - d) s(p) + d * sum over reviews of p of x(writer) / n(writer) * score / 10 * e
//
// from x = s, until no profile moves by more than the tolerance, or for at most maxRounds rounds.
// With every evidence weight at most 1, a group of profiles reviewing only each other never ends
// with more points among them than they started with.
//
// A review's weight is the share it passes in the flow, x(writer) / n(writer) times its evidence
// weight: one writer weighs at most their own points in anyone's rating, however many posts they
// review. A profile's rating is the mean of the scores it received, each weighted so; its shrunk
// rating, which search sorts by, is (sum of weight * score + m * the market's mean rating) / (sum of
// weight + m), where the market's mean rating is the mean of the ratings of its rated profiles and
// m is `shrink`.

export type RankProfile = { address: string; market: string; points: number }
export type RankReview = { writer: string; subject: string; score: number; evidence: number }
export type Numbers = { damping: number; tolerance: number; maxRounds: number; shrink: number }
export type Rating = { value: number | null; reviews: number; weight: number; shrunk: number | null }
export type Ranked = {
  points: Map<string, number>
  rounds: number
  /** Each review's weight, in the order given. */
  weights: number[]
  ratings: Map<string, Rating>
}

/** Reviews whose writer or subject is not among `profiles`, or that review their writer, are left out: they do not count. */
export function rank(profiles: RankProfile[], reviews: RankReview[], numbers: Numbers): Ranked {
  const { damping: d, tolerance, maxRounds, shrink: m } = numbers
  const start = new Map(profiles.map((p) => [p.address, p.points]))
  const counted = reviews.filter((r) => start.has(r.writer) && start.has(r.subject) && r.writer !== r.subject)
  const counts = new Set(counted)
  const written = new Map<string, number>()
  for (const r of counted) written.set(r.writer, (written.get(r.writer) ?? 0) + 1)

  let x = new Map(start)
  let rounds = 0
  while (rounds < maxRounds) {
    rounds++
    const next = new Map([...start].map(([p, s]) => [p, (1 - d) * s]))
    for (const r of counted) next.set(r.subject, next.get(r.subject)! + (d * x.get(r.writer)! * r.score * r.evidence) / (written.get(r.writer)! * 10))
    let moved = 0
    for (const [p, v] of next) moved = Math.max(moved, Math.abs(v - x.get(p)!))
    x = next
    if (moved <= tolerance) break
  }

  const sums = new Map(profiles.map((p) => [p.address, { weight: 0, scored: 0, reviews: 0 }]))
  const weights = reviews.map((r) => {
    if (!counts.has(r)) return 0
    const weight = (x.get(r.writer)! / written.get(r.writer)!) * r.evidence
    const s = sums.get(r.subject)!
    s.weight += weight
    s.scored += weight * r.score
    s.reviews++
    return weight
  })

  const value = (s: { weight: number; scored: number }) => (s.weight > 0 ? s.scored / s.weight : null)
  const byMarket = new Map<string, number[]>()
  for (const p of profiles) {
    const v = value(sums.get(p.address)!)
    if (v !== null) byMarket.set(p.market, [...(byMarket.get(p.market) ?? []), v])
  }
  const ratings = new Map<string, Rating>()
  for (const p of profiles) {
    const s = sums.get(p.address)!
    const rated = byMarket.get(p.market)
    const mean = rated ? rated.reduce((a, b) => a + b, 0) / rated.length : null
    const shrunk = mean !== null && s.weight + m > 0 ? (s.scored + m * mean) / (s.weight + m) : value(s)
    ratings.set(p.address, { value: value(s), reviews: s.reviews, weight: s.weight, shrunk })
  }
  return { points: x, rounds, weights, ratings }
}
