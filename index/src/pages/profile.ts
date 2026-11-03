// `/profiles/<address>`: a profile this index holds a profile entry for. Its profile entry; each
// proof on it with what this index made of it; the checks it counts for; what it shows (its
// ratings, trust and uniqueness) and the statement that signs them; its posts, listed or not and
// why, each with its page and its photos; the reviews, vouches and reports it received and gave,
// each with whether it counts and why not, a review with its weight; each post, review, vouch and
// report with its entry's own time; the words it received and gave, each with its weight; and where
// to message it.
//
// The page is drawn for a buyer, as the app would show it: its name and shield, how it is verified
// and its rating's chip, the button to message it, its posts and the reviews it received as rows;
// then a fold saying what its words and numbers mean, with its own, and one with everything else
// this index read, the weight of each review it received among it.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { aggregateOf, chipHtml, firstHost, meaningHtml, messageHtml, messageOf, namedHtml, personOf, type Post, postOf, postRowHtml, rowsHtml, scoreHtml, type Shown, shieldHtml, shownFor, verifiedText } from './common.ts'
import { foldHtml, html, type Page, type Raw, short, urls } from './template.ts'

export type ReviewEntry = {
  reviewer: string
  address: string
  body: { [key: string]: unknown }
  /** The entry's own time, in ms since 1970: its writer's word. */
  time: number
  counted: boolean
  why?: string
  weight: number
}
/** A vouch or a report. */
export type SaidEntry = { writer: string; address: string; body: { [key: string]: unknown }; time: number; counted: boolean; why?: string }
/** A writer's one word about a profile: its giver's uniqueness times trust, from 0 to 1, is its weight. */
export type WordEntry = { writer: string; subject: string; word: 'vouch' | 'report'; weight: number }
type Both<T> = { received: T[]; given: T[] }
export type ProfilePage = {
  index: string
  address: string
  profile: { [key: string]: unknown }
  checks: Check[]
  /** Each post with its entry's time, its page and its photos; a deleted one with its last body and that body's time. */
  posts: Array<Post & { time: number; listed: boolean; why?: string }>
  reviews: Both<ReviewEntry>
  vouches: Both<SaidEntry>
  reports: Both<SaidEntry>
  words: Both<WordEntry>
  proofs: Array<{ circuit: unknown; result: string; [key: string]: unknown }>
} & Shown & {
  statement?: string
  signature?: string
  /** Where to message it: one link per app this index lists. */
  message: Array<{ name: string; url: string }>
}

type ReviewColumns = { address: string; reviewer: string; body: string; time: number; counted: number; why: string | null; weight: number }
const entry = (r: ReviewColumns): ReviewEntry => {
  const body = parse<{ [key: string]: unknown }>(r.body)
  return {
    reviewer: r.reviewer,
    address: r.address,
    body,
    time: r.time,
    counted: r.counted === 1,
    ...(r.why !== null && { why: r.why }),
    weight: r.weight,
  }
}
type SaidColumns = { address: string; writer: string; body: string; time: number; counted: number; why: string | null }
const said = (r: SaidColumns): SaidEntry => ({ writer: r.writer, address: r.address, body: parse(r.body), time: r.time, counted: r.counted === 1, ...(r.why !== null && { why: r.why }) })

const counts = (r: { counted: boolean; why?: string }, more = '') => html`<p>${r.counted ? `Counts${more}.` : html`<span class="red">Does not count: ${r.why}.</span>`}</p>`

function reviewHtml(r: ReviewEntry, other: string, base: string): Raw {
  const score = typeof r.body.score === 'string' ? `${r.body.score} of 10` : 'no score'
  return html`<section><p>${score}, <a href="${urls(base).profile(other)}">${short(other)}</a>.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r, `, weight ${r.weight.toFixed(2)}`)}</section>`
}

function saidHtml(kind: string, r: SaidEntry, other: string, base: string): Raw {
  return html`<section><p>A ${kind}, <a href="${urls(base).profile(other)}">${short(other)}</a>.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r)}</section>`
}

/** A review it received, as a row linking to its writer: its score's chip, its text, and why it does not count, when it does not. */
function receivedHtml(r: ReviewEntry, base: string): Raw {
  return html`<a class="row said-row" href="${urls(base).profile(r.reviewer)}">${scoreHtml(r.body.score)}<span class="two">${typeof r.body.text === 'string' && r.body.text ? html`<span class="said-text">${r.body.text}</span>` : ''}${r.counted ? '' : html`<span class="why">Does not count: ${r.why}.</span>`}</span></a>`
}

const none = html`<p>None.</p>`
const listOf = <T>(items: T[], draw: (item: T) => Raw) => (items.length ? items.map(draw) : none)

export const profile: Page<ProfilePage> = {
  data({ store, lists, self, base }, [address]) {
    const found = store.db.prepare('select address, body, checks, proofs from profiles where address = ?').get(address ?? '') as
      | { address: string; body: string; checks: string; proofs: string }
      | undefined
    if (!found) return null
    const posts = store.db.prepare('select address, body, time, listed, why from posts where profile = ? order by time desc, address').all(found.address) as Array<{
      address: string
      body: string
      time: number
      listed: number
      why: string | null
    }>
    const reviews = (column: string) =>
      (store.db.prepare(`select address, reviewer, subject, body, time, counted, why, weight from reviews where ${column} = ? order by time desc, address`).all(found.address) as ReviewColumns[]).map(entry)
    const saidIn = (table: string) => {
      const of = (column: string) => (store.db.prepare(`select address, writer, body, time, counted, why from ${table} where ${column} = ? order by time desc, address`).all(found.address) as SaidColumns[]).map(said)
      return { received: of('subject'), given: of('writer') }
    }
    const words = (column: string) => store.db.prepare(`select writer, subject, word, weight from words where ${column} = ? order by weight desc, writer, subject`).all(found.address) as WordEntry[]
    const entryBody = parse<{ [key: string]: unknown }>(found.body)
    const host = firstHost(entryBody)
    return {
      index: self,
      address: found.address,
      profile: entryBody,
      checks: parse(found.checks),
      ...shownFor(store, found.address),
      posts: posts.map((p) => {
        const { address, body, url, photos } = postOf(base, p.address, parse(p.body), host)
        return { address, body, time: p.time, listed: p.listed === 1, ...(p.why !== null && !p.listed && { why: p.why }), url, photos }
      }),
      reviews: { received: reviews('subject'), given: reviews('reviewer') },
      vouches: saidIn('vouches'),
      reports: saidIn('reports'),
      words: { received: words('subject'), given: words('writer') },
      proofs: parse(found.proofs),
      message: messageOf(lists.apps, found.address),
    }
  },
  title: (o) => `Forest index: ${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ')} ${short(o.address)}`,
  // Each entry's time is in the JSON alone. This page runs no script, so it cannot show a time in
  // the reader's own zone, and drawing one would choose a zone and a format for every reader. The
  // page still draws only from its JSON object, so the two never disagree.
  body(o, base) {
    const subjectOf = (r: { body: { [key: string]: unknown } }) => (typeof r.body.subject === 'string' ? r.body.subject : '')
    const wordHtml = (w: WordEntry, other: string) => html`<li>${w.word}, <a href="${urls(base).profile(other)}">${short(other)}</a>, weight ${w.weight.toFixed(2)}</li>`
    const market = typeof o.profile.market === 'string' ? o.profile.market : null
    const role = typeof o.profile.role === 'string' ? o.profile.role : null
    return html`<div class="lead"><h1 class="titled">${namedHtml(market, role)}${shieldHtml(o.checks)}</h1>
<p class="line">${o.checks.length ? html`${verifiedText(o.checks)} · ${chipHtml(o)}` : 'Not verified here'}</p></div>
${messageHtml(o.message)}
<section><h2>Posts</h2>
${rowsHtml(o.posts.map((p) => postRowHtml(p, p.listed ? {} : { note: html`<span class="why red">Not listed: ${p.why}.</span>` })), 'None.')}</section>
<section><h2>Reviews received</h2>
${rowsHtml(o.reviews.received.map((r) => receivedHtml(r, base)), 'None.')}</section>
${meaningHtml('This profile', o)}
${foldHtml(
  'Everything this index read about this profile',
  html`<p>Its address: <code>${o.address}</code></p>
<h2>Reviews received</h2>
${listOf(o.reviews.received, (r) => reviewHtml(r, r.reviewer, base))}
<h2>Reviews given</h2>
${listOf(o.reviews.given, (r) => reviewHtml(r, subjectOf(r), base))}
<h2>Vouches and reports received</h2>
${listOf([...o.vouches.received.map((r) => saidHtml('vouch', r, r.writer, base)), ...o.reports.received.map((r) => saidHtml('report', r, r.writer, base))], (x) => x)}
<h2>Vouches and reports given</h2>
${listOf([...o.vouches.given.map((r) => saidHtml('vouch', r, subjectOf(r), base)), ...o.reports.given.map((r) => saidHtml('report', r, subjectOf(r), base))], (x) => x)}
<h2>Words</h2>
<p>Each writer's one word about a profile: a report if its latest counted entry about it is a report, otherwise a vouch.</p>
<h3>Received</h3>
${o.words.received.length ? html`<ul>${o.words.received.map((w) => wordHtml(w, w.writer))}</ul>` : none}
<h3>Given</h3>
${o.words.given.length ? html`<ul>${o.words.given.map((w) => wordHtml(w, w.subject))}</ul>` : none}
<h2>Proofs</h2>
${listOf(o.proofs, (p) => html`<section><p>${String(p.circuit)} proof${p.verifier ? ` from ${p.verifier}` : ''}${p.index ? html`, index <code>${String(p.index)}</code>` : ''}${typeof p.trust === 'number' ? `, trust ${p.trust}` : ''}: ${p.result}.</p></section>`)}
<h2>Signed statement</h2>
${o.statement ? html`<p>What this index signed of what the profile shows, and its signature, which anyone checks against this index's address:</p><p><code>${o.statement}</code></p><p><code>${o.signature}</code></p>` : html`<p>None: this profile does not count here.</p>`}`,
)}`
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
