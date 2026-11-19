// `/search`: the listings this index lists, each with what its profile shows (its ratings, trust,
// uniqueness and checks), in one of three orders: Top rated, by its ratings with one unit of its
// market's average added (README.md, How it scores), then the newest listing; Nearest; Cheapest.
// `find`, below, is a market's page's too (market.ts), with its market and side fixed.
//
//   q            words in the listing, each a word's start, all of them (FTS5)
//   market, role only that market, only listings by that role
//   where        words for a place, such as a town's name: places' first place found for them
//                (../places.ts) is the place, as if near and near.name gave it; nothing found, no
//                place. A page's form sends the name it showed back: words that are that name, with
//                near beside them, are no new words, and an emptied box clears the place
//   near, km     near=lat,lon and km, how far the searcher would go (10 unless given): a listing with
//                a place whose circle reaches that far, the distance between the two points at most km
//                plus its radiusKm; each result then carries km, its distance between the two
//                points; a listing with no place is left out
//   near.name    the name to show for near, as a page's links carry it once places named it; with
//                none, places names it now (words.ts, captionOf)
//   minRating    a profile rated at least this; one with no rating is left out
//   minReviews   a profile scored by at least this many raters
//   price.currency, price.per, price.min, price.max
//                with an amount, price.min or price.max, or sort=price: a listing with a price in that
//                currency, for that per, or for the whole deal when price.per is left out, whose
//                amount divided by its count, what one of its per costs, is at least, at most this;
//                per hour the count is a length, so 25 for 0.75 hours, 33.33 an hour, costs more than
//                30 an hour. Prices compare only within one per and currency, as the markets' prices
//                do, since any rate between currencies is a guess. A currency and a per with no
//                amount filter nothing: a page's form sends both each time (README.md, FAQ)
//   sort         rating (the default), near with a place: nearest first; price with a price
//                filter: cheapest first, by the least of those prices; ties in the order Top rated
//                gives. A place alone never reorders
//   limit        20 unless given, at most 100; offset skips that many
//
// With market, also a filter per listing field of that market, by its piece (filterable), each
// matched by the markets' own match, one field at a time: a choice by its name, `<field>=<value>`, a
// listing whose field holds that value, among its answers for one with several; a number by
// `<field>.min` and `<field>.max`, in its unit, a listing whose number or range overlaps that range,
// a missing end limiting nothing. The markets match a listing that leaves the field out; here a
// listing without the field is left out once it is filtered on (README.md, FAQ). How the filters
// combine is this index's: a listing must match each.
//
// Its JSON gives, beside the results, `query`, each of these filters as it was given, `markets`,
// every market's name, `place`, the place the results are near, and `found`, how many results each
// market holds, so its page draws a chip for each.

import type { Asked, Field, Market, Markets } from '@foundationforest/markets'

import { inWords, marketHtml, offerOf, pricesOf, type Result, resultsHtml, results, wordFor } from './common.ts'
import { icon } from './icons.ts'
import { type Context, html, type Page, type Raw, urls } from './template.ts'

export const LIMIT = 20
export const MAX_LIMIT = 100
export const KM = 10

/** A point, `near=lat,lon`, as search reads one. */
export const NEAR = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

/** How far the Where box offers, in km; the one asked joins them when it is another. */
export const HOW_FAR = ['2', '5', '10', '25', '50']

/** The ratings a market's filters offer, each a `minRating`, beside Any. */
export const RATINGS = ['8', '9']

/** The filters search reads, in the order its query names them. */
export const FILTERS = ['q', 'market', 'role', 'where', 'near', 'near.name', 'km', 'minRating', 'minReviews', 'price.currency', 'price.per', 'price.min', 'price.max', 'sort', 'limit', 'offset']

/** The price filters, which a link that changes them changes together. */
export const PRICE = ['price.currency', 'price.per', 'price.min', 'price.max']

/**
 * The listing fields of a market search filters by: each choice and each number. A field named as
 * one of search's own filters is filtered by that filter, never as a field, since the query holds
 * one value per name.
 */
export const filterable = (m: Market): Array<[string, Field]> => Object.entries(m.listing).filter(([name, f]) => (f.piece === 'choice' || f.piece === 'number') && !FILTERS.includes(name))

/** The names a field's filter takes in the query: a choice's own name, a number's `<name>.min` and `<name>.max`. */
export const namesOf = ([name, f]: [string, Field]) => (f.piece === 'number' ? [`${name}.min`, `${name}.max`] : [name])

/**
 * The answer a filter asks of a field, as the field writes one, for the markets' match: a choice's
 * value; a number's `{ from, to }`, an end not given left out; each as a list of one for a field
 * with several. None when the query does not filter on it: no value, or no number at either end.
 */
export function wantedOf(get: (name: string) => string | undefined, [name, f]: [string, Field]): unknown {
  let one: unknown
  if (f.piece === 'choice') one = get(name) || undefined
  else {
    const end = (n: string) => {
      const text = get(n)?.trim()
      return text && Number.isFinite(Number(text)) ? text : undefined
    }
    const [from, to] = [end(`${name}.min`), end(`${name}.max`)]
    one = from === undefined && to === undefined ? undefined : { ...(from !== undefined && { from }), ...(to !== undefined && { to }) }
  }
  return one === undefined ? undefined : f.several ? [one] : one
}

/**
 * The fields a market asks one side, by name, with its words for that side, as the markets' ask
 * gives them; with no side, every side's, the first side's words for a field both ask.
 */
export function askedBy(markets: Markets, m: Market, role: string | undefined): Map<string, Asked> {
  const out = new Map<string, Asked>()
  for (const r of m.roles) if (role === undefined || r.role === role) for (const a of markets.ask(m.name, r.role)) if (!out.has(a.name)) out.set(a.name, a)
  return out
}

/** Whether a query's price filter is on: a currency, with an amount or sort=price. */
export const pricedIn = (q: { [filter: string]: string | undefined }) => !!q['price.currency'] && (!!q['price.min'] || !!q['price.max'] || q.sort === 'price')

/**
 * What one of a price's per costs: its amount divided by its count, decimal text, 1 when left out, as
 * the markets' match divides it. Per hour the count is a length: 25 for 0.75 hours is 33.33 an hour.
 */
const eachOf = (p: { amount: string; count?: string }) => Number(p.amount) / Number(p.count ?? '1')

/** The place results are near: its point, as near writes one, the name to show for it, null when places named none, and how far, in km. */
export type Near = { near: string; name: string | null; km: number }

export type SearchPage = {
  index: string
  total: number
  /** With a place, each with `km`, its distance from that point. */
  results: Array<Result & { km?: number }>
  /** Each filter as it was given, its text as written; one not given, or given empty, is left out. */
  query: { [filter: string]: string }
  /** Every market's name in the directory. */
  markets: string[]
  /** The place the results are near, or null. */
  place: Near | null
  /** How many results each market holds, every page of them, by its name; a market with none left out. */
  found: { [market: string]: number }
}

const number = (q: URLSearchParams, name: string) => {
  const text = q.get(name)
  if (text === null || text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** Each word of `q`, as an FTS5 prefix, all of them. */
function match(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu)
  return words ? words.map((w) => `"${w}"*`).join(' ') : null
}

/** Kilometres between two points, on a sphere of the Earth's mean radius. */
export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h))
}

/** Every place a listing names, in any of its place fields, its point and its radius: read by its shape, a circle, as the markets write one. */
function pointsOf(body: { [key: string]: unknown }): Array<{ lat: number; lon: number; radiusKm: number }> {
  const out: Array<{ lat: number; lon: number; radiusKm: number }> = []
  for (const v of Object.values(body)) {
    for (const p of Array.isArray(v) ? v : [v]) {
      const o = p as { lat?: unknown; lon?: unknown; radiusKm?: unknown }
      if (o && typeof o === 'object' && typeof o.lat === 'string' && typeof o.lon === 'string' && Number.isInteger(o.radiusKm)) out.push({ lat: Number(o.lat), lon: Number(o.lon), radiusKm: o.radiusKm as number })
    }
  }
  return out
}

/**
 * The place a query names: where's words, when they are new, as places finds them; else near, with
 * the name its link carries, or the one places gives it now. Null with neither, or when places finds
 * nothing.
 */
async function placeOf(ctx: Context, q: URLSearchParams): Promise<Near | null> {
  const within = Math.max(number(q, 'km') ?? KM, 0)
  const carried = (q.get('near.name') ?? '').trim()
  const where = q.get('where')
  if (where !== null && where.trim() !== carried) {
    const found = where.trim() ? await ctx.places.find(where) : null
    return found ? { near: found.near, name: found.name, km: within } : null
  }
  const at = NEAR.exec(q.get('near') ?? '')
  if (!at) return null
  return { near: at[0], name: carried || (await ctx.places.caption(Number(at[1]), Number(at[2]), within)), km: within }
}

/** What a query finds, every page of it counted, one page of it given. */
export type Found = Pick<SearchPage, 'total' | 'results' | 'query' | 'place' | 'found'>

/** The listings a query finds, in its order, a page of them, with its place and how many each market holds. */
export async function find(ctx: Context, q: URLSearchParams): Promise<Found> {
  const { store, markets, base } = ctx
  const where: string[] = []
  const params: Array<string | number> = []
  const words = match(q.get('q') ?? '')
  if (words) where.push('and l.address in (select address from listings_text where listings_text match ?)'), params.push(words)
  if (q.get('market')) where.push('and f.market = ?'), params.push(q.get('market')!)
  if (q.get('role')) where.push('and f.role = ?'), params.push(q.get('role')!)
  const minRating = number(q, 'minRating')
  if (minRating !== null) where.push('and r.value >= ?'), params.push(minRating)
  const minReviews = number(q, 'minReviews')
  if (minReviews !== null) where.push('and coalesce(r.count, 0) >= ?'), params.push(minReviews)
  let found: Array<Result & { time: number; km?: number; cost?: number; d?: number }> = results(store, base, where.join(' '), params)
  const m = q.get('market') ? markets.market(q.get('market')!) : undefined
  const fields = m ? filterable(m) : []
  for (const field of fields) {
    const wanted = wantedOf((n) => q.get(n) ?? undefined, field)
    if (wanted === undefined) continue
    const [name, f] = field
    found = found.filter((r) => r.listing.body[name] !== undefined && markets.match(f, r.listing.body[name], wanted))
  }
  // Prices compare only within one currency and one per, the whole deal's when per is left out;
  // each listing keeps the least that is in bounds, its cost, for sort=price.
  const given = Object.fromEntries([...q.entries()])
  const priced = pricedIn(given)
  if (priced) {
    const currency = q.get('price.currency')!
    const per = q.get('price.per') || undefined
    const min = number(q, 'price.min') ?? -Infinity
    const max = number(q, 'price.max') ?? Infinity
    found = found.flatMap((r) => {
      const costs = pricesOf(r.listing.body)
        .filter((p) => p.currency === currency && (typeof p.per === 'string' ? p.per : undefined) === per)
        .map(eachOf)
        .filter((n) => Number.isFinite(n) && n >= min && n <= max)
      return costs.length ? [{ ...r, cost: Math.min(...costs) }] : []
    })
  }
  const place = await placeOf(ctx, q)
  if (place) {
    const [lat, lon] = place.near.split(',').map(Number) as [number, number]
    // Two places match when their circles touch: the searcher's, of radius km, and the listing's.
    // A result's km is to one decimal, a hundred metres, finer than a rough point means.
    found = found.flatMap((r) => {
      const reached = pointsOf(r.listing.body)
        .map((p) => ({ d: km({ lat, lon }, p), r: p.radiusKm }))
        .filter((p) => p.d <= place.km + p.r)
      if (!reached.length) return []
      const d = Math.min(...reached.map((p) => p.d))
      return [{ ...r, d, km: Math.round(d * 10) / 10 }]
    })
  }
  // A stable sort, so listings as near or as cheap keep the order Top rated gives.
  if (q.get('sort') === 'near' && place) found.sort((a, b) => a.d! - b.d!)
  if (q.get('sort') === 'price' && priced) found.sort((a, b) => a.cost! - b.cost!)
  const limit = Math.min(Math.max(Math.trunc(number(q, 'limit') ?? LIMIT), 1), MAX_LIMIT)
  const offset = Math.max(Math.trunc(number(q, 'offset') ?? 0), 0)
  const counts: { [market: string]: number } = {}
  for (const r of found) counts[r.market] = (counts[r.market] ?? 0) + 1
  return {
    total: found.length,
    results: found.slice(offset, offset + limit).map(({ time: _, cost: __, d: ___, ...r }) => r),
    query: Object.fromEntries([...FILTERS, ...fields.flatMap(namesOf)].filter((f) => q.get(f)).map((f) => [f, q.get(f)!])),
    place,
    found: Object.fromEntries(markets.directory.markets.filter((x) => counts[x.name]).map((x) => [x.name, counts[x.name]!])),
  }
}

/**
 * The query as a page's links carry it: as given, but where's words, which are now its place, and
 * the page's offset; the place as near, near.name and km once there is one, so no link asks places
 * again.
 */
export function carried(query: { [filter: string]: string }, place: Near | null): { [filter: string]: string } {
  const { where: _, near: __, 'near.name': ___, km: ____, offset: _____, ...rest } = query
  return { ...rest, ...(place && { near: place.near, ...(place.name && { 'near.name': place.name }), km: String(place.km) }) }
}

/** A link builder over the query a page carries: `change` sets a filter, or drops it with null, the rest kept. */
export const linker =
  (to: (q: Record<string, string>) => string, keep: { [filter: string]: string }) =>
  (change: { [filter: string]: string | null } = {}) =>
    to(Object.fromEntries(Object.entries({ ...keep, ...change }).filter((e): e is [string, string] => e[1] !== null)))

/** The place in a chip's words: its name, or its point with none, and how far: "Camden, London · 10 km". */
export const placeWords = (p: Near) => `${p.name ?? p.near.replace(',', ', ')} · ${p.km} km`

/** The Where box's inputs: the words, the place as its link carries it, and how far, as chips; for a form that also holds the rest of the query. */
export function whereInputs(place: Near | null): Raw {
  const within = String(place?.km ?? KM)
  return html`<label class="inp"><input type="text" name="where" value="${place?.name ?? ''}" placeholder="A city or neighbourhood" aria-label="Where"></label>${
    place ? html`<input type="hidden" name="near" value="${place.near}">${place.name ? html`<input type="hidden" name="near.name" value="${place.name}">` : ''}` : ''
  }<span class="lab">How far</span><div class="opts" role="radiogroup" aria-label="How far">${[...new Set([...HOW_FAR, within])].map(
    (n) => html`<label class="chip pick"><input type="radio" name="km" value="${n}"${n === within ? ' checked' : ''}>${n} km</label>`,
  )}</div>`
}

/** The hidden inputs that carry a query's filters along a form, but those it asks itself. */
export const hiddenOf = (keep: { [filter: string]: string }, but: string[]) =>
  Object.entries(keep)
    .filter(([n]) => !but.includes(n))
    .map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)

/** The orders a query may take, each with its words: Top rated always; Nearest with a place; Cheapest with a price filter. */
function ordersOf(query: { [filter: string]: string }, place: Near | null): Array<[sort: string, words: string]> {
  return [['rating', 'Top rated'], ...(place ? [['near', 'Nearest'] as [string, string]] : []), ...(pricedIn(query) ? [['price', 'Cheapest'] as [string, string]] : [])]
}

/** The order picker: a fold whose links each change the order, the one in force marked. */
export function orderHtml(link: (change: { [filter: string]: string | null }) => string, query: { [filter: string]: string }, place: Near | null): Raw {
  const orders = ordersOf(query, place)
  const [now, words] = orders.find(([s]) => s === query.sort) ?? orders[0]!
  return html`<details class="drop end order"><summary class="chip" aria-label="${`Order: ${words}`}">${words}${icon('caret-down', 'regular', 'xs')}</summary><nav class="panel menu" aria-label="Order">${orders.map(
    ([s, w]) => html`<a href="${link({ sort: s === 'rating' ? null : s })}"${s === now ? html` aria-current="true"` : ''}>${w}</a>`,
  )}</nav></details>`
}

/** Show more: a link to the next page, while there is one. */
export function moreHtml(link: (change: { [filter: string]: string | null }) => string, o: { total: number; results: unknown[]; query: { [filter: string]: string } }): Raw {
  const offset = Math.max(Math.trunc(Number(o.query.offset ?? 0)) || 0, 0)
  return offset + o.results.length < o.total ? html`<a class="btn out more" href="${link({ offset: String(offset + o.results.length) })}">Show more</a>` : html``
}

/** The line that says the words found no place. */
export const noPlaceHtml = (query: { [filter: string]: string }, place: Near | null) => (query.where && !place ? html`<p class="s">No place found for “${query.where}”.</p>` : html``)

export const search: Page<SearchPage> = {
  name: 'search',
  noindex: true,
  async data(ctx, _path, q) {
    return { index: ctx.self, ...(await find(ctx, q)), markets: ctx.markets.directory.markets.map((m) => m.name) }
  },
  title: () => 'Forest index: search',
  searched: (o) => {
    const { q, near, 'near.name': name, km } = carried(o.query, o.place)
    return Object.fromEntries(Object.entries({ q, near, 'near.name': name, km }).filter((e): e is [string, string] => e[1] !== undefined))
  },
  // The page: the Where chip, a fold with the Where box and how far, then a chip per market with
  // results, to that market's page with the words and the place kept; how many, and the order;
  // the results, a grid of pictures, each with its market's mark; and Show more. Filters on a
  // market's fields are on its page; those a link gives here still apply, and the JSON says them.
  body(o, base, site) {
    const keep = carried(o.query, o.place)
    const link = linker(urls(base).search, keep)
    // A market's chip keeps the words and the place, and nothing else: its page asks its own filters.
    const toMarket = { ...(o.query.q && { q: o.query.q }), ...carried({}, o.place) }
    return html`<div class="seek"><details class="drop where"><summary class="${o.place ? 'chip on' : 'chip'}">${icon('map-pin')}${o.place ? placeWords(o.place) : 'Anywhere'}${icon('caret-down', 'regular', 'xs')}</summary><div class="panel"><form action="${urls(base).search({})}" method="get" aria-label="Where">${hiddenOf(keep, ['near', 'near.name', 'km'])}<span class="lab">Where</span>${whereInputs(o.place)}<button class="btn go" type="submit">Search</button>${
      o.place ? html`<a class="link" href="${link({ near: null, 'near.name': null, km: null })}">Anywhere</a>` : ''
    }</form></div></details><nav class="chips" aria-label="Markets">${Object.entries(o.found).map(
      ([name, n]) =>
        html`<a class="chip" href="${urls(base).market(name, toMarket)}">${marketHtml(site, name, 'xs')}${inWords(name)} <span class="n">${n}</span></a>`,
    )}</nav></div>
${noPlaceHtml(o.query, o.place)}<div class="count"><p><b>${o.total}</b> ${wordFor(o.total, 'results')}</p>${orderHtml(link, o.query, o.place)}</div>
${o.results.length ? resultsHtml(site, o.results, { layout: 'grid', mark: true }) : ''}${moreHtml(link, o)}`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'SearchResultsPage',
          '@id': url,
          url,
          mainEntity: { '@type': 'ItemList', numberOfItems: o.total, itemListElement: o.results.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: offerOf(r, base) })) },
        },
      ],
    }
  },
}
