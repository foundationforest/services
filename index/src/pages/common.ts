// What several pages share: what a profile shows (its ratings, trust, uniqueness and checks) as the
// JSON gives it, a listing as every page gives it (its page and its photos among it), a search or
// market result, and how the HTML draws each from the object, in the parts the Forest app draws: a
// profile's avatar, name and badge, its rating, a listing's card, a result's card, the words of a
// field's value, a number or a range in its unit, each price with its count, a beta market's chip
// and line, the line for a market gone from the directory, and the fold that says what a profile's
// numbers mean.

import { type Market, previewOf } from '@foundationforest/markets'

import { colorFor } from '../avatar.ts'
import type { Check } from '../filter.ts'
import type { ListedApp } from '../lists.ts'
import { parse, type Store } from '../store.ts'
import { icon, marketIconOf } from './icons.ts'
import { html, type Raw, type Site, urls } from './template.ts'

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
 * SHA-256 of a file the body's `files` lists (the markets' `file` type, read by its shape); else none.
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

/**
 * A market's listing fields, in the order a listing's page shows them: those that matter first, as the
 * markets' `previewOf` gives them, then the rest in the market's order.
 */
export function fieldsOf(m: Market | undefined): string[] {
  if (!m) return []
  const preview = previewOf(m)
  return [...preview, ...Object.keys(m.listing).filter((n) => !preview.includes(n))]
}

/** Each of a market's listing fields' type, as its file names it: `file`, `money`, `place` and the rest of the markets' types. */
export function typesOf(m: Market | undefined): { [field: string]: string } {
  return m ? Object.fromEntries(Object.entries(m.listing).map(([name, field]) => [name, field.type])) : {}
}

/** Each of a market's number fields' unit, as its file names it: `{ minutes: "minutes" }`. */
export function unitsOf(m: Market | undefined): { [field: string]: string } {
  return m ? Object.fromEntries(Object.entries(m.listing).flatMap(([name, field]) => (field.unit ? [[name, field.unit]] : []))) : {}
}

/**
 * The labels of the values a body holds, for each of its market's choice fields that has some, as
 * its file gives them: `{ size: { xl: "XL" } }`. Only those the body holds, so a listing's JSON
 * stays the size of the listing.
 */
export function labelsOf(m: Market | undefined, body: { [key: string]: unknown }): { [field: string]: { [value: string]: string } } {
  const out: { [field: string]: { [value: string]: string } } = {}
  for (const [name, field] of Object.entries(m?.listing ?? {})) {
    const labels = field.type === 'choice' ? field.labels : undefined
    if (!labels || !Object.hasOwn(body, name)) continue
    const held = (Array.isArray(body[name]) ? (body[name] as unknown[]) : [body[name]]).filter((v): v is string => typeof v === 'string' && Object.hasOwn(labels, v))
    if (held.length) out[name] = Object.fromEntries(held.map((v) => [v, labels[v]!]))
  }
  return out
}

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
 * The listings this index lists, with their profiles, sorted as search sorts them: by the profile's
 * ratings with one unit of its market's average added (rank.ts), then the newest listing. `where`
 * narrows them.
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

/** A field's name as words: `pastWork` is "Past work". */
export function fieldLabel(name: string): string {
  const words = name.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A plural word for `n` of them: "offer" for one, "offers" for any other number. */
export const wordFor = (n: number, word: string) => (n === 1 ? word.replace(/s$/, '') : word)

/** How many, in a role's word for its listings or another plural: "1 offer", "3 requests". */
export const countText = (n: number, word: string) => `${n} ${wordFor(n, word)}`

/** A role's word for its listings, from its market's file: `offers` or `requests`; none for a role the market does not name. */
export const wordOf = (site: Site, market: string | null, role: string | null) => (market ? site.markets.market(market)?.roles.find((r) => r.role === role)?.listings : undefined)

/** What beta means, as a market page says it under its description. */
export const BETA = 'Beta: it works, at your own risk, and may change.'

/** The chip a beta market carries, on its tile and its page, saying what beta means when pointed at. */
export const betaChip = html`<span class="chip sm" title="${BETA}">Beta</span>`

/**
 * Whether a profile's market has left the directory: a profile entry names one the markets at
 * MARKETS no longer list. Such a profile counts for nothing (filter.ts), and its pages say why.
 */
export const isGone = (site: Site, market: string | null): market is string => market !== null && !site.markets.market(market)

/** The line a profile's or a listing's page shows when its market has left the directory. */
export const goneHtml = (market: string): Raw => html`<p class="s">Its market, ${inWords(market)}, is no longer in the markets directory, so nothing here counts.</p>`

/**
 * A market's avatar: its icon on its color, the icon its market file names and the color its number
 * gives (../avatar.ts), or its name's first letter when it names none. Solid for the market itself
 * and for a role that offers; light (`look`) for a role that requests. Hidden from screen readers:
 * the name beside it says it.
 */
export function avatarHtml(site: Site, market: string | null, o: { look?: boolean; size?: 'xs' | 'lg' } = {}): Raw {
  if (!market) return html``
  return html`<span class="${['av', o.size, o.look && 'look'].filter(Boolean).join(' ')}" style="--h:${colorOf(site, market)}" aria-hidden="true">${marketIcon(site, market)}</span>`
}

/** A market's color, by its number in its market file (../avatar.ts); a market the directory no longer lists has none. */
export const colorOf = (site: Site, market: string) => colorFor(site.markets.market(market)?.number)

/**
 * A market's icon, filled, the one its market file names; its name's first letter when it names
 * none, or one this index's copy of Phosphor lacks (icons.ts).
 */
export function marketIcon(site: Site, market: string): Raw {
  const name = site.markets.market(market)?.icon
  return (name && marketIconOf(name)) || html`<span class="letter">${market.charAt(0).toUpperCase()}</span>`
}

/** A profile's avatar: solid when its role's listings are offers, light when they are requests. */
export const profileAvatar = (site: Site, market: string | null, role: string | null, size?: 'xs' | 'lg') => avatarHtml(site, market, { look: wordOf(site, market, role) !== 'offers', ...(size && { size }) })

/**
 * The two badges, by the check each stands for, as lists/verifiers.json names the foundation
 * verifier's two checks: an ID check's solid, an ID card on the forest green; a face check's light,
 * a face on mint.
 */
const BADGES: { [label: string]: { words: string; id: boolean } } = { 'ID check': { words: 'Verified with ID', id: true }, 'face check': { words: 'Verified with a selfie', id: false } }

/**
 * How a profile is verified, by its strongest check: one of the app's two badges, its words its
 * label and its title. A check another index's list names otherwise takes the light badge, in the
 * check's own words. None when this index counts no check for it.
 */
export function badgeHtml(checks: Check[], big = false): Raw {
  if (!checks.length) return html``
  const label = ['ID check', 'face check'].find((l) => checks.some((c) => c.label === l)) ?? checks[0]!.label
  const badge = Object.hasOwn(BADGES, label) ? BADGES[label]! : { words: `Verified: ${label}`, id: false }
  return html`<span class="${['vb', badge.id && 'id', big && 'lg'].filter(Boolean).join(' ')}" role="img" aria-label="${badge.words}" title="${badge.words}">${icon(badge.id ? 'identification-card' : 'smiley', 'fill')}</span>`
}

/** A profile's name as the app writes it: its market in words, then its role, "Clothing seller". */
export const nameText = (market: string | null, role: string | null) => (market ? `${inWords(market)}${role ? ` ${role}` : ''}` : 'A profile')

/** A profile's name, its role quiet, its badge beside it. */
export function nameHtml(market: string | null, role: string | null, checks: Check[]): Raw {
  return html`<span class="nm">${market ? html`${inWords(market)}${role ? html` <span class="role">${role}</span>` : ''}` : 'A profile'}${badgeHtml(checks)}</span>`
}

/**
 * A profile's rating: the star, its value to one decimal and how many raters scored it, "(12)"; the
 * New chip when no one has rated it yet; that it is not verified here when this index counts no
 * check for it.
 */
export function rateHtml(s: Shown & { checks: Check[] }): Raw {
  if (!s.checks.length) return html`<span class="xs">Not verified here</span>`
  if (s.ratings.value === null) return html`<span class="chip sm">New</span>`
  return html`<span class="rate">${icon('star', 'fill')}${s.ratings.value.toFixed(1)}</span><span class="xs">(${s.ratings.count})</span>`
}

/** A place, read by its shape: its point and its radius, and its area if it has one. */
type Place = { lat: string; lon: string; radiusKm: number; area?: unknown }
const isPlace = (v: unknown): v is Place => {
  const o = v as Place | null
  return !!o && typeof o === 'object' && typeof o.lat === 'string' && typeof o.lon === 'string' && Number.isInteger(o.radiusKm)
}

/** Where a place's point is on openstreetmap.org, marked. */
export const mapUrl = (p: Place) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`

/** A place as the app writes it (app src/show.ts): its area, then how far round it reaches; nothing more for radius 0, that exact spot. */
export function placeText(p: Place): string {
  const area = typeof p.area === 'string' ? p.area : ''
  if (p.radiusKm === 0) return area || 'An exact spot'
  return area ? `${area}, within ${p.radiusKm} km` : `Within ${p.radiusKm} km`
}

/** A place on a listing's page: each one a link to its point on the map, in placeText's words, with the arrow of a link that opens another site. */
export const placeHtml = (v: unknown): Raw =>
  html`${(Array.isArray(v) ? v : [v]).filter(isPlace).map((p, i) => html`${i ? ', ' : ''}<a href="${mapUrl(p)}">${placeText(p)}${icon('arrow-up-right', 'bold', 'xs')}</a>`)}`

/**
 * An amount in its currency, as people write a price, as the app does (app src/show.ts, priceParts),
 * in English's number format, this page having no reader's own: $30, €12.50, MX$1,300; as written
 * when the amount is no number or the currency no code, 30 coins.
 */
export function amountText(amount: unknown, currency: unknown): string {
  const n = Number(amount)
  if (typeof amount === 'string' && amount.trim() !== '' && Number.isFinite(n)) {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: String(currency), trailingZeroDisplay: 'stripIfInteger' }).format(n)
    } catch {
      // Not a currency code: as it was written.
    }
  }
  return `${String(amount)} ${String(currency)}`
}

/** A word for several of a `per`: "lessons", "classes", a person's "people". */
export const perPlural = (per: string) => (per === 'person' ? 'people' : /(s|x|z|ch|sh)$/.test(per) ? `${per}es` : `${per}s`)

/**
 * Money as people write a price: its amount in its currency (amountText); and what it is for, "per
 * hour", or for a pack, its count of its per, "for 5 lessons", or nothing for the whole deal. None
 * for a value that is not money.
 */
export function priceParts(money: unknown): { amount: string; per: string } | null {
  if (!money || typeof money !== 'object' || Array.isArray(money) || !('amount' in money) || !('currency' in money)) return null
  const m = money as { amount: unknown; currency: unknown; per?: unknown; count?: unknown }
  const per = typeof m.per === 'string' && m.per ? m.per : ''
  const count = Number.isInteger(m.count) ? (m.count as number) : 1
  return { amount: amountText(m.amount, m.currency), per: !per ? '' : count > 1 ? `for ${count} ${perPlural(per)}` : `per ${per}` }
}

/** Money in one line: "$30 per hour", "MX$1,300 for 5 lessons". */
export const moneyText = (money: unknown) => {
  const p = priceParts(money)
  return p ? [p.amount, p.per].filter(Boolean).join(' ') : ''
}

/**
 * Each price a listing gives, in its writer's order: its price is always a list of them in the
 * markets' format; one held as a single money, as before it, is a list of one. Only those that are
 * money.
 */
export function pricesOf(body: { [key: string]: unknown }): Array<{ amount: string; currency: string; per?: string; count?: number }> {
  const held = body.price === undefined ? [] : Array.isArray(body.price) ? body.price : [body.price]
  return held.filter((m): m is { amount: string; currency: string; per?: string; count?: number } => priceParts(m) !== null && typeof m.amount === 'string' && typeof m.currency === 'string')
}

/** A field's value as words on a page: each of the markets' nine types, read by its shape. */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(valueText).join(', ')
  if (v && typeof v === 'object') {
    const o = v as { [key: string]: unknown }
    if ('amount' in o && 'currency' in o) return moneyText(o)
    if (isPlace(o)) return placeText(o)
    if ('sha256' in o) return `a file (${o.type}, ${o.size} bytes)`
    if ('from' in o && 'to' in o) return `${o.from} to ${o.to}`
    if ('zone' in o && Array.isArray(o.slots)) return `${(o.slots as Array<{ days: string[]; from: string; to: string }>).map((s) => `${s.days.join(', ')} ${s.from} to ${s.to}`).join('; ')} (${o.zone})`
    return Object.entries(o)
      .map(([k, x]) => `${k}: ${valueText(x)}`)
      .join(', ')
  }
  return ''
}

/**
 * A choice field's value as people read it: each value's label where its field has one (`xl` as
 * "XL"), otherwise the value in words, joined by commas.
 */
export const choiceText = (v: unknown, labels: { [value: string]: string } = {}) =>
  (Array.isArray(v) ? v : [v]).map((x) => (Object.hasOwn(labels, String(x)) ? labels[String(x)]! : inWords(String(x)))).join(', ')

/** A unit in words for `n` of it: hyphens as spaces, and one of it without the plural's s, a person for people: "45 minutes", "1 night", "2 square metres". */
export function unitText(unit: string, n: string): string {
  const words = unit.replaceAll('-', ' ')
  return n !== '1' ? words : words === 'people' ? 'person' : words.replace(/s$/, '')
}

/**
 * One number or one range in its unit: "45 minutes"; a range from one number to another, "9 to 11
 * years", or with an end left out, for no limit that way, "18 years and over", "11 years and under".
 */
function oneNumber(v: unknown, unit: string): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const { from, to } = v as { from?: unknown; to?: unknown }
    if (typeof from === 'string' && typeof to === 'string') return `${from} to ${to} ${unitText(unit, to)}`
    if (typeof from === 'string') return `${from} ${unitText(unit, from)} and over`
    if (typeof to === 'string') return `${to} ${unitText(unit, to)} and under`
  }
  const n = valueText(v)
  return n ? `${n} ${unitText(unit, n)}` : ''
}

/** A number field's value as stored, in its unit, a number or a range (oneNumber); each of a list so, joined by commas. */
export const numberText = (v: unknown, unit: string) =>
  (Array.isArray(v) ? v : [v])
    .map((x) => oneNumber(x, unit))
    .filter(Boolean)
    .join(', ')

/** A field's value as words, by its market's type for it: a choice by its labels, a number in its unit, a file as nothing (it is drawn as a photo), the rest by its shape. */
function fieldText(m: Market | undefined, name: string, value: unknown): string {
  if (value === undefined || value === null) return ''
  const field = m?.listing[name]
  if (field?.type === 'file') return ''
  return field?.type === 'choice' ? choiceText(value, field.labels) : field?.unit ? numberText(value, field.unit) : valueText(value)
}

/** The first line of a text, cut short at a word, with an ellipsis when cut. */
export function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0]!.trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  return `${(cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,.;:]+$/, '')}…`
}

/** A listing's first price as words, "$20 per hour", when it has one. */
export const priceText = (body: { [key: string]: unknown }): string => moneyText(pricesOf(body)[0])

/**
 * A listing's price as a card draws it: its first price, the amount, and what it is for under it,
 * then how many more it gives, "+2 more", which its own page shows.
 */
export function priceHtml(body: { [key: string]: unknown }): Raw {
  const [first, ...more] = pricesOf(body)
  const p = priceParts(first)
  return p ? html`<span class="price"><span class="d">${p.amount}</span>${p.per ? html`<span class="xs">${p.per}</span>` : ''}${more.length ? html`<span class="xs">+${more.length} more</span>` : ''}</span>` : html``
}

/**
 * A listing's card's two lines, as the app writes them (app src/show.ts, cardLines): its title, its
 * description's first line, else its preview's first field it holds; and one quiet line, the next of
 * its preview's fields it holds, but its description, its price and its photos.
 */
export function cardLines(m: Market | undefined, body: { [key: string]: unknown }): { title: string; line: string } {
  const shown = (m ? previewOf(m) : [])
    .filter((name) => name !== 'price' && name !== 'description' && m!.listing[name] && m!.listing[name]!.type !== 'file')
    .map((name) => fieldText(m, name, body[name]))
    .filter(Boolean)
  const description = typeof body.description === 'string' ? firstLine(body.description, 140) : ''
  const [title = 'A listing', line = ''] = description ? [description, ...shown] : shown
  return { title, line }
}

/** A listing's first photo, small, at the start of its card; its text empty, since the card's says it. */
const thumbHtml = (l: Listing) => (l.photos[0] ? html`<img class="thumb" src="${l.photos[0]}" alt="" loading="lazy">` : '')

/**
 * One result, as search and a market's page draw it: a card linking to the listing's page, its
 * photo, title, quiet line, distance when searching near, and price; then, under a hairline, its
 * profile's avatar, name and badge, and its rating.
 */
export function resultHtml(site: Site, r: Result & { km?: number }): Raw {
  const { title, line } = cardLines(site.markets.market(r.market), r.listing.body)
  return html`<a class="rcard" href="${r.listing.url}"><span class="top">${thumbHtml(r.listing)}<span class="what"><span class="title">${title}</span>${line ? html`<span class="s">${line}</span>` : ''}${r.km === undefined ? '' : html`<span class="xs">${r.km} km</span>`}</span>${priceHtml(r.listing.body)}</span><span class="who">${profileAvatar(site, r.market, r.role, 'xs')}${nameHtml(r.market, r.role, r.checks)}<span class="grow"></span>${rateHtml(r)}</span></a>`
}

/** A profile's own listing, as its page draws it: a card linking to the listing's page, its photo, title, quiet line and price, and why it is not listed, when it is not. */
export function listingCardHtml(site: Site, market: string | null, l: Listing & { listed: boolean; why?: string }): Raw {
  const { title, line } = cardLines(market ? site.markets.market(market) : undefined, l.body)
  return html`<a class="card lcard" href="${l.url}">${thumbHtml(l)}<span class="what"><span class="title">${title}</span>${line ? html`<span class="s">${line}</span>` : ''}${l.listed ? '' : html`<span class="s red">Not listed: ${l.why}.</span>`}</span>${priceHtml(l.body)}</a>`
}

/**
 * How to message a profile from the apps this index lists: the first one's button, the page's one
 * forest-green, in `words`; each other as a quiet link under it. Nothing when this index lists none.
 */
export function messageHtml(message: Array<{ name: string; url: string }>, words: string): Raw {
  const [first, ...more] = message
  if (!first) return html``
  return html`<a class="btn primary" href="${first.url}">${icon('paper-plane-tilt', 'bold')}${words}</a>${more.length ? html`<div class="also">${more.map((m) => html`<a href="${m.url}">Message in the ${m.name}</a>`)}</div>` : ''}`
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
<div class="num"><span class="d">${s.trust}</span><p class="s">Trust, 0 to 100: how much its own reviews count. Vouches and ratings raise it, reports lower it.</p></div>
<div class="num"><span class="d">${s.uniqueness}</span><p class="s">Uniqueness, 0 to 100: how sure this index is that it's one real person.</p></div></div></details>`
}

/** Dates in English, in UTC, the one zone a page with no script can give every reader. */
const DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** An entry's own time as its date, "Nov 6, 2026": its writer's word, as the JSON gives it. Nothing for a time no date holds. */
export function dateHtml(ms: number): Raw {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? html`` : html`<time datetime="${d.toISOString().slice(0, 10)}">${DAY.format(d)}</time>`
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
    ...(typeof p.per === 'string' && { referenceQuantity: { '@type': 'QuantitativeValue', value: Number.isInteger(p.count) ? p.count : 1, unitText: p.per } }),
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
