// `/search`: the listings this index lists, each with what its profile shows (its ratings, trust,
// uniqueness and checks), sorted by its ratings with one unit of its market's average added
// (README.md, How it scores), then the newest listing; with near, nearest first.
//
//   q            words in the listing, each a word's start, all of them (FTS5)
//   market, role only that market, only listings by that role
//   near, km     near=lat,lon and km, how far the searcher would go (10 unless given): a listing with
//                a place whose circle reaches that far, the distance between the two points at most km
//                plus its radiusKm; each result then carries km, its distance between the two
//                points, and results come nearest first, ties in the order above; a listing with
//                no place is left out
//   minRating    a profile rated at least this; one with no rating is left out
//   minReviews   a profile scored by at least this many raters
//   limit        20 unless given, at most 100; offset skips that many
//
// With market, also a filter per listing field of that market, by its type (filterable): a choice
// by its name, `<field>=<value>`, a listing whose field holds that value, among its values for a
// many one; a number by `<field>.min` and `<field>.max`, in its unit, a listing whose number is in
// that range. A listing without the field is left out once it is filtered on.
//
// Its JSON gives, beside the results, `query`, each of these filters as it was given, and `markets`,
// every market's name, so its page draws its search box, filled with what was searched, and its
// filters.

import type { Field, Market } from '@foundationforest/markets'

import { avatarHtml, choiceText, fieldLabel, inWords, offerOf, type Result, resultHtml, results, unitText, wordFor } from './common.ts'
import { icon } from './icons.ts'
import { backHtml, html, type Page, type Raw, searchBox, urls } from './template.ts'

export const LIMIT = 20
export const MAX_LIMIT = 100
export const KM = 10

/** A point, `near=lat,lon`, as search reads one. */
const NEAR = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

/** How far the form offers, in km; the one asked joins them when it is another. */
const HOW_FAR = ['2', '5', '10', '25', '50', '100']

/** The ratings the form offers, each a `minRating`, beside Any. */
const RATINGS = ['8', '9']

/** The filters search reads, in the order its query names them. */
export const FILTERS = ['q', 'market', 'role', 'near', 'km', 'minRating', 'minReviews', 'limit', 'offset']

/**
 * The listing fields of a market search filters by: each choice and each number. A field named as
 * one of search's own filters is filtered by that filter, never as a field, since the query holds
 * one value per name.
 */
export const filterable = (m: Market): Array<[string, Field]> => Object.entries(m.listing).filter(([name, f]) => (f.type === 'choice' || f.type === 'number') && !FILTERS.includes(name))

/** The names a field's filter takes in the query: a choice's own name, a number's `<name>.min` and `<name>.max`. */
const namesOf = ([name, f]: [string, Field]) => (f.type === 'number' ? [`${name}.min`, `${name}.max`] : [name])

/** What a field holds, as a list: each value of a many one, or its one value, or none. */
const heldIn = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])

/** A number filter's range in words, in its unit: "30 to 60 minutes", "at least 3 nights", "at most 1 person". */
function rangeText(min: string | undefined, max: string | undefined, unit: string): string {
  if (min && max) return `${min} to ${max} ${unitText(unit, max)}`
  return min ? `at least ${min} ${unitText(unit, min)}` : `at most ${max} ${unitText(unit, max!)}`
}

export type SearchPage = {
  index: string
  total: number
  /** With near, each with `km`, its distance from that point. */
  results: Array<Result & { km?: number }>
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

/** Every place a listing names, in a field of the place type, its point and its radius: read by its shape, as the markets' types say. */
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

export const search: Page<SearchPage> = {
  name: 'search',
  noindex: true,
  data({ store, markets, self, base }, _path, q) {
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
    let found: Array<Result & { time: number; km?: number }> = results(store, base, where.join(' '), params)
    const m = q.get('market') ? markets.market(q.get('market')!) : undefined
    const fields = m ? filterable(m) : []
    for (const [name, f] of fields) {
      if (f.type === 'choice') {
        const value = q.get(name)
        if (value) found = found.filter((r) => heldIn(r.listing.body[name]).includes(value))
        continue
      }
      const min = number(q, `${name}.min`)
      const max = number(q, `${name}.max`)
      if (min !== null || max !== null) found = found.filter((r) => heldIn(r.listing.body[name]).some((v) => (min === null || Number(v) >= min) && (max === null || Number(v) <= max)))
    }
    const near = NEAR.exec(q.get('near') ?? '')
    if (near) {
      const at = { lat: Number(near[1]), lon: Number(near[2]) }
      const within = number(q, 'km') ?? KM
      // Two places match when their circles touch: the searcher's, of radius km, and the listing's.
      // A result's km is to one decimal, a hundred metres, finer than a rough point means.
      found = found
        .flatMap((r) => {
          const reached = pointsOf(r.listing.body).map((p) => ({ d: km(at, p), r: p.radiusKm })).filter((p) => p.d <= within + p.r)
          return reached.length ? [{ ...r, d: Math.min(...reached.map((p) => p.d)) }] : []
        })
        .sort((a, b) => a.d - b.d)
        .map(({ d, ...r }) => ({ ...r, km: Math.round(d * 10) / 10 }))
    }
    const limit = Math.min(Math.max(Math.trunc(number(q, 'limit') ?? LIMIT), 1), MAX_LIMIT)
    const offset = Math.max(Math.trunc(number(q, 'offset') ?? 0), 0)
    return {
      index: self,
      total: found.length,
      results: found.slice(offset, offset + limit).map(({ time: _, ...r }) => r),
      query: Object.fromEntries([...FILTERS, ...fields.flatMap(namesOf)].filter((f) => q.get(f)).map((f) => [f, q.get(f)!])),
      markets: markets.directory.markets.map((m) => m.name),
    }
  },
  title: () => 'Forest index: search',
  searched: (o) => o.query,
  // The filters are links and one form, for a page with no script. A link changes one filter and
  // keeps the rest; the form asks the side, how far and the rating together, and carries the words
  // and the market along. The market is a link, not one of the form's fields: a role is one of its
  // market's, so changing the market drops the side, which a form with no script cannot do. Near
  // is a point, and a page with no script cannot find one for a town's name, so it shows only when
  // the address carries one, as an app or an AI writes it; a town's name in the words finds the
  // listings whose place is called so. Once a market is chosen, the form asks each of its fields
  // search filters by, for the side chosen, or every side: a choice as a picker of its values by
  // their labels, a number as a range in its unit; and changing the market drops them.
  body(o, base, site) {
    const q = o.query
    const link = (change: { [filter: string]: string | null }) => {
      const asked: { [filter: string]: string | null } = { ...q, offset: null, ...change }
      return urls(base).search(Object.fromEntries(Object.entries(asked).filter((e): e is [string, string] => e[1] !== null)))
    }
    const m = q.market ? site.markets.market(q.market) : undefined
    const side = m?.roles.find((r) => r.role === q.role)
    const other = side ? m!.roles.find((r) => r.role !== side.role) : undefined
    // Field filters belong to their market: a link that changes it drops them.
    const drop = Object.fromEntries(Object.keys(q).filter((n) => !FILTERS.includes(n)).map((n) => [n, null]))
    const fields = m ? filterable(m) : []
    const asked = fields.filter((field) => namesOf(field).some((n) => q[n] !== undefined))
    const shown = fields.filter(([, f]) => !side || !f.roles || f.roles.includes(side.role))
    // A link to the other side drops the filters on fields its listings never hold.
    const dropFor = (role: string) => Object.fromEntries(asked.filter(([, f]) => f.roles && !f.roles.includes(role)).flatMap((field) => namesOf(field).map((n) => [n, null])))
    const fieldChip = ([name, f]: [string, Field]) => {
      const words = `${fieldLabel(name)}: ${f.type === 'choice' ? choiceText(q[name], f.labels) : rangeText(q[`${name}.min`], q[`${name}.max`], f.unit!)}`
      return html`<a class="fchip on" href="${link(Object.fromEntries(namesOf([name, f]).map((n) => [n, null])))}" aria-label="${`Remove ${words}`}">${words}${icon('x', 'bold')}</a>`
    }
    const fieldGroup = ([name, f]: [string, Field]) => {
      const label = fieldLabel(name)
      if (f.type === 'choice') {
        return html`<div class="group"><span class="lab">${label}</span><label class="inp"><select name="${name}" aria-label="${label}"><option value="">Any</option>${f.values!.map((v) => html`<option value="${v}"${v === q[name] ? ' selected' : ''}>${choiceText(v, f.labels)}</option>`)}</select></label></div>`
      }
      const box = (end: 'min' | 'max', words: string) => {
        const given = q[`${name}.${end}`]
        return html`<label class="inp"><span class="s">${words}</span><input type="number" name="${name}.${end}"${given === undefined ? '' : html` value="${given}"`} step="any" aria-label="${`${label}, ${words.toLowerCase()}`}"></label>`
      }
      return html`<div class="group"><span class="lab">${label}</span><div class="range">${box('min', 'From')}${box('max', 'To')}<span class="s">${unitText(f.unit!, '')}</span></div></div>`
    }
    const near = NEAR.test(q.near ?? '') ? q.near! : null
    const { q: words, offset: _, ...rest } = q
    const hidden = (names: string[]) => names.filter((n) => q[n] !== undefined).map((n) => html`<input type="hidden" name="${n}" value="${q[n]!}">`)
    const radio = (name: string, value: string, words: Raw | string, checked: boolean) =>
      html`<label class="${name === 'role' ? 'pick' : 'fchip pick'}"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}>${words}</label>`
    const chips = html`<nav class="fchips" aria-label="Filters">${
      q.market ? html`<a class="fchip on" href="${link({ market: null, role: null, ...drop })}" aria-label="${`Remove ${inWords(q.market)}`}">${avatarHtml(site, q.market, { size: 'xs' })}${inWords(q.market)}${icon('x', 'bold')}</a>` : ''
    }${asked.map(fieldChip)}${near ? html`<a class="fchip on" href="${link({ near: null, km: null })}" aria-label="Remove near">${icon('map-pin')}Near ${near.replace(',', ', ')}${icon('x', 'bold')}</a>` : ''}${
      q.minRating
        ? html`<a class="fchip on" href="${link({ minRating: null })}" aria-label="${`Remove rated ${q.minRating} or more`}">${icon('star')}${q.minRating}+${icon('x', 'bold')}</a>`
        : html`<a class="fchip" href="${link({ minRating: '8' })}">${icon('star')}8+</a>`
    }<a class="fchip" href="#filters">${icon('sliders-horizontal')}More</a></nav>`
    const km = q.km ?? String(KM)
    const form = html`<form class="filters" id="filters" action="${urls(base).search({})}" method="get" aria-label="Filters">${hidden(['q', 'market'])}
<div class="group"><span class="lab">Market</span>${[null, ...o.markets].map((name) => html`<a class="radio" href="${link({ market: name, role: null, ...drop })}"${(q.market ?? null) === name ? html` aria-current="true"` : ''}><span class="r"></span>${name ? inWords(name) : 'All'}</a>`)}</div>
${m && m.roles.length > 1 ? html`<div class="group" role="radiogroup" aria-label="Show"><span class="lab">Show</span><div class="seg">${m.roles.map((r) => radio('role', r.role, inWords(r.listings), r.role === q.role))}</div></div>` : hidden(['role'])}
${near ? html`<div class="group"><span class="lab">Near</span><span class="s">${near.replace(',', ', ')}, <a href="${link({ near: null, km: null })}">remove</a></span><input type="hidden" name="near" value="${near}"><label class="inp"><span class="s">Within</span><select name="km" aria-label="How far">${[...new Set([...HOW_FAR, km])].map((n) => html`<option value="${n}"${n === km ? ' selected' : ''}>${n} km</option>`)}</select></label></div>` : ''}
<div class="group" role="radiogroup" aria-label="Rating"><span class="lab">Rating</span><div class="chips">${[...new Set(['', ...RATINGS, q.minRating ?? ''])].map((n) => radio('minRating', n, n ? html`${icon('star', 'fill')}${n}+` : 'Any', n === (q.minRating ?? '')))}</div></div>
${shown.map(fieldGroup)}
${hidden(['minReviews', 'limit'])}<button class="btn plain sm" type="submit">Apply</button></form>`
    const what = side ? side.listings : 'listings'
    return html`<div class="bar">${backHtml(urls(base).home, true)}${searchBox(base, { placeholder: 'Search listings', q: words, keep: rest })}</div>
${chips}
${form}
<section class="found" aria-label="Results"><div class="count"><p class="s"><b>${o.total}</b> ${wordFor(o.total, what)}${words ? ` for "${words}"` : ''}${q.market ? ` in ${inWords(q.market)}` : ''}, ${near ? 'nearest' : 'best'} first</p>${other ? html`<a class="btn text fit" href="${link({ role: other.role, ...dropFor(other.role) })}">${inWords(other.listings)}</a>` : ''}</div>
${o.results.length ? html`<div class="list">${o.results.map((r) => resultHtml(site, r))}</div>` : ''}</section>`
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
