// Which reviews, vouches and reports count. Each is an entry in its writer's folder, at
// review/<id>, vouch/<id> or report/<id>, with the fields the markets manual names: a review's
// subject, score ("1" to "10"), text, post (the post's full address) and its market's own; a
// vouch's and a report's subject and text. One counts when, in this order:
//
//   1. its writer counts here (filter.ts);
//   2. it fits its writer's market for its kind (the markets package's `checkEntry`), and its
//      subject, and the profile its post names, are addresses (the standard's check);
//   3. a review gives a score;
//   4. it is about another profile, not its writer;
//   5. its writer and the profile it is about have the same market in their profile entries, so
//      each market is ranked on its own (rank.ts);
//   6. the profile it is about counts here;
//   7. it is the latest of its kind by its writer about that profile, by its entry's time: for a
//      review, the latest of that profile and that post (or of no post), one per writer, subject
//      and post; for a vouch or a report, one per writer and subject.
//
// One that does not count says why. A post a review names may be deleted; it is kept here with its
// last body (read.ts), so the review's post still finds it.

import { publicKeyFromAddress } from '@foundationforest/folders'
import type { Kind, Markets } from '@foundationforest/markets'

/** The kinds of entry about a profile, each naming it as its subject: review/<id>, vouch/<id>, report/<id>. */
export type About = Exclude<Kind, 'post'>
/** Each kind's plural, as its words say it and its table is named. */
export const MANY: { [kind in About]: string } = { review: 'reviews', vouch: 'vouches', report: 'reports' }

export type Written = { address: string; writer: string; body: { [key: string]: unknown }; time: number }
export type Author = { counted: boolean; market: string | null; role: string | null }
export type Judged = { counted: boolean; why?: string }

/** Why an entry of `kind` does not count, in words. */
export const whyOf = (kind: About) => ({
  writer: 'its writer does not count here',
  score: 'it gives no score',
  itself: `it is a ${kind} of its own writer`,
  market: 'the profile it is about is in another market',
  subject: 'the profile it is about does not count here',
  later: kind === 'review' ? 'a later review by the same writer, of the same profile and post, counts instead' : `a later ${kind} by the same writer, of the same profile, counts instead`,
})
export const WHY = whyOf('review')

/**
 * Why a review, vouch or report by `writer` does not fit, or null: its market's check, with the
 * role of the profile it is about when that profile is in the same market; then the standard's, that
 * its subject is an address, and so is the profile its post names.
 */
function misfit(kind: About, body: { [key: string]: unknown }, writer: Author, subject: Author | undefined, markets: Markets): string | null {
  const market = writer.market!
  const about = subject?.market === market && markets.market(market)?.roles.some((r) => r.role === subject.role) ? subject.role! : undefined
  const post = typeof body.post === 'string' ? body.post.split('/')[0] : undefined
  return (
    markets.checkEntry(market, writer.role!, kind, body, about) ??
    (publicKeyFromAddress(body.subject) ? null : 'subject is not an address') ??
    (post === undefined || publicKeyFromAddress(post) ? null : "post is not a post's address: its profile is no address")
  )
}

export function judge(kind: About, written: Written[], profiles: Map<string, Author>, markets: Markets): Map<string, Judged> {
  const why = whyOf(kind)
  const out = new Map<string, Judged>()
  const latest = new Map<string, Written>()
  for (const r of written) {
    const writer = profiles.get(r.writer)
    const subject = typeof r.body.subject === 'string' ? profiles.get(r.body.subject) : undefined
    let not: string | null = null
    if (!writer?.counted) not = why.writer
    else not = misfit(kind, r.body, writer, subject, markets)
    if (!not && kind === 'review' && r.body.score === undefined) not = why.score
    if (!not && r.body.subject === r.writer) not = why.itself
    // Only a subject with a profile entry here has a market to compare; one without does not count here.
    if (!not && subject && subject.market !== writer!.market) not = why.market
    if (!not && !subject?.counted) not = why.subject
    if (not) {
      out.set(r.address, { counted: false, why: not })
      continue
    }
    const pair = JSON.stringify([r.writer, r.body.subject, kind === 'review' ? (r.body.post ?? null) : null])
    const held = latest.get(pair)
    if (!held || r.time > held.time || (r.time === held.time && r.address > held.address)) latest.set(pair, r)
  }
  const winners = new Set(latest.values())
  for (const r of written) if (!out.has(r.address)) out.set(r.address, winners.has(r) ? { counted: true } : { counted: false, why: why.later })
  return out
}
