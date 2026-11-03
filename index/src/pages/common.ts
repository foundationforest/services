// What several pages share: what a profile shows (its ratings, trust, uniqueness and checks) as the
// JSON gives it, a post as every page gives it (its page and its photos among it), a search or
// market result, and how the HTML draws each from the object, in the pieces the Forest app draws: a
// profile's name, the shield, the score's chip, a row, the facts list's words, and the fold that says
// what a profile's words and numbers mean.

import type { Market } from '@foundationforest/markets'

import type { Check } from '../filter.ts'
import type { ListedApp } from '../lists.ts'
import { parse, type Store } from '../store.ts'
import { foldHtml, html, NEXT_ICON, type Raw, urls } from './template.ts'

/**
 * What a profile shows: its ratings, from 1 to 10 to one decimal, with how many raters scored it;
 * and its trust and uniqueness, whole numbers from 0 to 100. A profile that does not count shows no
 * rating, 0 and 0.
 */
export type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number }
/** A post as every page gives it: its address and body, its own page, and a link to each of its photos. */
export type Post = { address: string; body: { [key: string]: unknown }; url: string; photos: string[] }
export type Result = { profile: string; market: string; role: string; post: Post } & Shown & { checks: Check[] }

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
 * The links to a post's photos, the files its fields name, at `host`, the profile entry's first
 * host, by the host's own read, `<host>/v1/files/<sha256>`. The index keeps no bytes.
 */
export function photosOf(body: { [key: string]: unknown }, host: string | undefined): string[] {
  return host ? [...new Set(Object.keys(body).flatMap((name) => filesIn(body, name)))].map((sha) => `${host}/v1/files/${sha}`) : []
}

export const postOf = (base: string, address: string, body: { [key: string]: unknown }, host: string | undefined): Post => ({ address, body, url: urls(base).post(address), photos: photosOf(body, host) })

/** Where to message a profile: one link per app the lists name, its address in each. */
export const messageOf = (apps: ListedApp[], address: string) => apps.map((a) => ({ name: a.name, url: a.message.replaceAll('{address}', encodeURIComponent(address)) }))

/** A button to message the profile from each app: the first app's green, the page's one, any other outlined; nothing when this index lists none. */
export function messageHtml(message: Array<{ name: string; url: string }>): Raw {
  return message.length ? html`<div class="buttons">${message.map((m, i) => html`<a class="${i ? 'button' : 'button primary'}" href="${m.url}">Message in the ${m.name}</a>`)}</div>` : html``
}

/**
 * A market's post fields, in the order a post's page shows them: its preview's first, then the rest
 * in the market's order. A market with no preview has the markets manual's: description, price,
 * then the first place field, of those it has.
 */
export function fieldsOf(m: Market | undefined): string[] {
  if (!m) return []
  const names = Object.keys(m.post)
  const preview = m.preview ?? [...['description', 'price'].filter((n) => n in m.post), ...names.filter((n) => m.post[n]!.type === 'place').slice(0, 1)]
  return [...preview, ...names.filter((n) => !preview.includes(n))]
}

/** Each of a market's post fields' type, as its file names it: `file`, `money`, `place` and the rest of the markets' types. */
export function typesOf(m: Market | undefined): { [field: string]: string } {
  return m ? Object.fromEntries(Object.entries(m.post).map(([name, field]) => [name, field.type])) : {}
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
 * The listed posts, with their profiles, sorted as search sorts them: by the profile's ratings with
 * one unit of its market's average added (rank.ts), then the newest post. `where` narrows them.
 */
export function results(store: Store, base: string, where = '', params: Array<string | number> = []): Array<Result & { time: number }> {
  const found = store.db
    .prepare(
      `select p.address, p.profile, p.body, p.time, f.market, f.role, f.checks, f.body as entry, r.value, r.count, r.trust, r.uniqueness
       from posts p join profiles f on f.address = p.profile left join ratings r on r.profile = p.profile
       where p.listed = 1 ${where}
       order by r.sort is null, r.sort desc, p.time desc, p.address`,
    )
    .all(...params) as Array<ShownColumns & { address: string; profile: string; body: string; time: number; market: string; role: string; checks: string; entry: string }>
  return found.map((r) => ({
    profile: r.profile,
    market: r.market,
    role: r.role,
    post: postOf(base, r.address, parse(r.body), firstHost(parse(r.entry))),
    ...shownOf(r),
    checks: parse(r.checks),
    time: r.time,
  }))
}

/** "Verified by face", "Verified by face and ID": each check's label, without its " check". */
export function verifiedText(checks: Check[]): string {
  const ways = checks.map((c) => c.label.replace(/ check$/, ''))
  if (!ways.length) return 'Not verified here'
  return `Verified by ${ways.length > 1 ? `${ways.slice(0, -1).join(', ')} and ${ways.at(-1)}` : ways[0]}`
}

/** A market's name in words, as the app writes it: `home-cleaning` is "Home cleaning". */
export function marketWords(name: string): string {
  const words = name.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A profile's name as the app writes it: its market in words, in bold, then its role, quiet, no symbol between: "Clothing seller". */
export function namedHtml(market: string | null, role: string | null): Raw {
  if (!market) return html`A profile`
  return html`<span class="named"><strong>${marketWords(market)}</strong>${role ? html` <span class="role">${role}</span>` : ''}</span>`
}

/**
 * How a profile is verified, as the app shows it, by its strongest check: an outline shield for a
 * face check, filled in the ink with its tick in the paper's color for an ID check; none when this
 * index counts no check for it. Its words, "Verified by face and ID", are its name. "ID check" is
 * the name lists/verifiers.json gives the ID key's check, this index's own word for it.
 */
export function shieldHtml(checks: Check[]): Raw {
  if (!checks.length) return html``
  const words = verifiedText(checks)
  return html`<svg class="${checks.some((c) => c.label === 'ID check') ? 'icon shield id' : 'icon shield'}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${words}"><title>${words}</title><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><polyline points="9,12 11.2,14.2 15.5,9.8"/></svg>`
}

/** A profile's rating on its sand chip, "9.0 ★", or "New" when no one has rated it yet. */
export function chipHtml(s: Shown): Raw {
  return s.ratings.value === null ? html`<span class="new">New</span>` : html`<span class="chip">${s.ratings.value.toFixed(1)} ★</span>`
}

/** A review's score on its chip, as its writer gave it: "8.5 ★". */
export const scoreHtml = (score: unknown) => html`<span class="chip">${typeof score === 'string' ? score : '–'} ★</span>`

/** What a profile shows, on the right of a row: its shield and its chip, or that it is not verified here. */
export const shownAside = (s: Shown & { checks: Check[] }) => (s.checks.length ? html`${shieldHtml(s.checks)}${chipHtml(s)}` : html`<span>Not verified here</span>`)

/** A field's name as words: `pastWork` is "Past work". */
export function fieldLabel(name: string): string {
  const words = name.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A field's value as words on a page: each of the markets' nine types, read by its shape. */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(valueText).join(', ')
  if (v && typeof v === 'object') {
    const o = v as { [key: string]: unknown }
    if ('amount' in o && 'currency' in o) return `${o.amount} ${o.currency}${o.per ? ` per ${o.per}` : ''}`
    if ('area' in o) return `${o.area}${o.online ? ', and online' : ''}${o.reachKm !== undefined ? `, up to ${o.reachKm} km away` : ''}`
    if (o.online === true) return 'online'
    if ('sha256' in o) return `a file (${o.type}, ${o.size} bytes)`
    if ('from' in o && 'to' in o) return `${o.from} to ${o.to}`
    if ('zone' in o && Array.isArray(o.slots)) return `${(o.slots as Array<{ days: string[]; from: string; to: string }>).map((s) => `${s.days.join(', ')} ${s.from} to ${s.to}`).join('; ')} (${o.zone})`
    return Object.entries(o)
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

/** A post's price as words, "20 USD per hour", when it has one. */
export function priceText(body: { [key: string]: unknown }): string {
  const price = body.price as { amount?: unknown; currency?: unknown } | undefined
  return price && typeof price === 'object' && 'amount' in price && 'currency' in price ? valueText(price) : ''
}

/** The area of a post's first place, read by its shape, or "online". */
function areaText(body: { [key: string]: unknown }): string {
  for (const v of Object.values(body)) {
    const o = v as { area?: unknown; online?: unknown } | null
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue
    if (typeof o.area === 'string') return `${o.area}${o.online === true ? ', and online' : ''}`
    if (o.online === true && Object.keys(o).length === 1) return 'online'
  }
  return ''
}

/** Who posted a post, as one row linking to its profile: the shield, the profile's name, its chip and a chevron. */
export function postedByHtml(r: { profile: string; market: string | null; role: string | null; checks: Check[] } & Shown, base: string): Raw {
  return html`<a class="row" href="${urls(base).profile(r.profile)}">${shieldHtml(r.checks)}<span class="grow">${namedHtml(r.market, r.role)}</span>${r.checks.length ? chipHtml(r) : html`<span class="new">Not verified here</span>`}${NEXT_ICON}</a>`
}

/**
 * A post as a row, linking to its page, as the app draws one: its first photo, 48px, the
 * description's first line in bold, then its price and place in one quiet line; then `note`, a
 * quiet line that wraps, and `aside`, on the right. The photo's text is empty: the row's says it.
 */
export function postRowHtml(post: Post, { aside, note }: { aside?: Raw; note?: Raw } = {}): Raw {
  const description = typeof post.body.description === 'string' ? post.body.description : ''
  const facts = [priceText(post.body), areaText(post.body)].filter(Boolean).join(' · ')
  return html`<a class="row post-row" href="${post.url}">${post.photos[0] ? html`<img class="thumb" src="${post.photos[0]}" alt="" loading="lazy">` : ''}<span class="two"><strong>${firstLine(description, 140) || 'A post'}</strong>${facts ? html`<span>${facts}</span>` : ''}${note ?? ''}</span>${aside ? html`<span class="aside">${aside}</span>` : ''}</a>`
}

/** Rows, stacked; with none, the line `none`, if given. */
export const rowsHtml = (rows: Raw[], none = '') => (rows.length ? html`<div class="rows">${rows}</div>` : none ? html`<p>${none}</p>` : html``)

/** One result, as a market page and the search page draw it: a post's row, with its profile's shield and chip. */
export function resultHtml(r: Result): Raw {
  return postRowHtml(r.post, { aside: shownAside(r) })
}

/**
 * What a profile's words and numbers mean, for a reader who lands on one page and reads nothing
 * else: what README.md, How it scores, says, in plain words. In the fold of a post's page and a
 * profile's, and on the About page.
 */
export const KEY = html`<p>The shield: a verifier checked the real person behind the profile, which proves it without saying who. An outline shield is a face check; a filled one, an ID check. Its words say which: Verified by face, or by face and ID.</p>
<p>9.2 ★: the profile's rating, the average of its raters' scores from 1 to 10, weighted toward raters with more uniqueness and trust. New: no one has rated it yet.</p>
<p>Trust, 0 to 100: how much the profile's own scores and words weigh. A new profile starts at half its uniqueness; vouches and ratings raise it, reports lower it. Uniqueness, 0 to 100: how sure this index is that the profile is one real person.</p>
<p>Each profile is one person in one market and role, and nothing here links one person's profiles.</p>`

/** The fold "What these mean": `who`'s rating with its raters, trust and uniqueness, the only place a page shows them, then the key. */
export function meaningHtml(who: string, s: Shown): Raw {
  const rated = s.ratings.value === null ? 'no rating' : `rated ${s.ratings.value.toFixed(1)} by ${s.ratings.count}`
  return foldHtml('What these mean', html`<p>${who}: ${rated}, trust ${s.trust}, uniqueness ${s.uniqueness}.</p>
${KEY}`)
}

/** A Person node for a profile, by its page. */
export const personOf = (address: string, base: string) => ({ '@type': 'Person', url: urls(base).profile(address), identifier: address })

/** A schema.org AggregateRating for a profile's ratings, or null when it has none. */
export function aggregateOf(s: Shown): { [key: string]: unknown } | null {
  if (s.ratings.value === null || !s.ratings.count) return null
  return { '@type': 'AggregateRating', ratingValue: s.ratings.value, bestRating: 10, worstRating: 1, ratingCount: s.ratings.count }
}

/** A post as a schema.org Offer, at its page, with its photos and its seller's rating. */
export function offerOf(r: Result, base: string): { [key: string]: unknown } {
  const body = r.post.body
  const price = body.price as { amount?: string; currency?: string } | undefined
  const rating = aggregateOf(r)
  return {
    '@type': 'Offer',
    identifier: r.post.address,
    url: r.post.url,
    ...(r.post.photos.length > 0 && { image: r.post.photos }),
    ...(typeof body.description === 'string' && { description: body.description }),
    seller: personOf(r.profile, base),
    ...(price?.amount && price.currency && { price: price.amount, priceCurrency: price.currency }),
    ...(rating && { aggregateRating: rating }),
  }
}
