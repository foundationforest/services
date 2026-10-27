// Which reviews, vouches and reports count. Each is a record in its writer's folder, at review/<id>,
// vouch/<id> or report/<id>, with the fields the markets manual names: a review's subject, score
// ("1" to "10"), text, offer (the post's full address) and evidence; a vouch's and a report's
// subject and text. One counts when, in this order:
//
//   1. its writer counts here (filter.ts);
//   2. it fits its writer's market's fields for its kind (markets.ts);
//   3. a review gives a score;
//   4. it is about another profile, not its writer;
//   5. its writer and the profile it is about have the same market in their profile records, so
//      each market is ranked on its own (rank.ts);
//   6. the profile it is about counts here;
//   7. it is the latest of its kind by its writer about that profile, by its record's time: for a
//      review, the latest of that profile and that post (or of no post), one per writer, subject and
//      offer; for a vouch or a report, one per writer and subject.
//
// One that does not count says why. A post a review names may be deleted; it is kept here with its
// last body (read.ts), so the review's offer still finds it.

import type { About, Markets } from './markets.ts'

export type Written = { address: string; writer: string; body: { [key: string]: unknown }; time: number }
export type Author = { counted: boolean; market: string | null; role: string | null }
export type Judged = { counted: boolean; why?: string }

/** Why a record of `kind` does not count, in words. */
export const whyOf = (kind: About) => ({
  writer: 'its writer does not count here',
  score: 'it gives no score',
  itself: `it is a ${kind} of its own writer`,
  market: 'the profile it is about is in another market',
  subject: 'the profile it is about does not count here',
  later: kind === 'review' ? 'a later review by the same writer, of the same profile and post, counts instead' : `a later ${kind} by the same writer, of the same profile, counts instead`,
})
export const WHY = whyOf('review')

export function judge(kind: About, records: Written[], profiles: Map<string, Author>, markets: Markets): Map<string, Judged> {
  const why = whyOf(kind)
  const out = new Map<string, Judged>()
  const latest = new Map<string, Written>()
  for (const r of records) {
    const writer = profiles.get(r.writer)
    const subject = typeof r.body.subject === 'string' ? profiles.get(r.body.subject) : undefined
    let not: string | null = null
    if (!writer?.counted) not = why.writer
    else not = markets.checkAbout(kind, writer.market!, subject && subject.market === writer.market ? subject.role : null, r.body)
    if (!not && kind === 'review' && r.body.score === undefined) not = why.score
    if (!not && r.body.subject === r.writer) not = why.itself
    // Only a subject with a profile record here has a market to compare; one without does not count here.
    if (!not && subject && subject.market !== writer!.market) not = why.market
    if (!not && !subject?.counted) not = why.subject
    if (not) {
      out.set(r.address, { counted: false, why: not })
      continue
    }
    const pair = JSON.stringify([r.writer, r.body.subject, kind === 'review' ? (r.body.offer ?? null) : null])
    const held = latest.get(pair)
    if (!held || r.time > held.time || (r.time === held.time && r.address > held.address)) latest.set(pair, r)
  }
  const winners = new Set(latest.values())
  for (const r of records) if (!out.has(r.address)) out.set(r.address, winners.has(r) ? { counted: true } : { counted: false, why: why.later })
  return out
}
