// `/profiles/<address>`: a profile this index holds a profile record for. Its profile record; each
// proof on it with what this index made of it; the checks it counts for; what it shows (its
// ratings, trust, uniqueness and pickiness) and the statement that signs them; its posts, listed or
// not and why; the reviews, vouches and reports it received and gave, each with whether it counts
// and why not, a review with its evidence (and why, when it is unchecked or already used) and its
// weight; and the words it received and gave, each with its weight.

import type { Evidence } from '../evidence/index.ts'
import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { aggregateOf, personOf, postFields, type Shown, shownFor, shownHtml } from './common.ts'
import { html, type Page, type Raw, short, urls } from './template.ts'

export type ReviewEntry = {
  reviewer: string
  address: string
  body: { [key: string]: unknown }
  counted: boolean
  why?: string
  evidence: Evidence['status']
  /** Only when the evidence is unchecked, the chain this index does not read; or invalid because an earlier review used it, "already used". */
  evidenceWhy?: string
  weight: number
}
/** A vouch or a report. */
export type SaidEntry = { writer: string; address: string; body: { [key: string]: unknown }; counted: boolean; why?: string }
/** A writer's one word about a profile: its giver's uniqueness times trust, from 0 to 1, is its weight. */
export type WordEntry = { writer: string; subject: string; word: 'vouch' | 'report'; weight: number }
type Both<T> = { received: T[]; given: T[] }
export type ProfilePage = {
  index: string
  address: string
  profile: { [key: string]: unknown }
  checks: Check[]
  posts: Array<{ address: string; body: { [key: string]: unknown }; listed: boolean; why?: string }>
  reviews: Both<ReviewEntry>
  vouches: Both<SaidEntry>
  reports: Both<SaidEntry>
  words: Both<WordEntry>
  proofs: Array<{ circuit: unknown; result: string; [key: string]: unknown }>
} & Shown & { statement?: string; signature?: string }

type ReviewColumns = { address: string; reviewer: string; body: string; counted: number; why: string | null; evidence: ReviewEntry['evidence']; evidence_why: string | null; weight: number }
const entry = (r: ReviewColumns): ReviewEntry => {
  const body = parse<{ [key: string]: unknown }>(r.body)
  return {
    reviewer: r.reviewer,
    address: r.address,
    body,
    counted: r.counted === 1,
    ...(r.why !== null && { why: r.why }),
    evidence: r.evidence,
    ...(r.evidence_why !== null && { evidenceWhy: r.evidence_why }),
    weight: r.weight,
  }
}
type SaidColumns = { address: string; writer: string; body: string; counted: number; why: string | null }
const said = (r: SaidColumns): SaidEntry => ({ writer: r.writer, address: r.address, body: parse(r.body), counted: r.counted === 1, ...(r.why !== null && { why: r.why }) })

const EVIDENCE = { with: 'with a payment', without: 'without a payment', unchecked: 'its evidence is unchecked', invalid: 'its evidence does not count' }

const counts = (r: { counted: boolean; why?: string }, more = '') => html`<p class="muted">${r.counted ? `Counts${more}.` : html`<span class="no">Does not count: ${r.why}.</span>`}</p>`

function reviewHtml(r: ReviewEntry, other: string, base: string): Raw {
  const score = typeof r.body.score === 'string' ? `${r.body.score} of 10` : 'no score'
  return html`<section><p>${score}, <a href="${urls(base).profile(other)}">${short(other)}</a>, ${EVIDENCE[r.evidence]}${r.evidenceWhy ? `: ${r.evidenceWhy}` : ''}.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r, `, weight ${r.weight.toFixed(2)}`)}</section>`
}

function saidHtml(kind: string, r: SaidEntry, other: string, base: string): Raw {
  return html`<section><p>A ${kind}, <a href="${urls(base).profile(other)}">${short(other)}</a>.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r)}</section>`
}

const none = html`<p class="muted">None.</p>`
const listOf = <T>(items: T[], draw: (item: T) => Raw) => (items.length ? items.map(draw) : none)

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
      (store.db.prepare(`select address, reviewer, subject, body, counted, why, evidence, evidence_why, weight from reviews where ${column} = ? order by time desc, address`).all(found.address) as ReviewColumns[]).map(entry)
    const saidIn = (table: string) => {
      const of = (column: string) => (store.db.prepare(`select address, writer, body, counted, why from ${table} where ${column} = ? order by time desc, address`).all(found.address) as SaidColumns[]).map(said)
      return { received: of('subject'), given: of('writer') }
    }
    const words = (column: string) => store.db.prepare(`select writer, subject, word, weight from words where ${column} = ? order by weight desc, writer, subject`).all(found.address) as WordEntry[]
    return {
      index: self,
      address: found.address,
      profile: parse(found.body),
      checks: parse(found.checks),
      ...shownFor(store, found.address),
      posts: posts.map((p) => ({ address: p.address, body: parse(p.body), listed: p.listed === 1, ...(p.why !== null && !p.listed && { why: p.why }) })),
      reviews: { received: reviews('subject'), given: reviews('reviewer') },
      vouches: saidIn('vouches'),
      reports: saidIn('reports'),
      words: { received: words('subject'), given: words('writer') },
      proofs: parse(found.proofs),
    }
  },
  title: (o) => `Forest index: ${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ')} ${short(o.address)}`,
  body(o, base) {
    const subjectOf = (r: { body: { [key: string]: unknown } }) => (typeof r.body.subject === 'string' ? r.body.subject : '')
    const wordHtml = (w: WordEntry, other: string) => html`<li>${w.word}, <a href="${urls(base).profile(other)}">${short(other)}</a>, weight ${w.weight.toFixed(2)}</li>`
    return html`<h1>${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ') || 'A profile'}</h1>
<p><code>${o.address}</code></p>
<p>${shownHtml(o, o.checks)}.</p>
<h2>Proofs</h2>
${listOf(o.proofs, (p) => html`<section><p>${String(p.circuit)} proof${p.verifier ? ` from ${p.verifier}` : ''}${p.index ? html`, index <code>${String(p.index)}</code>` : ''}${typeof p.trust === 'number' ? `, trust ${p.trust}` : ''}: ${p.result}.</p></section>`)}
<h2>Posts</h2>
${listOf(o.posts, (p) => html`<section>${postFields(p.body)}${p.listed ? '' : html`<p class="no">Not listed: ${p.why}.</p>`}<p class="muted"><code>${p.address}</code></p></section>`)}
<h2>Reviews received</h2>
${listOf(o.reviews.received, (r) => reviewHtml(r, r.reviewer, base))}
<h2>Reviews given</h2>
${listOf(o.reviews.given, (r) => reviewHtml(r, subjectOf(r), base))}
<h2>Vouches and reports received</h2>
${listOf([...o.vouches.received.map((r) => saidHtml('vouch', r, r.writer, base)), ...o.reports.received.map((r) => saidHtml('report', r, r.writer, base))], (x) => x)}
<h2>Vouches and reports given</h2>
${listOf([...o.vouches.given.map((r) => saidHtml('vouch', r, subjectOf(r), base)), ...o.reports.given.map((r) => saidHtml('report', r, subjectOf(r), base))], (x) => x)}
<h2>Words</h2>
<p>Each writer's one word about a profile: a report if its latest record about it is a report, otherwise a vouch.</p>
<h3>Received</h3>
${o.words.received.length ? html`<ul>${o.words.received.map((w) => wordHtml(w, w.writer))}</ul>` : none}
<h3>Given</h3>
${o.words.given.length ? html`<ul>${o.words.given.map((w) => wordHtml(w, w.subject))}</ul>` : none}`
  },
  ld(o, base, url) {
    const id = `${url}#profile`
    const rating = aggregateOf(o)
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
