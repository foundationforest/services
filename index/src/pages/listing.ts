// `/profiles/<address>/listing/<id>`: one listing, at its own address under /profiles. Its photos,
// its fields in its market's order (the preview's first) with each one's type, who posted it and
// what that profile shows, and how to reach them: the contact the listing gives, and a link to
// message the profile from each app lists/apps.json names. A listing that is not listed has its page
// too, saying why, as its profile's page does.
//
// Drawn as the app would show it: its photos in a row that scrolls sideways, the description's first
// line as its heading, the price under it, the rest of the description, its other fields as label
// and value (a choice by its labels, a place as a link to its point on the map, the contact last),
// who posted it in one card linking to their profile, and the button to message them at the foot.
// On a laptop, the photos on the left, a big one with small ones under it, and the rest on the right.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { choiceText, colorOf, fieldLabel, fieldsOf, firstHost, firstLine, labelsOf, type Listing, listingOf, messageHtml, messageOf, nameHtml, offerOf, placeHtml, priceParts, priceText, profileAvatar, rateHtml, type Result, type Shown, shownFor, typesOf, valueText } from './common.ts'
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
  /** Its market's listing fields, in the order this page shows them: the preview's first, then the rest in the market's order. */
  fields: string[]
  /** Each of `fields`' type, as its market names it: a `file` field names photos. */
  types: { [field: string]: string }
  /** For each choice field it holds, the labels its market gives the values it holds, such as `{ size: { xl: "XL" } }`. */
  labels: { [field: string]: { [value: string]: string } }
  /** Where to message its profile: one link per app this index lists. */
  message: Array<{ name: string; url: string }>
}

const descriptionOf = (o: ListingPage) => (typeof o.listing.body.description === 'string' ? o.listing.body.description : '')

/** The price, then the description's first line, cut short. */
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
    const m = found.market === null ? undefined : markets.market(found.market)
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
      fields: fieldsOf(m),
      types: typesOf(m),
      labels: labelsOf(m, body),
      message: messageOf(lists.apps, found.profile),
    }
  },
  title: headingOf,
  description: (o) => descriptionOf(o) || null,
  body(o, base, site) {
    const body = o.listing.body
    // The fields: as its market orders them, then any the market does not name; never one drawn
    // above or below them (the description, the price), a field its market types `file` (drawn as
    // photos), or the standard's `files`, the list of what the files are. The contact comes last.
    const drawn = ['description', 'price', 'contact', 'files']
    const names = [...o.fields.filter((n) => n in body), ...Object.keys(body).filter((n) => !o.fields.includes(n))].filter((n) => !drawn.includes(n) && o.types[n] !== 'file' && valueText(body[n]))
    const { head, rest } = headOf(descriptionOf(o))
    const price = priceParts(body.price)
    const alt = descriptionOf(o)
    const contact = typeof body.contact === 'string' && body.contact ? body.contact : ''
    const value = (n: string) => (o.types[n] === 'choice' ? choiceText(body[n], o.labels[n]) : o.types[n] === 'place' ? placeHtml(body[n]) : valueText(body[n]))
    const facts = [...names.map((n) => html`<div class="kv"><dt>${fieldLabel(n)}</dt><dd>${value(n)}</dd></div>`), ...(contact ? [html`<div class="kv"><dt>Contact</dt><dd>${contactHtml(contact)}</dd></div>`] : [])]
    const photos = o.listing.photos.length
      ? html`<div class="gal"${o.market ? html` style="--h:${colorOf(site, o.market)}"` : ''}>${o.listing.photos.map((src) => html`<a href="${src}"><img src="${src}" alt="${alt}" loading="lazy"></a>`)}</div>`
      : null
    const info = html`<div class="info"><h1>${head || price?.amount || 'A listing'}</h1>${price ? html`<p class="cost"><span class="d big">${price.amount}</span>${price.per ? html` <span class="s">${price.per}</span>` : ''}</p>` : ''}${rest ? html`<p class="text">${rest}</p>` : ''}
${o.listing.listed ? '' : html`<p class="red">Not listed: ${o.listing.why}.</p>`}
${facts.length ? html`<dl class="card divide">${facts}</dl>` : ''}
<a class="card poster" href="${urls(base).profile(o.profile)}">${profileAvatar(site, o.market, o.role)}<span class="what">${nameHtml(o.market, o.role, o.checks)}<span class="rated">${rateHtml(o)}</span></span>${icon('caret-right')}</a>
${o.message.length ? html`<div class="foot">${messageHtml(o.message, o.role ? `Message the ${o.role}` : 'Message')}</div>` : ''}</div>`
    return html`<div class="bar">${backHtml(o.market ? urls(base).market(o.market) : urls(base).home, true)}</div>
${photos ? html`<div class="split">${photos}${info}</div>` : info}`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'ItemPage', '@id': url, url, mainEntity: offerOf(o as unknown as Result, base) }],
    }
  },
}
