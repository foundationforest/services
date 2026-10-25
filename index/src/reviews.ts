// Which reviews count. A review is a record at review/<id> in its writer's folder, with the fields
// the markets manual names: subject, score ("1" to "10"), text, offer (the post's full address) and
// evidence. It counts when, in this order:
//
//   1. its writer counts here (filter.ts);
//   2. it fits its writer's market's review fields (markets.ts);
//   3. it gives a score;
//   4. it is about another profile, not its writer;
//   5. its writer and the profile it is about have the same market in their profile records, so
//      each market is ranked on its own (rank.ts);
//   6. the profile it is about counts here;
//   7. it is the latest of the writer's reviews of that profile and that post (or of no post), by
//      its record's time: one counted review per writer, subject and offer.
//
// A review that does not count says why. A post a review names may be deleted; it is kept here with
// its last body (read.ts), so the review's offer still finds it.

import type { Markets } from './markets.ts'

export type Review = { address: string; reviewer: string; body: { [key: string]: unknown }; time: number }
export type Author = { counted: boolean; market: string | null; role: string | null }
export type Judged = { counted: boolean; why?: string }

export const WHY = {
  writer: 'its writer does not count here',
  score: 'it gives no score',
  itself: 'it is a review of its own writer',
  market: 'the profile it is about is in another market',
  subject: 'the profile it is about does not count here',
  later: 'a later review by the same writer, of the same profile and post, counts instead',
}

export function judgeReviews(reviews: Review[], profiles: Map<string, Author>, markets: Markets): Map<string, Judged> {
  const out = new Map<string, Judged>()
  const latest = new Map<string, Review>()
  for (const r of reviews) {
    const writer = profiles.get(r.reviewer)
    const subject = typeof r.body.subject === 'string' ? profiles.get(r.body.subject) : undefined
    let why: string | null = null
    if (!writer?.counted) why = WHY.writer
    else why = markets.checkReview(writer.market!, subject && subject.market === writer.market ? subject.role : null, r.body)
    if (!why && r.body.score === undefined) why = WHY.score
    if (!why && r.body.subject === r.reviewer) why = WHY.itself
    // Only a subject with a profile record here has a market to compare; one without does not count here.
    if (!why && subject && subject.market !== writer!.market) why = WHY.market
    if (!why && !subject?.counted) why = WHY.subject
    if (why) {
      out.set(r.address, { counted: false, why })
      continue
    }
    const pair = JSON.stringify([r.reviewer, r.body.subject, r.body.offer ?? null])
    const held = latest.get(pair)
    if (!held || r.time > held.time || (r.time === held.time && r.address > held.address)) latest.set(pair, r)
  }
  const winners = new Set(latest.values())
  for (const r of reviews) if (!out.has(r.address)) out.set(r.address, winners.has(r) ? { counted: true } : { counted: false, why: WHY.later })
  return out
}
