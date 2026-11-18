// `/profiles/<address>/listing/<id>`: one listing, at its own address under /profiles. Its photos,
// its fields in the order its market asks its role (the preview's first) with each one's piece and
// each number's unit, who posted it and what that profile shows, and how to reach them: the contact
// the listing gives, and a link to message the profile from each app lists/apps.json names. A
// listing that is not listed has its page too, saying why, as its profile's page does.
//
// Drawn as the app would show it: its photos in a row that scrolls sideways, the description's first
// line as its heading, each of its prices under it, with its count for a pack and its note, the rest
// of the description, its other fields as label and value, each label its market's word for its
// role and each value as the markets read it (a choice by how its value reads, a number in its unit,
// a date with its zone beside its hours, a place as its numbers, linked to its point on the map),
// the contact last, who posted it in one card linking to their profile, and the button to message
// them at the foot; a listing whose market has left the directory says so, and its back link goes
// home. On a laptop, the photos on the left, a big one with small ones under it, and the rest on the
// right.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { answerText, askedOf, colorOf, fieldLabel, firstHost, firstLine, fits, goneHtml, isGone, labelsOf, type Listing, listingOf, messageHtml, messageOf, nameHtml, offerOf, piecesOf, placeHtml, priceParts, pricesOf, priceText, profileAvatar, rateHtml, type Result, type Shown, shownFor, unitsOf, valueText } from './common.ts'
import { icon } from './icons.ts'
import { backHtml, html, type Page, type Raw, urls } from './template.ts'

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
  /** The fields its market asks its role's listings, in that order, as the markets' ask gives them: the preview's first, contact last. */
  fields: string[]
  /** Each of `fields`' piece, as its market names it: a `photo` field names photos. */
  pieces: { [field: string]: string }
  /** Each of `fields`' number fields' unit, as its market names it: `{ minutes: "minutes" }`. A count names none. */
  units: { [field: string]: string }
  /** For each choice field it holds, how each value it holds reads, such as `{ size: { xl: "XL" } }`. */
  labels: { [field: string]: { [value: string]: string } }
  /** Where to message its profile: one link per app this index lists. */
  message: Array<{ name: string; url: string }>
}

const descriptionOf = (o: ListingPage) => (typeof o.listing.body.description === 'string' ? o.listing.body.description : '')

/** The first price, then the description's first line, cut short. */
const headingOf = (o: ListingPage) => [priceText(o.listing.body), firstLine(descriptionOf(o), 60)].filter(Boolean).join(' · ') || 'A listing'

/**
 * The heading, the description's first line, and the text under it, the rest. A first line longer
 * than a heading holds is cut short, and then the whole description is the text, so none is lost.
 */
function headOf(description: string): { head: string; rest: string } {
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
  data({ store, lists, markets, self, base }, [address, id]) {
    const found = store.db
      .prepare('select l.address, l.profile, l.body, l.time, l.listed, l.why, f.body as entry, f.market, f.role, f.checks from listings l left join profiles f on f.address = l.profile where l.address = ?')
      .get(`${address}/listing/${id}`) as
      | { address: string; profile: string; body: string; time: number; listed: number; why: string | null; entry: string | null; market: string | null; role: string | null; checks: string | null }
      | undefined
    if (!found) return null
    const { statement: _, signature: __, ...shown } = shownFor(store, found.profile)
    const asked = askedOf(markets, found.market, found.role)
    const body = parse<{ [key: string]: unknown }>(found.body)
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
      pieces: piecesOf(asked),
      units: unitsOf(asked),
      labels: labelsOf(asked, body),
      message: messageOf(lists.apps, found.profile),
    }
  },
  title: headingOf,
  description: (o) => descriptionOf(o) || null,
  body(o, base, site) {
    const body = o.listing.body
    // The fields: as its market orders them, then any the market does not name; never one drawn
    // above or below them (the description, the price), a photo field (drawn as photos), or the
    // standard's `files`, the list of what the files are. The contact comes last.
    const drawn = ['description', 'price', 'contact', 'files']
    const names = [...o.fields.filter((n) => n in body), ...Object.keys(body).filter((n) => !o.fields.includes(n))].filter((n) => !drawn.includes(n) && o.pieces[n] !== 'photo' && valueText(body[n]))
    // Each field's label and value as its market says them, for a listing that fits; one that does
    // not reads by its shape, under its name in words.
    const asked = askedOf(site.markets, o.market, o.role)
    const read = fits(site.markets, o.market, o.role, body)
    const fieldOf = (n: string) => asked.find((a) => a.name === n)
    const { head, rest } = headOf(descriptionOf(o))
    const prices = pricesOf(body).map(priceParts)
    const alt = descriptionOf(o)
    const contact = typeof body.contact === 'string' && body.contact ? body.contact : ''
    const value = (n: string) => {
      const field = fieldOf(n)
      if (!read || !field) return valueText(body[n])
      return field.piece === 'place' ? placeHtml(site.markets, body[n]) : answerText(site.markets, field, body[n])
    }
    const facts = [...names.map((n) => html`<div class="kv"><dt>${fieldOf(n)?.label ?? fieldLabel(n)}</dt><dd>${value(n)}</dd></div>`), ...(contact ? [html`<div class="kv"><dt>${fieldOf('contact')?.label ?? 'Contact'}</dt><dd>${contactHtml(contact)}</dd></div>`] : [])]
    const photos = o.listing.photos.length
      ? html`<div class="gal"${o.market ? html` style="--h:${colorOf(site, o.market)}"` : ''}>${o.listing.photos.map((src) => html`<a href="${src}"><img src="${src}" alt="${alt}" loading="lazy"></a>`)}</div>`
      : null
    const info = html`<div class="info"><h1>${head || prices[0]?.amount || 'A listing'}</h1>${prices.map((p) => html`<p class="cost"><span class="d big">${p!.amount}</span>${p!.per ? html` <span class="s">${p!.per}</span>` : ''}${p!.note ? html` <span class="s">(${p!.note})</span>` : ''}</p>`)}${rest ? html`<p class="text">${rest}</p>` : ''}
${o.listing.listed ? '' : html`<p class="red">Not listed: ${o.listing.why}.</p>`}${isGone(site, o.market) ? goneHtml(o.market) : ''}
${facts.length ? html`<dl class="card divide">${facts}</dl>` : ''}
<a class="card poster" href="${urls(base).profile(o.profile)}">${profileAvatar(site, o.market, o.role)}<span class="what">${nameHtml(o.market, o.role, o.checks)}<span class="rated">${rateHtml(o)}</span></span>${icon('caret-right')}</a>
${o.message.length ? html`<div class="foot">${messageHtml(o.message, o.role ? `Message the ${o.role}` : 'Message')}</div>` : ''}</div>`
    return html`<div class="bar">${backHtml(o.market && !isGone(site, o.market) ? urls(base).market(o.market) : urls(base).home, true)}</div>
${photos ? html`<div class="split">${photos}${info}</div>` : info}`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'ItemPage', '@id': url, url, mainEntity: offerOf(o as unknown as Result, base) }],
    }
  },
}
