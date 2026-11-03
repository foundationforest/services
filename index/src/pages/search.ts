// `/search`: listed posts, each with what its profile shows (its ratings, trust, uniqueness and
// checks), sorted by its ratings with one unit of its market's average added
// (README.md, How it scores), then the newest post.
//
//   q            words in the post, each a word's start, all of them (FTS5)
//   market, role only that market, only posts by that role
//   near, km     near=lat,lon: a post with a place within km kilometres of it (km is 10 unless given);
//                a post that names no point is left out
//   minRating    a profile rated at least this; one with no rating is left out
//   minReviews   a profile scored by at least this many raters
//   limit        20 unless given, at most 100; offset skips that many
//
// Its JSON gives, beside the results, `query`, each of these filters as it was given, and `markets`,
// every market's name, so its page draws the home page's search box, filled with what was searched.

import { offerOf, type Result, resultHtml, results, rowsHtml } from './common.ts'
import { searchForm } from './home.ts'
import { backHtml, html, type Page, urls } from './template.ts'

export const LIMIT = 20
export const MAX_LIMIT = 100
export const KM = 10

/** The filters search reads, in the order its query names them. */
export const FILTERS = ['q', 'market', 'role', 'near', 'km', 'minRating', 'minReviews', 'limit', 'offset']

export type SearchPage = {
  index: string
  total: number
  results: Result[]
  /** Each filter as it was given, its text as written; one not given, or given empty, is left out. */
  query: { [filter: string]: string }
  /** Every market's name in the directory, the choices of the page's search box. */
  markets: string[]
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

/** Every point a post names, in a field of the place type: read by its shape, as the markets' types say. */
function pointsOf(body: { [key: string]: unknown }): Array<{ lat: number; lon: number }> {
  const out: Array<{ lat: number; lon: number }> = []
  for (const v of Object.values(body)) {
    for (const p of Array.isArray(v) ? v : [v]) {
      const o = p as { lat?: unknown; lon?: unknown; area?: unknown }
      if (o && typeof o === 'object' && typeof o.lat === 'string' && typeof o.lon === 'string' && typeof o.area === 'string') out.push({ lat: Number(o.lat), lon: Number(o.lon) })
    }
  }
  return out
}

export const search: Page<SearchPage> = {
  noindex: true,
  data({ store, markets, self, base }, _path, q) {
    const where: string[] = []
    const params: Array<string | number> = []
    const words = match(q.get('q') ?? '')
    if (words) where.push('and p.address in (select address from posts_text where posts_text match ?)'), params.push(words)
    if (q.get('market')) where.push('and f.market = ?'), params.push(q.get('market')!)
    if (q.get('role')) where.push('and f.role = ?'), params.push(q.get('role')!)
    const minRating = number(q, 'minRating')
    if (minRating !== null) where.push('and r.value >= ?'), params.push(minRating)
    const minReviews = number(q, 'minReviews')
    if (minReviews !== null) where.push('and coalesce(r.count, 0) >= ?'), params.push(minReviews)
    let found = results(store, base, where.join(' '), params)
    const near = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get('near') ?? '')
    if (near) {
      const at = { lat: Number(near[1]), lon: Number(near[2]) }
      const within = number(q, 'km') ?? KM
      found = found.filter((r) => pointsOf(r.post.body).some((p) => km(at, p) <= within))
    }
    const limit = Math.min(Math.max(Math.trunc(number(q, 'limit') ?? LIMIT), 1), MAX_LIMIT)
    const offset = Math.max(Math.trunc(number(q, 'offset') ?? 0), 0)
    return {
      index: self,
      total: found.length,
      results: found.slice(offset, offset + limit).map(({ time: _, ...r }) => r),
      query: Object.fromEntries(FILTERS.filter((f) => q.get(f)).map((f) => [f, q.get(f)!])),
      markets: markets.directory.markets.map((m) => m.name),
    }
  },
  title: () => 'Forest index: search',
  body(o, base) {
    return html`${backHtml(urls(base).home, 'Markets')}
<h1>Search</h1>
${searchForm(base, o.markets, o.query)}
<p>${o.total} found.</p>
${rowsHtml(o.results.map(resultHtml))}`
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
