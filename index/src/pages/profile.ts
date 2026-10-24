// `/profiles/<address>`: a profile this index holds a profile record for. Its profile record; each
// proof on it with what this index made of it; the checks it counts for; its rating; its posts,
// listed or not and why; and the reviews it received and gave, each with whether it counts and why
// not, its evidence (and why, when it is unchecked) and its weight.

import { type Evidence, uncheckedWhy } from '../evidence/index.ts'
import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { aggregateOf, checksText, personOf, postFields, type Rating, ratingFor, ratingText } from './common.ts'
import { html, type Page, short, urls } from './template.ts'

export type ReviewEntry = {
  reviewer: string
  address: string
  body: { [key: string]: unknown }
  counted: boolean
  why?: string
  evidence: Evidence['status']
  /** Only when the evidence is unchecked: the chain this index does not read. */
  evidenceWhy?: string
  weight: number
}
export type ProfilePage = {
  index: string
  address: string
  profile: { [key: string]: unknown }
  checks: Check[]
  rating: Rating
  posts: Array<{ address: string; body: { [key: string]: unknown }; listed: boolean; why?: string }>
  reviews: { received: ReviewEntry[]; given: ReviewEntry[] }
  proofs: Array<{ circuit: unknown; result: string; [key: string]: unknown }>
}

type ReviewColumns = { address: string; reviewer: string; body: string; counted: number; why: string | null; evidence: ReviewEntry['evidence']; weight: number }
const entry = (r: ReviewColumns): ReviewEntry => {
  const body = parse<{ [key: string]: unknown }>(r.body)
  return {
    reviewer: r.reviewer,
    address: r.address,
    body,
    counted: r.counted === 1,
    ...(r.why !== null && { why: r.why }),
    evidence: r.evidence,
    ...(r.evidence === 'unchecked' && { evidenceWhy: uncheckedWhy(body.evidence) }),
    weight: r.weight,
  }
}

const EVIDENCE = { with: 'with a payment', without: 'without a payment', unchecked: 'its evidence is unchecked', invalid: 'its evidence does not count' }

function reviewHtml(r: ReviewEntry, other: string, base: string): ReturnType<typeof html> {
  const score = typeof r.body.score === 'string' ? `${r.body.score} of 10` : 'no score'
  return html`<section><p>${score}, <a href="${urls(base).profile(other)}">${short(other)}</a>, ${EVIDENCE[r.evidence]}${r.evidenceWhy ? `: ${r.evidenceWhy}` : ''}.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
<p class="muted">${r.counted ? `Counts, weight ${r.weight.toFixed(2)}.` : html`<span class="no">Does not count: ${r.why}.</span>`}</p></section>`
}

export const profile: Page<ProfilePage> = {
  data({ store, self }, [address]) {
    const found = store.db.prepare('select address, body, checks, proofs from profiles where address = ?').get(address ?? '') as
      | { address: string; body: string; checks: string; proofs: string }
      | undefined
    if (!found) return null
    const posts = store.db.prepare('select address, body, listed, why from posts where profile = ? order by time desc, address').all(found.address) as Array<{
      address: string
      body: string
      listed: number
      why: string | null
    }>
    const reviews = (column: string) =>
      (store.db.prepare(`select address, reviewer, subject, body, counted, why, evidence, weight from reviews where ${column} = ? order by time desc, address`).all(found.address) as ReviewColumns[]).map(entry)
    return {
      index: self,
      address: found.address,
      profile: parse(found.body),
      checks: parse(found.checks),
      rating: ratingFor(store, found.address),
      posts: posts.map((p) => ({ address: p.address, body: parse(p.body), listed: p.listed === 1, ...(p.why !== null && !p.listed && { why: p.why }) })),
      reviews: { received: reviews('subject'), given: reviews('reviewer') },
      proofs: parse(found.proofs),
    }
  },
  title: (o) => `Forest index: ${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ')} ${short(o.address)}`,
  body(o, base) {
    const subjectOf = (r: ReviewEntry) => (typeof r.body.subject === 'string' ? r.body.subject : '')
    return html`<h1>${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ') || 'A profile'}</h1>
<p><code>${o.address}</code></p>
<p>${ratingText(o.rating)}. ${checksText(o.checks)}.</p>
<h2>Proofs</h2>
${o.proofs.length ? o.proofs.map((p) => html`<section><p>${String(p.circuit)} proof${p.verifier ? ` from ${p.verifier}` : ''}${p.index ? html`, index <code>${String(p.index)}</code>` : ''}${typeof p.rating === 'number' ? `, ${p.rating.toFixed(1)}` : ''}: ${p.result}.</p></section>`) : html`<p class="muted">None.</p>`}
<h2>Posts</h2>
${o.posts.length ? o.posts.map((p) => html`<section>${postFields(p.body)}${p.listed ? '' : html`<p class="no">Not listed: ${p.why}.</p>`}<p class="muted"><code>${p.address}</code></p></section>`) : html`<p class="muted">None.</p>`}
<h2>Reviews received</h2>
${o.reviews.received.length ? o.reviews.received.map((r) => reviewHtml(r, r.reviewer, base)) : html`<p class="muted">None.</p>`}
<h2>Reviews given</h2>
${o.reviews.given.length ? o.reviews.given.map((r) => reviewHtml(r, subjectOf(r), base)) : html`<p class="muted">None.</p>`}`
  },
  ld(o, base, url) {
    const id = `${url}#profile`
    const rating = aggregateOf(o.rating)
    return {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'ProfilePage', '@id': url, url, mainEntity: { '@id': id } },
        { ...personOf(o.address, base), '@id': id },
        ...(rating ? [{ ...rating, itemReviewed: { '@id': id } }] : []),
        ...o.reviews.received
          .filter((r) => r.counted)
          .map((r) => ({
            '@type': 'Review',
            itemReviewed: { '@id': id },
            author: personOf(r.reviewer, base),
            identifier: r.address,
            reviewRating: { '@type': 'Rating', ratingValue: Number(r.body.score), bestRating: 10, worstRating: 1 },
            ...(typeof r.body.text === 'string' && { reviewBody: r.body.text }),
          })),
      ],
    }
  },
}
