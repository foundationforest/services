// Pages for people: plain HTML rendered on the server from the page models in data.ts, readable on a
// phone, with no JavaScript. Every word here is plain: no wallet, no token, no chain.

import type { CurrencyConfig } from '../config.ts'
import type { DealModel, FolderModel, HomeModel, MarketModel, Numbers, Offer, ProfileModel, Review, SearchModel } from './data.ts'
import { type Near, type Raw, type Urls, SCORING_DOC, html, layout } from './html.ts'
import { dealLd, folderLd, homeLd, marketLd, payLd, profileLd, searchLd } from './jsonld.ts'
import type { PayModel } from './pay.ts'
import * as w from './words.ts'

export type View = { urls: Urls; currencies: CurrencyConfig }

// -----------------------------------------------------------------------------------------------
// Pieces
// -----------------------------------------------------------------------------------------------

/** A profile's two numbers, side by side: never one number. */
function numbersLine(n: Numbers, badge: Raw | null = null): Raw {
  return html`<p class="row small">${badge ?? ''}<span>${w.rating(n.rating)}</span><span>Standing <span class="score">${w.score(n.standing)}</span></span></p>`
}

function badgeWord(o: Offer): Raw {
  return o.uniqueness > 0 ? html`<span>${w.BADGE}</span>` : html`<span class="muted">No real-person badge counted in this market</span>`
}

/** Where an offer happens, in words: online, a place and how close the point is to it, or nothing. */
function where(o: Offer): string {
  if (o.remote) return 'Online'
  if (!o.location) return ''
  return o.location.precisionKm > 0 ? `${o.location.area} (within ${o.location.precisionKm} km)` : o.location.area
}

function offerCard(v: View, o: Offer, showSeller: boolean): Raw {
  const place = where(o)
  const price = w.price(o.price, v.currencies)
  return html`<li>
${showSeller ? html`<h3><a href="${o.profileUrl}">${o.name ?? 'A profile with no name'}</a></h3>${numbersLine(o, badgeWord(o))}` : ''}
${!showSeller && o.marketUrl ? html`<p class="small"><a href="${o.marketUrl}">${w.title(o.market!)}</a></p>` : ''}
<p>${o.description}</p>
<p class="row">${price ? html`<strong>${price}</strong>` : ''}${place ? html`<span class="muted">${place}</span>` : ''}${o.availability ? html`<span class="muted">${o.availability}</span>` : ''}</p>
${o.payLink ? html`<p><a class="pay" href="${o.payLink}" rel="nofollow">Pay</a></p>` : ''}
</li>`
}

const NO_PROFILE = 'a profile not in this index'

/** `show`: whose name to give. On a profile, the other side; on a deal, both. */
function reviewCard(r: Review, show: 'author' | 'subject' | 'both'): Raw {
  const by = html`By <a href="${r.reviewerUrl}">${r.reviewerName ?? NO_PROFILE}</a>`
  const about = (word: string) => html`${word} <a href="${r.subjectUrl}">${r.subjectName ?? NO_PROFILE}</a>`
  const who = show === 'author' ? by : show === 'subject' ? about('About') : html`${by}, ${about('about')}`
  const skip = w.skipped(r.skipped)
  const media = w.media(r.media)
  const fields = Object.entries(r.fields).map(([k, x]) => w.field(k, x))
  return html`<li>
<p class="row"><span>${w.ratings(r.ratings)}</span><span class="muted small">${who}${r.createdAt ? ` · ${w.date(r.createdAt)}` : ''}</span></p>
${r.text ? html`<p>${r.text}</p>` : ''}
${fields.length || media ? html`<p class="small muted">${[...fields, ...(media ? [media] : [])].join(' · ')}</p>` : ''}
<p class="small muted">${w.evidence(r.evidence.kind, r.evidence.note)} ${show !== 'both' && r.dealUrl && r.hasReceipt ? html`<a href="${r.dealUrl}">See the receipt</a>` : ''}</p>
${skip ? html`<p class="small warn">${skip}</p>` : r.counted && r.contribution !== 0 ? html`<p class="small muted">Moves standing by ${w.signed(r.contribution)}.</p>` : ''}
</li>`
}

function marketList(markets: { name: string; url: string; description: string | null; offers: number }[]): Raw {
  return html`<ul class="cards">${markets.map(
    (m) => html`<li><h3><a href="${m.url}">${w.title(m.name)}</a></h3>${m.description ? html`<p>${m.description}</p>` : ''}<p class="small muted">${w.plural(m.offers, 'offer')}</p></li>`,
  )}</ul>`
}

/** Which offers a near search kept: `Within 10 km of 38.72, -9.14`. */
function nearLine(near: Near | null): Raw | string {
  return near ? html`<p class="small muted">Only offers within ${near.km} km of ${near.lat}, ${near.lon}; offers that name no place are left out.</p>` : ''
}

// -----------------------------------------------------------------------------------------------
// Pages
// -----------------------------------------------------------------------------------------------

export function homePage(v: View, m: HomeModel): string {
  const body = html`<h1>Find people you can trust</h1>
<p>A badge here means one real person, checked once by face, one badge per market. Offers, reviews and payment records are public, and nobody stands in the middle.</p>
${m.folders.length === 0 ? html`<p class="muted">No markets yet.</p>` : ''}
${m.folders.map((f) => html`<h2><a href="${f.url}">${w.title(f.folder)}</a></h2>${marketList(f.markets)}`)}`
  return layout(v.urls, { title: 'Forest: find people you can trust', description: 'Offers from verified real people, with reviews backed by payments. Open to everyone, no sign-in.', url: m.url, json: m.json, jsonLd: homeLd(m) }, body)
}

export function folderPage(v: View, m: FolderModel): string {
  const body = html`<p class="small"><a href="${v.urls.home()}">All markets</a></p>
<h1>${w.title(m.folder)}</h1>
${marketList(m.markets)}`
  return layout(v.urls, { title: `${w.title(m.folder)} · Forest`, description: `Markets in ${w.title(m.folder)} on Forest.`, url: m.url, json: m.json, jsonLd: folderLd(m) }, body)
}

export function marketPage(v: View, m: MarketModel): string {
  const name = w.title(m.market.name)
  const body = html`<p class="small"><a href="${m.folderUrl}">${w.title(m.market.folder)}</a></p>
<h1>${name}</h1>
<p>${m.market.description}</p>
<p class="small muted">${w.plural(m.counts.offers, 'offer')} · ${w.plural(m.counts.requests, 'request')} · ${w.plural(m.counts.badgedProfiles, 'verified real person', 'verified real people')}</p>
<h2>How deals go</h2>
${m.market.howDealsGo.split(/\n+/).map((line) => html`<p>${line}</p>`)}
<h2>Offers</h2>
<p class="small muted">Verified real people first, then by standing, then newest. <a href="${SCORING_DOC}">How the scores work</a>.</p>
${nearLine(m.near)}
${m.offers.length ? html`<ul class="cards">${m.offers.map((o) => offerCard(v, o, true))}</ul>` : html`<p class="muted">No offers yet.</p>`}
${m.next ? html`<p><a href="${m.next}">More offers</a></p>` : ''}`
  // A near search is a view of the market, not a page of its own: open to all, not for search engines to list.
  return layout(v.urls, { title: `${name} · Forest`, description: m.market.description, url: m.url, json: m.json, jsonLd: marketLd(m, v.currencies), noindex: m.near !== null }, body)
}

export function profilePage(v: View, m: ProfileModel): string {
  const p = m.profile
  const counted = m.badges.filter((b) => b.counted)
  const uncounted = m.badges.filter((b) => !b.counted)
  const uniq = new Map(m.scores.uniqueness.map((s) => [s.scope, s.value]))
  const t = m.scores.standing
  const details = (t?.details ?? { reviews: { received: 0, counted: 0, withReceipt: 0 } }) as { reviews: { received: number; counted: number; withReceipt: number } }
  const rating = { value: m.scores.rating?.value ?? null, reviews: (m.scores.rating?.details as { reviews: number } | undefined)?.reviews ?? 0 }
  const home = p.market && p.marketUrl ? html`<p class="small">${p.side ? `${w.title(p.side)} in ` : 'In '}<a href="${p.marketUrl}">${w.title(p.market)}</a></p>` : ''
  const body = html`<h1>${p.name}</h1>
${home}
${p.about ? html`<p>${p.about}</p>` : ''}
${p.contact ? html`<p><strong>Contact:</strong> ${p.contact}</p>` : ''}

<h2>Real person</h2>
${counted.length
    ? html`<ul class="cards">${counted.map(
        (b) => html`<li><h3>${w.BADGE}</h3>
<p>In <a href="${b.marketUrl}">${w.title(b.market)}</a>${b.side ? `, as ${b.side}` : ''}${b.registeredAt ? ` · since ${w.date(b.registeredAt)}` : ''}</p>
<p class="small muted">Vouched for by ${b.issuer.name ?? 'an issuer this index gives no weight'}. How sure this index is that it is one real person: <span class="score">${w.percent(uniq.get(b.scope) ?? 0)}</span></p></li>`,
      )}</ul>`
    : html`<p class="muted">No real-person badge counted for this profile.</p>`}
${uncounted.map((b) => html`<p class="small warn">A badge for ${w.title(b.market)}: ${w.badgeWhyNot(b.why)}</p>`)}

<h2>Rating</h2>
<p><span class="score">${rating.value === null ? 'None yet' : `${w.outOf10(rating.value)} of 10`}</span> <span class="muted">${rating.value === null ? 'No review that counts gives an overall rating yet.' : `from ${w.plural(rating.reviews, 'review')}`}</span></p>
<p class="small muted">The overall ratings in the reviews that count, averaged with the same weights as standing: by who wrote each and the payment behind it.</p>

<h2>Standing</h2>
<p><span class="score">${w.score(t?.value ?? 0)}</span> <span class="muted">${details.reviews.counted === 0 ? 'No reviews counted yet.' : `from ${w.plural(details.reviews.counted, 'review')}, ${details.reviews.withReceipt} backed by a payment`}</span></p>
<p class="small muted">What the people they dealt with said, weighed by who said it and by the payment behind it. Everyone starts at 0 and it can go below. It is separate from the rating and from the real-person check. <a href="${SCORING_DOC}">How it works</a>.</p>

<h2>Offers</h2>
${m.offers.length ? html`<ul class="cards">${m.offers.map((o) => offerCard(v, o, false))}</ul>` : html`<p class="muted">No offers right now.</p>`}
${m.requests.length ? html`<h2>Looking for</h2><ul class="cards">${m.requests.map((o) => offerCard(v, o, false))}</ul>` : ''}

<h2>Reviews</h2>
${m.reviews.received.length ? html`<ul class="cards">${m.reviews.received.map((r) => reviewCard(r, 'author'))}</ul>` : html`<p class="muted">No reviews yet.</p>`}
${m.reviews.given.length ? html`<h2>Reviews they wrote</h2><ul class="cards">${m.reviews.given.map((r) => reviewCard(r, 'subject'))}</ul>` : ''}

${m.credentials.length ? html`<h2>Credentials</h2><ul class="cards">${m.credentials.map((c) => html`<li><p>From <span class="id">${c.issuer}</span>${c.createdAt ? ` · ${w.date(c.createdAt)}` : ''}</p></li>`)}</ul>` : ''}

<p class="small muted">Permanent ID: <span class="id">${m.did}</span>${p.createdAt ? ` · profile made ${w.date(p.createdAt)}` : ''}</p>`
  return layout(v.urls, { title: `${p.name} · Forest`, description: p.about ?? `${p.name} on Forest.`, url: m.url, json: m.json, jsonLd: profileLd(m, v.currencies) }, body)
}

type Party = { name: string; url: string } & Numbers

function names(list: Party[]): { text: string; html: Raw } {
  if (!list.length) return { text: 'someone with no profile here', html: html`someone with no profile here` }
  return { text: list.map((p) => p.name).join(' / '), html: html`${list.map((p, i) => html`${i ? ' / ' : ''}<a href="${p.url}">${p.name}</a>`)}` }
}

/** Each party's two numbers, under their name. */
function partyNumbers(list: Party[]): Raw {
  return html`${list.map((p) => html`<br><span class="small muted">${p.name}: ${w.rating(p.rating)} · Standing ${w.score(p.standing)}</span>`)}`
}

export function dealPage(v: View, m: DealModel): string {
  const r = m.receipt
  let receipt: Raw
  if (!r) {
    receipt = html`<p>This index has no payment record for this deal. Reviews that name it count for little.</p>`
  } else {
    const buyer = names(r.buyerProfiles)
    const seller = names(r.sellerProfiles)
    const amount = w.moneyFromBase(r.amount, r.mint, v.currencies)
    const paid = r.fundedAt !== null || r.outcome !== null
    const n = { buyer: buyer.text, seller: seller.text, toSeller: w.moneyFromBase(r.toSeller ?? '0', r.mint, v.currencies).text, toBuyer: w.moneyFromBase(r.toBuyer ?? '0', r.mint, v.currencies).text }
    const status = r.closed
      ? 'Closed before any payment.'
      : r.outcome
        ? w.outcome(r.outcome, n)
        : paid
          ? 'Paid and held. Nothing moves until both sides agree.'
          : 'Waiting for payment.'
    const weight = r.closed || !paid
      ? 'Not paid, so reviews that name it count for little.'
      : r.creator === 'seller'
        ? `The ${r.sides.seller} asked for this payment, so both sides agreed to it and reviews that name it count in full.`
        : `Only the payer’s side is on record: a review that names it counts half, and in full once the ${r.sides.seller} reviews this deal too.`
    receipt = html`<p class="score">${amount.text}</p>
<dl>
<dt>From</dt><dd>${buyer.html}${partyNumbers(r.buyerProfiles)}</dd>
<dt>To</dt><dd>${seller.html}${partyNumbers(r.sellerProfiles)}</dd>
<dt>Started by</dt><dd>${r.creator === 'seller' ? html`${seller.html} (asked for payment)` : buyer.html}${r.createdAt ? ` · ${w.date(r.createdAt)}` : ''}</dd>
${r.fundedAt ? html`<dt>Payment marked</dt><dd>${w.date(r.fundedAt)}</dd>` : ''}
<dt>${r.endedAt ? 'Ended' : 'Now'}</dt><dd>${status}${r.endedAt ? ` ${w.date(r.endedAt)}.` : ''}</dd>
</dl>
<p class="small muted">${weight}</p>`
  }
  const body = html`<h1>Payment receipt</h1>
${receipt}
<h2>Reviews that name this deal</h2>
${m.reviews.length ? html`<ul class="cards">${m.reviews.map((x) => reviewCard(x, 'both'))}</ul>` : html`<p class="muted">None yet.</p>`}
<p class="small muted">Deal: <span class="id">${m.dealId}</span></p>`
  return layout(v.urls, { title: 'Payment receipt · Forest', description: r ? 'A payment between two people on Forest, and the reviews that name it.' : 'A deal on Forest with no payment record.', url: m.url, json: m.json, jsonLd: dealLd(m, v.currencies), noindex: !r }, body)
}

export function searchPage(v: View, m: SearchModel): string {
  const body = html`<h1>${m.q ? html`Results for “${m.q}”` : 'Search'}</h1>
${m.q && m.markets.length ? html`<h2>Markets</h2>${marketList(m.markets)}` : ''}
${m.q ? html`<h2>Offers</h2>${nearLine(m.near)}${m.offers.length ? html`<ul class="cards">${m.offers.map((o) => offerCard(v, o, true))}</ul>` : html`<p class="muted">No offers match.</p>`}` : html`<p class="muted">Type what you need above: a service, a skill, a place.</p>`}`
  return layout(v.urls, { title: m.q ? `${m.q} · Search · Forest` : 'Search · Forest', description: 'Search offers on Forest.', url: m.url, json: m.json, jsonLd: searchLd(m, v.currencies), noindex: true }, body, m.q)
}

const PAY_CHECK: Record<PayModel['check'], string> = {
  matches: 'This link matches the offer as it is now.',
  changed: 'The offer has changed since this link was made. Below is the offer as it is now.',
  differs: 'This link doesn’t match the offer it names: its price or terms were changed.',
  notLive: 'This offer isn’t open any more.',
  noPrice: 'This offer names no price.',
  noKey: 'This seller hasn’t named how to be paid yet.',
  notFound: 'This index has no offer at the address in this link.',
  invalid: 'This isn’t a complete pay link.',
}

export function payPage(v: View, m: PayModel): string {
  const o = m.offer
  const ok = m.check === 'matches' || m.check === 'changed'
  const body = html`<h1>Pay for an offer</h1>
<p class="${ok ? '' : 'warn'}">${PAY_CHECK[m.check]}</p>
${o
    ? html`<ul class="cards">${offerCard(v, { ...o, payLink: null }, true)}</ul>`
    : ''}
${ok ? html`<p>To pay, open this link in the app you pay with. Forest itself never takes or holds anyone’s money: the payment is held between you and the seller until you both agree.</p>` : ''}`
  return layout(v.urls, { title: 'Pay · Forest', description: 'A link to pay for an offer on Forest.', url: m.url, json: m.json, jsonLd: payLd(m.url, o, v.currencies), noindex: true }, body)
}

export function notFoundPage(v: View, url: string, message: string): string {
  const body = html`<h1>Not found</h1><p>${message}</p><p><a href="${v.urls.home()}">Go to the home page</a></p>`
  return layout(v.urls, { title: 'Not found · Forest', description: message, url, json: null, jsonLd: null, noindex: true }, body)
}
