// `/profiles/<address>/listing/<id>`: one listing, at its own address under /profiles. Its photos,
// its fields in the order its market asks its role (its title and description first, then its
// preview's) with each one's piece and each number's unit, the name places gives each of its
// places' centres, who posted it and what that profile shows with the two latest reviews it
// received, and how to reach them: the contact the listing gives, and a link to message the profile
// about this listing from each app lists/apps.json names (its `about`). A listing that is not listed
// has its page too, saying why, as its profile's page does.
//
// Drawn the same with photos or without, the photos only adding the top: on a phone, full width and
// swiped sideways (CSS scroll snapping), each with "1 / 3"; on a laptop, one at a time with round
// arrows linking to each photo's anchor. Then its market and its role; its title, else the
// description's first line; its prices in the app's words (words.ts), each with its note under it;
// who posted it, their animal, short name, rating and badges, linking to their page; its details,
// each field's label small above its value as the markets read it, each place in words with a link
// to its point on a map, the contact last; the rest of its description, all of it under a title; the
// reviews; and the line saying this index lists it, linking its JSON. On a phone, a bar fixed at the
// foot with its price and Message; on a laptop, two columns, the right one staying in view, with its
// market, title, price, Message and who posted it, and the reviews under. A listing whose market has
// left the directory says so.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { aboutOf, animalHtml, answerText, askedOf, colorOf, fieldLabel, firstHost, firstLine, fits, goneHtml, inWords, isGone, isPlace, isRequest, type Listing, listingOf, mapUrl, marketHtml, offerOf, piecesOf, pricesOf, ratedHtml, type Result, reviewHtml, type Shown, shownFor, unitsOf, valueText, labelsOf, badgeHtml, titleIn } from './common.ts'
import { icon } from './icons.ts'
import { type ReviewColumns, type ReviewEntry, reviewEntry } from './profile.ts'
import { html, type Page, type Raw, short, urls } from './template.ts'
import { placeText, priceParts, priceText } from './words.ts'

/** How many of the reviews its profile received a listing's page gives: the newest. */
export const LATEST = 2

export type ListingPage = {
  index: string
  /** The address of the profile that posted it. */
  profile: string
  /** Its profile's market and role; null when the profile has no profile entry here. */
  market: string | null
  role: string | null
  /** The listing, with its entry's time, whether it is listed and, when not, why. */
  listing: Listing & { time: number; listed: boolean; why?: string }
  checks: Check[]
} & Shown & {
  /** The fields its market asks its role's listings, in that order, as the markets' ask gives them: title and description first, then the preview's, contact last. */
  fields: string[]
  /** Each of `fields`' piece, as its market names it: a `photo` field names photos. */
  pieces: { [field: string]: string }
  /** Each of `fields`' number fields' unit, as its market names it: `{ minutes: "minutes" }`. A count names none. */
  units: { [field: string]: string }
  /** For each choice field it holds, how each value it holds reads, such as `{ size: { xl: "XL" } }`. */
  labels: { [field: string]: { [value: string]: string } }
  /** For each place field it holds, the caption places gives each place's centre, in its answers' order; null where places names none. */
  captions: { [field: string]: Array<string | null> }
  /** The reviews its profile received that count here: how many, and the newest LATEST, as its profile's page gives them. */
  reviews: { count: number; latest: ReviewEntry[] }
  /** Where to message its profile about this listing: one link per app this index lists, its `about` link. */
  message: Array<{ name: string; url: string }>
}

const descriptionOf = (o: ListingPage) => (typeof o.listing.body.description === 'string' ? o.listing.body.description : '')

/**
 * The heading and the text under it: with a title, the title and the whole description; else the
 * description's first line and the rest. A first line longer than a heading holds is cut short, and
 * then the whole description is the text, so none is lost.
 */
function headOf(o: ListingPage): { head: string; rest: string } {
  const title = titleIn(o.listing.body)
  const description = descriptionOf(o)
  if (title) return { head: title, rest: description.trim() }
  const [first = '', ...more] = description.split('\n')
  const line = first.trim()
  return line.length <= 100 ? { head: line, rest: more.join('\n').trim() } : { head: firstLine(line, 100), rest: description.trim() }
}

/**
 * A contact as its writer gave it: a link when it is an http or https URL, its words without the
 * scheme or a trailing slash ("wa.me/34600000000"), or an email address, its words the address
 * alone; else its words.
 */
function contactHtml(contact: string): Raw {
  const text = contact.trim()
  if (/^https?:\/\/\S+$/i.test(text) && URL.canParse(text)) return html`<a href="${text}" rel="nofollow ugc">${text.replace(/^https?:\/\//i, '').replace(/\/$/, '')}${icon('arrow-up-right', 'bold', 'xs')}</a>`
  const address = text.replace(/^mailto:/i, '')
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(address)) return html`<a href="mailto:${address}" rel="nofollow ugc">${address}</a>`
  return html`${contact}`
}

export const listing: Page<ListingPage> = {
  name: 'listing',
  async data({ store, lists, markets, self, base, places }, [address, id]) {
    const found = store.db
      .prepare('select l.address, l.profile, l.body, l.time, l.listed, l.why, f.body as entry, f.market, f.role, f.checks from listings l left join profiles f on f.address = l.profile where l.address = ?')
      .get(`${address}/listing/${id}`) as
      | { address: string; profile: string; body: string; time: number; listed: number; why: string | null; entry: string | null; market: string | null; role: string | null; checks: string | null }
      | undefined
    if (!found) return null
    const { statement: _, signature: __, ...shown } = shownFor(store, found.profile)
    const asked = askedOf(markets, found.market, found.role)
    const body = parse<{ [key: string]: unknown }>(found.body)
    // Each place field's places, by its piece, or by its shape where its market names none, each
    // named by places at its centre, as words.ts picks the name for its size.
    const pieces = piecesOf(asked)
    const captions: ListingPage['captions'] = {}
    for (const [name, v] of Object.entries(body)) {
      const answers = (Array.isArray(v) ? v : [v]).filter(isPlace)
      if (!answers.length || (name in pieces && pieces[name] !== 'place')) continue
      captions[name] = await Promise.all(answers.map((p) => places.caption(Number(p.lat), Number(p.lon), p.radiusKm)))
    }
    const received = (
      store.db
        .prepare(
          `select e.address, e.reviewer, e.subject, e.body, e.time, e.counted, e.why, e.weight, f.market, f.role, f.checks
           from reviews e left join profiles f on f.address = e.reviewer where e.subject = ? and e.counted = 1 order by e.time desc, e.address`,
        )
        .all(found.profile) as ReviewColumns[]
    ).map(reviewEntry)
    return {
      index: self,
      profile: found.profile,
      market: found.market,
      role: found.role,
      listing: {
        ...listingOf(base, found.address, body, firstHost(found.entry === null ? null : parse(found.entry))),
        time: found.time,
        listed: found.listed === 1,
        ...(found.why !== null && found.listed !== 1 && { why: found.why }),
      },
      checks: found.checks === null ? [] : parse(found.checks),
      ...shown,
      fields: asked.map((a) => a.name),
      pieces,
      units: unitsOf(asked),
      labels: labelsOf(asked, body),
      captions,
      reviews: { count: received.length, latest: received.slice(0, LATEST) },
      message: aboutOf(lists.apps, found.profile, found.address),
    }
  },
  // Its title is its first price, in the app's words, and its own title, else its description's
  // first line.
  title: (o, site) => [priceText(pricesOf(o.listing.body)[0], isRequest(site, o.market, o.role)), titleIn(o.listing.body) || firstLine(descriptionOf(o), 60)].filter(Boolean).join(' · ') || 'A listing',
  description: (o) => descriptionOf(o) || null,
  body(o, base, site) {
    const body = o.listing.body
    const request = isRequest(site, o.market, o.role)
    // The fields: as its market orders them, then any the market does not name; never one drawn
    // above or below them (the title, the description, the price), a photo field (drawn as photos),
    // or the standard's `files`, the list of what the files are. The contact comes last.
    const drawn = ['title', 'description', 'price', 'contact', 'files']
    const names = [...o.fields.filter((n) => n in body), ...Object.keys(body).filter((n) => !o.fields.includes(n))].filter((n) => !drawn.includes(n) && o.pieces[n] !== 'photo' && valueText(body[n]))
    // Each field's label and value as its market says them, for a listing that fits; one that does
    // not reads by its shape, under its name in words, but its places, in words wherever they are.
    const asked = askedOf(site.markets, o.market, o.role)
    const read = fits(site.markets, o.market, o.role, body)
    const fieldOf = (n: string) => asked.find((a) => a.name === n)
    const { head, rest } = headOf(o)
    const prices = pricesOf(body)
    const contact = typeof body.contact === 'string' && body.contact ? body.contact : ''
    const value = (n: string): Raw | string => {
      if (o.captions[n]) {
        const answers = (Array.isArray(body[n]) ? (body[n] as unknown[]) : [body[n]]).filter(isPlace)
        return html`${answers.map((p, i) => html`${i ? html`<br>` : ''}${placeText(p, o.captions[n]![i])}<br><a href="${mapUrl(p)}">See on a map${icon('arrow-up-right', 'bold', 'xs')}</a>`)}`
      }
      const field = fieldOf(n)
      return !read || !field ? valueText(body[n]) : answerText(site.markets, field, body[n])
    }
    const facts = [...names.map((n) => html`<div class="kv"><dt>${fieldOf(n)?.label ?? fieldLabel(n)}</dt><dd>${value(n)}</dd></div>`), ...(contact ? [html`<div class="kv"><dt>${fieldOf('contact')?.label ?? 'Contact'}</dt><dd>${contactHtml(contact)}</dd></div>`] : [])]
    const n = o.listing.photos.length
    const at = (i: number) => `#photo-${((i + n) % n) + 1}`
    const photos = n
      ? html`<div class="gal" style="--h:${colorOf(site, o.market)}">${o.listing.photos.map(
          (src, i) =>
            html`<figure class="ph" id="${`photo-${i + 1}`}"><img src="${src}" alt="${titleIn(body) || descriptionOf(o)}"${i ? html` loading="lazy"` : ''}>${
              n > 1 ? html`<a class="round back" href="${at(i - 1)}" aria-label="Previous photo">${icon('caret-left', 'bold')}</a><a class="round next" href="${at(i + 1)}" aria-label="Next photo">${icon('caret-right', 'bold')}</a>` : ''
            }<span class="at">${i + 1} / ${n}</span></figure>`,
        )}</div>`
      : ''
    const [first, ...others] = o.message
    const firstPrice = priceText(prices[0], request)
    const dock = first
      ? html`<div class="dock"><span class="dp">${firstPrice ? html`<b class="d">${firstPrice}</b>` : ''}<span class="xs">Opens the ${first.name}</span></span><a class="btn go" href="${first.url}">${icon('paper-plane-tilt', 'bold')}Message</a></div>${
          others.length ? html`<div class="s">${others.map((m, i) => html`${i ? ' · ' : ''}<a class="link" href="${m.url}">Message in the ${m.name}</a>`)}</div>` : ''
        }`
      : ''
    const who = html`<a class="poster" href="${urls(base).profile(o.profile)}">${animalHtml(site, o.profile, o.market, o.role, 'md')}<span class="who"><b>${short(o.profile)}${badgeHtml(o.checks)}</b><span class="rated">${ratedHtml(o, o.reviews.count)}</span></span>${icon('caret-right')}</a>`
    const reviews = o.reviews.latest.length
      ? html`<section class="reviews box" aria-label="Reviews"><h2>Reviews</h2>${o.reviews.latest.map((r) => reviewHtml(site, r))}<a class="link" href="${urls(base).profile(o.profile)}#reviews">All ${o.reviews.count} ${o.reviews.count === 1 ? 'review' : 'reviews'}</a></section>`
      : ''
    return html`<div class="lpage">${photos}<div class="side"><div class="sum"><div class="from">${o.market ? html`<span class="mk">${isGone(site, o.market) ? '' : marketHtml(site, o.market, 'xs')}${inWords(o.market)}</span>` : ''}${o.role ? html`<span class="flag">${inWords(o.role)}</span>` : ''}</div>
<h1>${head || firstPrice || 'A listing'}</h1>${prices.length ? html`<div class="prices">${prices.map((p) => html`<p><span class="d">${priceText(p, request)}</span>${priceParts(p)!.note ? html`<br><span class="note">${priceParts(p)!.note}</span>` : ''}</p>`)}</div>` : ''}
${o.listing.listed ? '' : html`<p class="red">Not listed: ${o.listing.why}.</p>`}${isGone(site, o.market) ? goneHtml(o.market) : ''}${dock}${who}</div>${reviews}</div>
${facts.length ? html`<dl class="details box">${facts}</dl>` : ''}${rest ? html`<section class="about"><h2>About</h2><p class="text">${rest}</p></section>` : ''}
<p class="listed">Listed by this index. For AI agents: <a href="${o.listing.url}.json">this page as JSON</a></p></div>`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'ItemPage', '@id': url, url, mainEntity: offerOf(o as unknown as Result, base) }],
    }
  },
}
