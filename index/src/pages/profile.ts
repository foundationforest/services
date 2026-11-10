// `/profiles/<address>`: a profile this index holds a profile entry for. Its profile entry; each
// proof on it with what this index made of it; the checks it counts for; what it shows (its
// ratings, trust and uniqueness) and the statement that signs them; its listings, listed or not and
// why, each with its page and its photos; the reviews, vouches and reports it received and gave,
// each with whether it counts and why not, a review with its weight, and each with the other
// profile's market, role and checks, its writer's or its subject's; each listing, review, vouch
// and report with its entry's own time; the words it received and gave, each with its weight; and where
// to message it.
//
// The page is drawn for a buyer, as the app would show it: a header on its market's tint, with its
// avatar, its name and badge, its rating and how many reviews count, and the button to message it;
// then a fold saying what its numbers mean, with its own; its listings and the reviews and vouches
// it received, as cards; and one fold with everything else this index read, the weight of each
// review it received among it. On a laptop, the header and the folds on the left, the cards on the
// right.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { aggregateOf, badgeHtml, colorOf, countText, dateHtml, firstHost, inWords, type Listing, listingCardHtml, listingOf, messageHtml, messageOf, nameHtml, nameText, numbersHtml, personOf, profileAvatar, type Shown, shownFor, wordOf } from './common.ts'
import { icon } from './icons.ts'
import { backHtml, html, type Page, type Raw, short, urls } from './template.ts'

/**
 * The other profile on an entry: its writer on one received, its subject on one given. Its market,
 * role and checks as the profiles table holds them; null, null and none with no profile entry here.
 */
export type Other = { market: string | null; role: string | null; checks: Check[] }
export type ReviewEntry = {
  reviewer: string
  address: string
  body: { [key: string]: unknown }
  /** The entry's own time, in ms since 1970: its writer's word. */
  time: number
  counted: boolean
  why?: string
  weight: number
} & Other
/** A vouch or a report. */
export type SaidEntry = { writer: string; address: string; body: { [key: string]: unknown }; time: number; counted: boolean; why?: string } & Other
/** A writer's one word about a profile: its giver's uniqueness times trust, from 0 to 1, is its weight. */
export type WordEntry = { writer: string; subject: string; word: 'vouch' | 'report'; weight: number }
type Both<T> = { received: T[]; given: T[] }
export type ProfilePage = {
  index: string
  address: string
  profile: { [key: string]: unknown }
  checks: Check[]
  /** Each listing with its entry's time, its page and its photos; a deleted one with its last body and that body's time. */
  listings: Array<Listing & { time: number; listed: boolean; why?: string }>
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

/** The other profile's columns, from a left join on the profiles table: all null with no profile entry. */
type OtherColumns = { market: string | null; role: string | null; checks: string | null }
const otherOf = (r: OtherColumns): Other => ({ market: r.market, role: r.role, checks: r.checks === null ? [] : parse(r.checks) })

// The other profile's fields come after every field an entry gave before them, so each of those
// keeps its place.
type ReviewColumns = { address: string; reviewer: string; body: string; time: number; counted: number; why: string | null; weight: number } & OtherColumns
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
    ...otherOf(r),
  }
}
type SaidColumns = { address: string; writer: string; body: string; time: number; counted: number; why: string | null } & OtherColumns
const said = (r: SaidColumns): SaidEntry => ({ writer: r.writer, address: r.address, body: parse(r.body), time: r.time, counted: r.counted === 1, ...(r.why !== null && { why: r.why }), ...otherOf(r) })

const counts = (r: { counted: boolean; why?: string }, more = '') => html`<p>${r.counted ? `Counts${more}.` : html`<span class="red">Does not count: ${r.why}.</span>`}</p>`

function reviewLine(r: ReviewEntry, other: string, base: string): Raw {
  const score = typeof r.body.score === 'string' ? `${r.body.score} of 10` : 'no score'
  return html`<section><p>${score}, <a href="${urls(base).profile(other)}">${short(other)}</a>.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r, `, weight ${r.weight.toFixed(2)}`)}</section>`
}

function saidLine(kind: string, r: SaidEntry, other: string, base: string): Raw {
  return html`<section><p>A ${kind}, <a href="${urls(base).profile(other)}">${short(other)}</a>.${typeof r.body.text === 'string' ? html` ${r.body.text}` : ''}</p>
${counts(r)}</section>`
}

const none = html`<p>None.</p>`
const listOf = <T>(items: T[], draw: (item: T) => Raw) => (items.length ? items.map(draw) : none)

export const profile: Page<ProfilePage> = {
  name: 'profile',
  data({ store, lists, self, base }, [address]) {
    const found = store.db.prepare('select address, body, checks, proofs from profiles where address = ?').get(address ?? '') as
      | { address: string; body: string; checks: string; proofs: string }
      | undefined
    if (!found) return null
    const listings = store.db.prepare('select address, body, time, listed, why from listings where profile = ? order by time desc, address').all(found.address) as Array<{
      address: string
      body: string
      time: number
      listed: number
      why: string | null
    }>
    // Each with the other profile, `other` its column: the writer of one received, the subject of one given.
    const reviews = (column: string, other: string) =>
      (
        store.db
          .prepare(
            `select e.address, e.reviewer, e.subject, e.body, e.time, e.counted, e.why, e.weight, f.market, f.role, f.checks
             from reviews e left join profiles f on f.address = e.${other} where e.${column} = ? order by e.time desc, e.address`,
          )
          .all(found.address) as ReviewColumns[]
      ).map(entry)
    const saidIn = (table: string) => {
      const of = (column: string, other: string) =>
        (
          store.db
            .prepare(
              `select e.address, e.writer, e.body, e.time, e.counted, e.why, f.market, f.role, f.checks
               from ${table} e left join profiles f on f.address = e.${other} where e.${column} = ? order by e.time desc, e.address`,
            )
            .all(found.address) as SaidColumns[]
        ).map(said)
      return { received: of('subject', 'writer'), given: of('writer', 'subject') }
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
      listings: listings.map((l) => {
        const { address, body, url, photos } = listingOf(base, l.address, parse(l.body), host)
        return { address, body, time: l.time, listed: l.listed === 1, ...(l.why !== null && !l.listed && { why: l.why }), url, photos }
      }),
      reviews: { received: reviews('subject', 'reviewer'), given: reviews('reviewer', 'subject') },
      vouches: saidIn('vouches'),
      reports: saidIn('reports'),
      words: { received: words('subject'), given: words('writer') },
      proofs: parse(found.proofs),
      message: messageOf(lists.apps, found.address),
    }
  },
  title: (o) => `Forest index: ${[o.profile.market, o.profile.role].filter((x) => typeof x === 'string').join(' ')} ${short(o.address)}`,
  // A review's and a vouch's card shows its entry's own time as its date, in UTC, the one zone a page
  // with no script can give every reader; the time is its writer's word, as the JSON says. Its writer
  // is drawn as a result's profile is, its avatar, name and badge, from the market, role and checks
  // the JSON gives beside it; one with no profile entry here as "A profile", nameHtml's own word,
  // with no avatar and no badge.
  body(o, base, site) {
    const subjectOf = (r: { body: { [key: string]: unknown } }) => (typeof r.body.subject === 'string' ? r.body.subject : '')
    const wordHtml = (w: WordEntry, other: string) => html`<li>${w.word}, <a href="${urls(base).profile(other)}">${short(other)}</a>, weight ${w.weight.toFixed(2)}</li>`
    const market = typeof o.profile.market === 'string' ? o.profile.market : null
    const role = typeof o.profile.role === 'string' ? o.profile.role : null
    const word = wordOf(site, market, role)
    const reviews = o.reviews.received.filter((r) => r.counted).length
    const rated = !o.checks.length
      ? html`<span class="s">Not verified here</span>`
      : o.ratings.value === null
        ? html`<span class="chip sm">New</span>`
        : html`<span class="rate">${icon('star', 'fill')}${o.ratings.value.toFixed(1)}</span><span class="s">${countText(reviews, 'reviews')}</span>`
    // The reviews and vouches it received, newest first, by their entries' own times.
    const said = [...o.reviews.received.map((r) => ({ r, writer: r.reviewer, vouch: false })), ...o.vouches.received.map((r) => ({ r, writer: r.writer, vouch: true }))].sort(
      (a, b) => b.r.time - a.r.time || (a.r.address < b.r.address ? -1 : 1),
    )
    const saidHtml = ({ r, writer, vouch }: (typeof said)[number]) =>
      html`<a class="card said" href="${urls(base).profile(writer)}"><span class="line">${
        vouch ? html`<span class="chip mint">${icon('handshake', 'bold')}Vouch</span>` : html`<span class="rate">${icon('star', 'fill')}${typeof r.body.score === 'string' ? r.body.score : '–'}</span>`
      }<span class="grow"></span><span class="xs">${dateHtml(r.time)}</span></span>${typeof r.body.text === 'string' && r.body.text ? html`<span class="text">${r.body.text}</span>` : ''}<span class="who">${profileAvatar(site, r.market, r.role, 'xs')}${nameHtml(r.market, r.role, r.checks)}</span>${
        r.counted ? '' : html`<span class="s red">Does not count: ${r.why}.</span>`
      }</a>`
    return html`<div class="${market ? 'head tint profile-head' : 'head profile-head'}"${market ? html` style="--h:${colorOf(site, market)}"` : ''}>${backHtml(market ? urls(base).market(market) : urls(base).home)}
<div class="me">${profileAvatar(site, market, role, 'lg')}<div><h1 class="h2 titled">${nameText(market, role)}${badgeHtml(o.checks, true)}</h1><span class="rated">${rated}</span></div></div>
${messageHtml(o.message, 'Message')}</div>
${numbersHtml(o)}
<div class="lists"><h2>${word ? inWords(word) : 'Listings'}</h2>
${o.listings.length ? html`<div class="list">${o.listings.map((l) => listingCardHtml(site, market, l))}</div>` : html`<p>None yet.</p>`}
<h2>Reviews</h2>
${said.length ? html`<div class="list">${said.map(saidHtml)}</div>` : html`<p>None yet.</p>`}</div>
<details class="fold all"><summary>${icon('file-code')}<span class="grow">Everything this index read about this profile</span>${icon('caret-down')}</summary><div class="fbody"><p>Its address: <code>${o.address}</code></p>
<h3>Reviews received</h3>
${listOf(o.reviews.received, (r) => reviewLine(r, r.reviewer, base))}
<h3>Reviews given</h3>
${listOf(o.reviews.given, (r) => reviewLine(r, subjectOf(r), base))}
<h3>Vouches and reports received</h3>
${listOf([...o.vouches.received.map((r) => saidLine('vouch', r, r.writer, base)), ...o.reports.received.map((r) => saidLine('report', r, r.writer, base))], (x) => x)}
<h3>Vouches and reports given</h3>
${listOf([...o.vouches.given.map((r) => saidLine('vouch', r, subjectOf(r), base)), ...o.reports.given.map((r) => saidLine('report', r, subjectOf(r), base))], (x) => x)}
<h3>Words</h3>
<p>Each writer's one word about a profile: a report if its latest counted entry about it is a report, otherwise a vouch.</p>
<p><b>Received</b></p>
${o.words.received.length ? html`<ul>${o.words.received.map((w) => wordHtml(w, w.writer))}</ul>` : none}
<p><b>Given</b></p>
${o.words.given.length ? html`<ul>${o.words.given.map((w) => wordHtml(w, w.subject))}</ul>` : none}
<h3>Proofs</h3>
${listOf(o.proofs, (p) => html`<section><p>${String(p.circuit)} proof${p.verifier ? ` from ${p.verifier}` : ''}${p.index ? html`, index <code>${String(p.index)}</code>` : ''}${typeof p.trust === 'number' ? `, trust ${p.trust}` : ''}: ${p.result}.</p></section>`)}
<h3>Signed statement</h3>
${o.statement ? html`<p>What this index signed of what the profile shows, and its signature, which anyone checks against this index's address:</p><p><code>${o.statement}</code></p><p><code>${o.signature}</code></p>` : html`<p>None: this profile does not count here.</p>`}</div></details>`
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
