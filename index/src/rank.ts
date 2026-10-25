// The ranking: one pure function for one market, with no database inside, so another ranking is
// another file. README.md, How it scores, says the same in words; every number is in
// config/scoring.json.
//
// A review counts only between two profiles of one market (reviews.ts), so each market is ranked
// on its own. For each writer u and subject v, the scores of u's counted reviews of v (the latest
// per post) are averaged into one score s(u,v), an edge from u to v; d(u) is how many profiles u
// reviewed. Each profile i has v(i), the points of its largest counted verifier key (filter.ts).
//
//   trust      T(i) starts at (1 - alpha) v(i), and each edge's flow e at 0.
//   rounds     `rounds` times, each reading only what the round before left:
//     baseline   mu = (marketPrior mu0 + sum of w s) / (marketPrior + sum of w), over every edge;
//                the first round weighs each edge by its seed weight, its w from the starting trust
//     habit      sbar(u) = (calibrationPrior mu + sum over v of s(u,v)) / (calibrationPrior + d(u))
//     calibrated shat(u,v) = s(u,v) - beta (sbar(u) - mu), kept within 1 to 10
//     quality    q(u,v) = (shat(u,v) - neutral) / neutral
//     weight     w(u,v) = min(1, T'(u,v) / (d(u) + sink)) times the edge's evidence factor, with
//                T'(u,v) = max(0, T(u) - max(0, e(v,u))): u's trust without what v passed it
//     flow       e(u,v) = alpha w(u,v) q(u,v)
//     trust      T(v) = max(0, (1 - alpha) v(v) + sum over u of e(u,v))
//   backing    B(v) = sum over u of w(u,v), from the last round
//   rating     R(v) = (ratingPrior mu + sum over u of w(u,v) shat(u,v)) / (ratingPrior + B(v)),
//              with the last round's mu and shat; a profile no edge points to has none
//
// Every edge in a round reads the trust and flows of the round before, so the order of the edges
// changes nothing. An edge takes the largest evidence factor among its reviews: evidence shows that
// money moved between the two profiles, whichever post a review names. A review's weight is its
// edge's w split equally across the edge's reviews, so a profile's backing is the sum of its
// reviews' weights.

export type RankProfile = { address: string; points: number }
export type RankReview = { writer: string; subject: string; score: number; evidence: number }
export type Numbers = {
  mu0: number
  marketPrior: number
  calibrationPrior: number
  beta: number
  neutral: number
  alpha: number
  sink: number
  rounds: number
  ratingPrior: number
}
/** `value` is null for a profile no counted review is about; `reviews` is how many writers reviewed it. */
export type Rating = { value: number | null; backing: number; reviews: number }
export type Ranked = {
  /** The market's baseline, mu, as the last round left it. */
  baseline: number
  trust: Map<string, number>
  /** Each review's weight, in the order given; 0 for one that does not count. */
  weights: number[]
  ratings: Map<string, Rating>
}

type Edge = { writer: string; subject: string; score: number; evidence: number; reviews: number[] }

/** Reviews whose writer or subject is not among `profiles`, or that review their writer, are left out: they do not count. */
export function rank(profiles: RankProfile[], reviews: RankReview[], numbers: Numbers): Ranked {
  const { mu0, marketPrior, calibrationPrior, beta, neutral, alpha, sink, rounds, ratingPrior } = numbers
  const start = new Map(profiles.map((p) => [p.address, (1 - alpha) * p.points]))

  const byPair = new Map<string, Edge>()
  reviews.forEach((r, i) => {
    if (!start.has(r.writer) || !start.has(r.subject) || r.writer === r.subject) return
    const pair = JSON.stringify([r.writer, r.subject])
    const edge = byPair.get(pair) ?? byPair.set(pair, { writer: r.writer, subject: r.subject, score: 0, evidence: 0, reviews: [] }).get(pair)!
    edge.score += r.score
    edge.evidence = Math.max(edge.evidence, r.evidence)
    edge.reviews.push(i)
  })
  const edges = [...byPair.values()]
  for (const e of edges) e.score /= e.reviews.length
  const d = new Map<string, number>()
  const given = new Map<string, number>()
  for (const e of edges) {
    d.set(e.writer, (d.get(e.writer) ?? 0) + 1)
    given.set(e.writer, (given.get(e.writer) ?? 0) + e.score)
  }
  // Each edge's reverse, from its subject back to its writer, or -1.
  const at = new Map(edges.map((e, i) => [JSON.stringify([e.writer, e.subject]), i]))
  const back = edges.map((e) => at.get(JSON.stringify([e.subject, e.writer])) ?? -1)
  const weightOf = (trust: number, e: Edge) => Math.min(1, trust / (d.get(e.writer)! + sink)) * e.evidence

  let trust = new Map(start)
  let flow = edges.map(() => 0)
  let w = edges.map((e) => weightOf(start.get(e.writer)!, e))
  let mu = mu0
  let shat = edges.map((e) => e.score)
  for (let round = 0; round < rounds; round++) {
    mu = (marketPrior * mu0 + edges.reduce((a, e, i) => a + w[i]! * e.score, 0)) / (marketPrior + w.reduce((a, x) => a + x, 0))
    const sbar = new Map([...given].map(([u, total]) => [u, (calibrationPrior * mu + total) / (calibrationPrior + d.get(u)!)]))
    shat = edges.map((e) => Math.min(10, Math.max(1, e.score - beta * (sbar.get(e.writer)! - mu))))
    w = edges.map((e, i) => weightOf(Math.max(0, trust.get(e.writer)! - Math.max(0, back[i]! < 0 ? 0 : flow[back[i]!]!)), e))
    flow = edges.map((_, i) => (alpha * w[i]! * (shat[i]! - neutral)) / neutral)
    const next = new Map(start)
    edges.forEach((e, i) => next.set(e.subject, next.get(e.subject)! + flow[i]!))
    trust = new Map([...next].map(([p, t]) => [p, Math.max(0, t)]))
  }

  const sums = new Map(profiles.map((p) => [p.address, { backing: 0, scored: 0, reviews: 0 }]))
  edges.forEach((e, i) => {
    const s = sums.get(e.subject)!
    s.backing += w[i]!
    s.scored += w[i]! * shat[i]!
    s.reviews++
  })
  const ratings = new Map<string, Rating>()
  for (const [address, s] of sums) {
    ratings.set(address, { value: s.reviews ? (ratingPrior * mu + s.scored) / (ratingPrior + s.backing) : null, backing: s.backing, reviews: s.reviews })
  }
  const weights = reviews.map(() => 0)
  edges.forEach((e, i) => {
    for (const r of e.reviews) weights[r] = w[i]! / e.reviews.length
  })
  return { baseline: mu, trust, weights, ratings }
}
