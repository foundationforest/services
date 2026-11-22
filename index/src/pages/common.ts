// What several pages share: what a profile shows (its ratings, trust and uniqueness, and its checks)
// as the JSON gives it, a listing as every page gives it (its page and its photos among it), a
// search or market result, and how the HTML draws each from the object: a market's icon on its
// color, a profile's animal, the badges, a rating, a result in its one look (a picture and three
// lines in a grid, or two lines in a list, by its market's preview), the words of an answer as the markets read it, each
// price and place in the app's words (words.ts), a beta market's flag and line, the line for a
// market gone from the directory, and the fold that says what a profile's numbers mean.

import { type Asked, type DateValue, type Field, type Markets, nameWords, previewOf } from '@foundationforest/markets'

import { ANIMALS, animalOf } from '../animals.ts'
import { colorFor, NO_NUMBER } from '../avatar.ts'
import type { Check } from '../filter.ts'
import type { ListedApp } from '../lists.ts'
import { parse, type Store } from '../store.ts'
import { icon, marketIconOf } from './icons.ts'
import { html, Raw, type Site, urls } from './template.ts'
import { priceParts, priceText } from './words.ts'

/**
 * What a profile shows: its ratings, from 1 to 10 to one decimal, with how many raters scored it;
 * and its trust and uniqueness, whole numbers from 0 to 100. A profile that does not count shows no
 * rating, 0 and 0.
 */
export type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number }
/** A listing as every page gives it: its address and body, its own page, and a link to each of its photos. */
export type Listing = { address: string; body: { [key: string]: unknown }; url: string; photos: string[] }
export type Result = { profile: string; market: string; role: string; listing: Listing } & Shown & { checks: Check[] }

const SHA256 = /^[0-9a-f]{64}$/

/** The first host a profile entry names, where the person's app writes every entry and file first. */
export function firstHost(profileEntry: unknown): string | undefined {
  const hosts = (profileEntry as { hosts?: unknown } | null)?.hosts
  return Array.isArray(hosts) && typeof hosts[0] === 'string' ? hosts[0] : undefined
}

/**
 * The files a field of a body names: its value, or each of its values, when every one is the
 * SHA-256 of a file the body's `files` lists (the markets' photo, read by its shape); else none.
 */
export function filesIn(body: { [key: string]: unknown }, name: string): string[] {
  const listed = new Set((Array.isArray(body.files) ? body.files : []).map((f) => (f as { sha256?: unknown } | null)?.sha256))
  const values = Array.isArray(body[name]) ? (body[name] as unknown[]) : [body[name]]
  return name !== 'files' && values.length && values.every((v) => typeof v === 'string' && SHA256.test(v) && listed.has(v)) ? (values as string[]) : []
}

/**
 * The links to a listing's photos, the files its fields name, at `host`, the profile entry's first
 * host, by the host's own read, `<host>/v1/files/<sha256>`. The index keeps no bytes.
 */
export function photosOf(body: { [key: string]: unknown }, host: string | undefined): string[] {
  return host ? [...new Set(Object.keys(body).flatMap((name) => filesIn(body, name)))].map((sha) => `${host}/v1/files/${sha}`) : []
}

export const listingOf = (base: string, address: string, body: { [key: string]: unknown }, host: string | undefined): Listing => ({ address, body, url: urls(base).listing(address), photos: photosOf(body, host) })

/** Where to message a profile: one link per app the lists name, its address in each. */
export const messageOf = (apps: ListedApp[], address: string) => apps.map((a) => ({ name: a.name, url: a.message.replaceAll('{address}', encodeURIComponent(address)) }))

/** Where to message a profile about one of its listings: each app's `about` link, the profile's address and the listing's full address in it. */
export const aboutOf = (apps: ListedApp[], address: string, listing: string) =>
  apps.map((a) => ({ name: a.name, url: a.about.replaceAll('{address}', encodeURIComponent(address)).replaceAll('{listing}', encodeURIComponent(listing)) }))

/**
 * The fields a market asks a role's listing, in order, as the markets' `ask` gives them: its
 * preview's first, each after the fields its `when` names, then the rest, `contact` last, each with
 * its piece, its rules and its words for that role. None for a market the directory does not list or
 * a role it does not have.
 */
export function askedOf(markets: Markets, market: string | null, role: string | null): Asked[] {
  const m = market === null ? undefined : markets.market(market)
  return m && m.roles.some((r) => r.role === role) ? markets.ask(m.name, role!) : []
}

/** Each asked field's piece: `photo` names photos, `price`, `place` and the rest of the markets' eight. */
export const piecesOf = (asked: Asked[]): { [field: string]: string } => Object.fromEntries(asked.map((a) => [a.name, a.piece]))

/** Each asked number field's unit, as its market names it: `{ minutes: "minutes" }`. A count names none. */
export const unitsOf = (asked: Asked[]): { [field: string]: string } => Object.fromEntries(asked.flatMap((a) => (a.unit ? [[a.name, a.unit]] : [])))

/**
 * How each value a body holds reads, for each of its choice fields, as the markets' `ask` gives its
 * choices: `{ size: { xl: "XL" } }`, `{ languages: { es: "Spanish" } }`. Only those the body holds,
 * so a listing's JSON stays the size of the listing.
 */
export function labelsOf(asked: Asked[], body: { [key: string]: unknown }): { [field: string]: { [value: string]: string } } {
  const out: { [field: string]: { [value: string]: string } } = {}
  for (const a of asked) {
    if (!a.choices || !Object.hasOwn(body, a.name)) continue
    const held = (Array.isArray(body[a.name]) ? (body[a.name] as unknown[]) : [body[a.name]]).flatMap((v) => a.choices!.filter((c) => c.value === v))
    if (held.length) out[a.name] = Object.fromEntries(held.map((c) => [c.value, c.label]))
  }
  return out
}

/** Whether a listing fits its market, by the markets' `checkEntry`: only then do the markets read its answers. */
export const fits = (markets: Markets, market: string | null, role: string | null, body: { [key: string]: unknown }) =>
  market !== null && role !== null && markets.checkEntry(market, role, 'listing', body) === null

/** A field's name in words, where its market gives it no label: `pastWork` is "Past work". */
export const fieldLabel = nameWords

type ShownColumns = { value: number | null; count: number | null; trust: number | null; uniqueness: number | null }

export function shownOf(held: Partial<ShownColumns> | undefined): Shown {
  if (!held || held.count === null || held.count === undefined) return { ratings: { value: null, count: 0 }, trust: 0, uniqueness: 0 }
  return { ratings: { value: held.value ?? null, count: held.count }, trust: held.trust ?? 0, uniqueness: held.uniqueness ?? 0 }
}

/** What a profile shows, as the ratings table holds it, with its statement and signature; a profile that does not count has neither. */
export function shownFor(store: Store, address: string): Shown & { statement?: string; signature?: string } {
  const held = store.db.prepare('select value, count, trust, uniqueness, statement, signature from ratings where profile = ?').get(address) as
    | (ShownColumns & { statement: string; signature: string })
    | undefined
  return { ...shownOf(held), ...(held && { statement: held.statement, signature: held.signature }) }
}

/**
 * The listings this index lists, with their profiles, in the order Top rated gives them: by the
 * profile's ratings with one unit of its market's average added (rank.ts), then the newest listing.
 * `where` narrows them.
 */
export function results(store: Store, base: string, where = '', params: Array<string | number> = []): Array<Result & { time: number }> {
  const found = store.db
    .prepare(
      `select l.address, l.profile, l.body, l.time, f.market, f.role, f.checks, f.body as entry, r.value, r.count, r.trust, r.uniqueness
       from listings l join profiles f on f.address = l.profile left join ratings r on r.profile = l.profile
       where l.listed = 1 ${where}
       order by r.sort is null, r.sort desc, l.time desc, l.address`,
    )
    .all(...params) as Array<ShownColumns & { address: string; profile: string; body: string; time: number; market: string; role: string; checks: string; entry: string }>
  return found.map((r) => ({
    profile: r.profile,
    market: r.market,
    role: r.role,
    listing: listingOf(base, r.address, parse(r.body), firstHost(parse(r.entry))),
    ...shownOf(r),
    checks: parse(r.checks),
    time: r.time,
  }))
}

/** A market's name or a choice's value in words, as the markets manual writes them, hyphens as spaces and a capital first letter: `home-cleaning` is "Home cleaning", `like-new` "Like new". */
export function inWords(name: string): string {
  const words = name.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A plural word for `n` of them: "offer" for one, "offers" for any other number. */
export const wordFor = (n: number, word: string) => (n === 1 ? word.replace(/s$/, '') : word)

/** How many, in a role's word for its listings or another plural: "1 offer", "3 requests", "0 offers". */
export const countText = (n: number, word: string) => `${n} ${wordFor(n, word)}`

/** A role's word for its listings, from its market's file: `offers` or `requests`; none for a role the market does not name. */
export const wordOf = (site: Site, market: string | null, role: string | null) => (market ? site.markets.market(market)?.roles.find((r) => r.role === role)?.listings : undefined)

/** Whether a role's listings are requests, whose prices are the most they would pay: "Up to €60". */
export const isRequest = (site: Site, market: string | null, role: string | null) => wordOf(site, market, role) === 'requests'

/** What beta means, as a market's page says it under its summary. */
export const BETA = 'Beta: it works, at your own risk, and may change.'

/** The flag a beta market carries beside its name on its page, saying what beta means when pointed at. */
export const betaFlag = html`<span class="flag" title="${BETA}">Beta</span>`

/**
 * Whether a profile's market has left the directory: a profile entry names one the markets at
 * MARKETS no longer list. Such a profile counts for nothing (filter.ts), and its pages say why.
 */
export const isGone = (site: Site, market: string | null): market is string => market !== null && !site.markets.market(market)

/** The line a profile's or a listing's page shows when its market has left the directory. */
export const goneHtml = (market: string): Raw => html`<p class="s">Its market, ${inWords(market)}, is no longer in the markets directory, so nothing here counts.</p>`

/** A market's color, by its number in its market file (../avatar.ts); a market the directory no longer lists has none. */
export const colorOf = (site: Site, market: string | null) => (market === null ? NO_NUMBER : colorFor(site.markets.market(market)?.number))

/**
 * A market's icon, filled, the one its market file names; its name's first letter when it names
 * none, or one this index's copy of Phosphor lacks (icons.ts).
 */
export function marketIcon(site: Site, market: string): Raw {
  const name = site.markets.market(market)?.icon
  return (name && marketIconOf(name)) || html`<span class="letter">${market.charAt(0).toUpperCase()}</span>`
}

/** A market's icon on its color, `size` its class: `xs` beside words, `mk` on a photo, `md` at a page's head. Hidden from screen readers: the name beside it says it. */
export function marketHtml(site: Site, market: string, size: 'xs' | 'mk' | 'md'): Raw {
  return html`<span class="av ${size}" style="--h:${colorOf(site, market)}" aria-hidden="true">${marketIcon(site, market)}</span>`
}

/** Each animal's drawing, read once: its paths in one color on a 32 grid, the even-odd rule where it has one. */
const DRAWN = new Map(
  ANIMALS.map(([name, paths]) => [
    name,
    new Raw(
      `<svg class="i" data-animal="${name}" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" focusable="false">${paths.map((p) => (typeof p === 'string' ? `<path d="${p}"/>` : `<path d="${p.d}" fill-rule="evenodd" clip-rule="evenodd"/>`)).join('')}</svg>`,
    ),
  ]),
)

/**
 * A profile's picture: the app's animal for its address (../animals.ts), on its market's color,
 * solid when its role's listings are offers, light when they are requests, the pages' quiet ink for
 * one whose market this index does not hold, so a profile looks the same in the app and here.
 */
export function animalHtml(site: Site, address: string, market: string | null, role: string | null, size?: 'xs' | 'md' | 'lg'): Raw {
  const look = wordOf(site, market, role) !== 'offers'
  return html`<span class="${['av animal', size, look && 'look'].filter(Boolean).join(' ')}" style="--h:${colorOf(site, market)}" aria-hidden="true">${DRAWN.get(animalOf(address)[0])!}</span>`
}

/**
 * The two badges, by the check each stands for, as lists/verifiers.json names the foundation
 * verifier's two checks: a face for a face check, an ID card for an ID check, each a black square.
 */
const BADGES: { [label: string]: { words: string; icon: string } } = { 'ID check': { words: 'Verified with ID', icon: 'identification-card' }, 'face check': { words: 'Verified with a selfie', icon: 'smiley' } }

/**
 * How a profile is verified: a badge for each check this index counts for it, its words its label
 * and its title, the ID check's first. A check another index's list names otherwise takes the face's
 * badge, in the check's own words. None when this index counts no check for it.
 */
export function badgeHtml(checks: Check[], big = false): Raw {
  const labels = [...new Set(checks.map((c) => c.label))].sort((a, b) => (a === 'ID check' ? -1 : b === 'ID check' ? 1 : 0))
  if (!labels.length) return html``
  return html`<span class="badges">${labels.map((label) => {
    const badge = Object.hasOwn(BADGES, label) ? BADGES[label]! : { words: `Verified: ${label}`, icon: 'smiley' }
    return html`<span class="${big ? 'vb lg' : 'vb'}" role="img" aria-label="${badge.words}" title="${badge.words}">${icon(badge.icon, 'fill')}</span>`
  })}</span>`
}

/** A profile's name as the app writes it: its market in words, then its role, "Clothing seller". */
export const nameText = (market: string | null, role: string | null) => (market ? `${inWords(market)}${role ? ` ${role}` : ''}` : 'A profile')

/** A rating's star and value, "★ 9.2". */
export const starHtml = (value: number | string) => html`<span class="rate">${icon('star', 'fill')}${typeof value === 'number' ? value.toFixed(1) : value}</span>`

/**
 * A profile's rating as its page and a listing's say it: "★ 9.2 · 12 reviews", with how many
 * counted reviews it received; "No reviews yet" with none; "Not verified here" when this index
 * counts no check for it.
 */
export function ratedHtml(s: Shown & { checks: Check[] }, reviews: number): Raw {
  if (!s.checks.length) return html`<span class="s">Not verified here</span>`
  if (s.ratings.value === null) return html`<span class="s">No reviews yet</span>`
  return html`${starHtml(s.ratings.value)}<span class="s">· ${countText(reviews, 'reviews')}</span>`
}

/** A place, read by its shape: a circle, its point and its radius. */
export type Place = { lat: string; lon: string; radiusKm: number }
export const isPlace = (v: unknown): v is Place => {
  const o = v as Place | null
  return !!o && typeof o === 'object' && typeof o.lat === 'string' && typeof o.lon === 'string' && Number.isInteger(o.radiusKm)
}

/** Where a place's point is on openstreetmap.org, marked. */
export const mapUrl = (p: Place) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`

/** A price, as the markets write one. */
type Price = { amount: string; currency: string; per?: string; count?: string; note?: string }

/**
 * Each price a listing gives, in its writer's order: its price is always a list of them in the
 * markets' format; one held alone, as before it, is a list of one. Only those that are prices.
 */
export function pricesOf(body: { [key: string]: unknown }): Price[] {
  const held = body.price === undefined ? [] : Array.isArray(body.price) ? body.price : [body.price]
  return held.filter((m): m is Price => priceParts(m) !== null && typeof m.amount === 'string' && typeof m.currency === 'string')
}

/**
 * An answer as words on a page, as the markets' `read` says it in English: a choice by how its
 * value reads (es as Spanish), a number in its unit, a date's days and hours. `read` leaves a date's
 * zone out, so each answer with hours says its zone beside them, by its name. A photo is no words:
 * it is drawn as a photo; a place is drawn in the app's words (words.ts). Only for an answer that
 * fits its field (fits).
 */
export function answerText(markets: Markets, field: Field, value: unknown): string {
  if (field.piece === 'photo') return ''
  if (field.piece !== 'date') return markets.read(field, value)
  const answers = (field.several ? value : [value]) as DateValue[]
  return answers.map((v) => `${markets.read({ piece: 'date' }, v)}${v.zone === undefined ? '' : ` (${v.zone})`}`).join('; ')
}

/** An answer as words, read by its shape alone: for a listing that does not fit its market, whose answers the markets do not read. */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(valueText).join(', ')
  if (v && typeof v === 'object') {
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${valueText(x)}`)
      .join(', ')
  }
  return ''
}

/** The first line of a text, cut short at a word, with an ellipsis when cut. */
export function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0]!.trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  return `${(cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,.;:]+$/, '')}…`
}

/**
 * A listing's title, as the app writes it: its description's first line; else, for one with no
 * description, the first of its market's preview fields it holds, but its price and its photos, as
 * the markets read it when it fits its market, else by its shape; else "A listing".
 */
export function titleOf(site: Site, market: string | null, role: string | null, body: { [key: string]: unknown }): string {
  if (typeof body.description === 'string' && body.description.trim()) return firstLine(body.description, 140)
  const m = market === null ? undefined : site.markets.market(market)
  const read = fits(site.markets, market, role, body)
  const name = (m ? previewOf(m) : []).find((n) => n !== 'price' && n !== 'description' && m!.listing[n] && m!.listing[n]!.piece !== 'photo' && body[n] !== undefined)
  return (name && (read ? answerText(site.markets, m!.listing[name]!, body[name]) : valueText(body[name]))) || 'A listing'
}

/**
 * How a market's results are laid out, this index's opinion: a grid of pictures when the first
 * field its `preview` shows is a photo field, since its listings are things to look at; else a
 * list of two lines with no picture. Any index may choose otherwise.
 */
export function layoutOf(site: Site, market: string | null): 'grid' | 'list' {
  const m = market === null ? undefined : site.markets.market(market)
  const first = m ? previewOf(m)[0] : undefined
  return first !== undefined && m!.listing[first]?.piece === 'photo' ? 'grid' : 'list'
}

/** What a result draws, beside its listing: its profile's market, role and what it shows, and with a place, its distance. */
export type Shows = { market: string | null; role: string | null; listing: Listing & { listed?: boolean; why?: string }; km?: number } & Partial<Shown>

/**
 * A result's second line, quiet: its profile's rating with how many raters scored it, "★ 9.2 (14)",
 * then its distance, "2.3 km"; the distance alone with no rating, nothing with neither. On a
 * profile's own page, why a listing is not listed instead.
 */
function line2Html(r: Shows): Raw {
  if (r.listing.listed === false) return html`<span class="red">Not listed: ${r.listing.why}.</span>`
  const parts = [r.ratings?.value != null ? html`${starHtml(r.ratings.value)}<span>(${r.ratings.count})</span>` : null, r.km === undefined ? null : html`<span>${r.km} km</span>`].filter((p) => p !== null)
  return html`${parts.map((p, n) => html`${n ? html`<span>·</span>` : ''}${p}`)}`
}

/**
 * Results in their one look, as a grid of pictures or a list (layoutOf), each a link to the
 * listing's page. In a grid: its picture (its first photo, square; with none, its market's icon on
 * a tint of its color), with its market's mark on the photo when `mark`, as search shows results of
 * many markets; its title on a line of its own, never squeezed; its first price, in the app's words,
 * bold, under it; then the quiet line. In a list: its title with its first price at the right, then
 * the quiet line.
 */
export function resultsHtml(site: Site, items: Shows[], o: { layout: 'grid' | 'list'; mark?: boolean }): Raw {
  const one = (r: Shows) => {
    const price = priceText(pricesOf(r.listing.body)[0], isRequest(site, r.market, r.role))
    const title = html`<span class="t">${titleOf(site, r.market, r.role, r.listing.body)}</span>`
    const cost = price ? html`<span class="p">${price}</span>` : ''
    const quiet = html`<span class="l2">${line2Html(r)}</span>`
    if (o.layout === 'list') return html`<a class="result" href="${r.listing.url}"><span class="l1">${title}${cost}</span>${quiet}</a>`
    const photo = r.listing.photos[0]
    const pic = photo
      ? html`<img src="${photo}" alt="" loading="lazy">${o.mark && r.market ? marketHtml(site, r.market, 'mk') : ''}`
      : html`<span class="none" aria-hidden="true">${r.market ? marketIcon(site, r.market) : ''}</span>`
    return html`<a class="result" href="${r.listing.url}"><span class="pic" style="--h:${colorOf(site, r.market)}">${pic}</span>${title}${cost}${quiet}</a>`
  }
  return o.layout === 'list' ? html`<div class="list box">${items.map(one)}</div>` : html`<div class="grid">${items.map(one)}</div>`
}

/**
 * The fold "What these mean": a profile's rating, trust and uniqueness, each with one plain line,
 * the only place a page shows the last two; what README.md, How it scores, says, in plain words.
 * Drawn closed; from 900px the stylesheet shows it open (`wide`).
 */
export function numbersHtml(s: Shown): Raw {
  const n = s.ratings.count
  const rating =
    s.ratings.value === null
      ? html`<div class="num"><span class="d">–</span><p class="s">No rating: no one this index counts has rated it.</p></div>`
      : html`<div class="num"><span class="d">${s.ratings.value.toFixed(1)}</span><p class="s">The average of ${n} ${n === 1 ? "person's" : "people's"} reviews, from 1 to 10, each weighed by how much this index trusts them.</p></div>`
  return html`<details class="fold wide mean"><summary>${icon('info')}<span class="grow">What these mean</span>${icon('caret-down')}</summary><div class="fbody">${rating}
<div class="num"><span class="d">${s.trust}</span><p class="s">Trust, 0 to 100: it starts at 50; vouches and ratings raise it, reports lower it.</p></div>
<div class="num"><span class="d">${s.uniqueness}</span><p class="s">Uniqueness, 0 to 100: how sure this index is that it's one real person, and so how much its word weighs.</p></div></div></details>`
}

/** Dates in English, in UTC, the one zone a page with no script can give every reader. */
const DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const MONTH = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })

/** An entry's own time as its date, "Nov 6, 2026", or its month, "Nov 2026": its writer's word, as the JSON gives it. Nothing for a time no date holds. */
export function dateHtml(ms: number, month = false): Raw {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? html`` : html`<time datetime="${d.toISOString().slice(0, month ? 7 : 10)}">${(month ? MONTH : DAY).format(d)}</time>`
}

/**
 * A review as the pages draw one: its score with its star, its month and its text; with `writer`,
 * its writer's animal and short name, as a profile's page shows the reviews it received.
 */
export function reviewHtml(site: Site, r: { body: { [key: string]: unknown }; time: number; counted?: boolean; why?: string; market?: string | null; role?: string | null }, writer?: { address: string; short: string; url: string }): Raw {
  const score = typeof r.body.score === 'string' ? r.body.score : '–'
  return html`<div class="rv"><span class="line">${starHtml(score)}<span class="xs">${dateHtml(r.time, true)}</span></span>${typeof r.body.text === 'string' && r.body.text ? html`<span class="text">${r.body.text}</span>` : ''}${
    writer ? html`<a class="who" href="${writer.url}">${animalHtml(site, writer.address, r.market ?? null, r.role ?? null, 'xs')}<span>${writer.short}</span></a>` : ''
  }${r.counted === false ? html`<span class="s red">Does not count: ${r.why}.</span>` : ''}</div>`
}

/** A Person node for a profile, by its page. */
export const personOf = (address: string, base: string) => ({ '@type': 'Person', url: urls(base).profile(address), identifier: address })

/** A schema.org AggregateRating for a profile's ratings, or null when it has none. */
export function aggregateOf(s: Shown): { [key: string]: unknown } | null {
  if (s.ratings.value === null || !s.ratings.count) return null
  return { '@type': 'AggregateRating', ratingValue: s.ratings.value, bestRating: 10, worstRating: 1, ratingCount: s.ratings.count }
}

/**
 * A listing as a schema.org Offer, at its page, with its photos, each of its prices, and its
 * seller's rating. A price with a per is a price for its count of it, as its reference quantity.
 */
export function offerOf(r: Result, base: string): { [key: string]: unknown } {
  const body = r.listing.body
  const prices = pricesOf(body).map((p) => ({
    '@type': 'UnitPriceSpecification',
    price: p.amount,
    priceCurrency: p.currency,
    ...(typeof p.per === 'string' && { referenceQuantity: { '@type': 'QuantitativeValue', value: Number(p.count ?? 1), unitText: p.per } }),
  }))
  const rating = aggregateOf(r)
  return {
    '@type': 'Offer',
    identifier: r.listing.address,
    url: r.listing.url,
    ...(r.listing.photos.length > 0 && { image: r.listing.photos }),
    ...(typeof body.description === 'string' && { description: body.description }),
    seller: personOf(r.profile, base),
    ...(prices.length > 0 && { priceSpecification: prices }),
    ...(rating && { aggregateRating: rating }),
  }
}
