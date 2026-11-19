// `/markets/<name>`: the market's file, verbatim from the pinned directory, and the listings this
// index lists, by role, each with what its profile shows, in the order Top rated gives (search.ts);
// and the page's own view, one side of it: `role`, the side shown (the query's, else the market's
// first), and what search's `find` gives for that side and the query (its words, its place, its
// filters on the side's fields, its price and rating filters, its order and its page), with
// `currencies`, those this side's listings price in, most used first, for the price filter's picker.
//
// Drawn as its head, the market's icon on its color, its name, Beta beside it when beta, its summary
// under, and what beta means under that; its description in a fold, so the page stays short; its
// sides as tabs, each a link that keeps the words and the place, with how many listings it lists;
// then Where and the filters, how many results and in what order, the results as a grid or a list
// (common.ts, layoutOf), and Show more.
//
// The filters are one GET form, drawn once. On a laptop it is a line of folds (HTML's own), each with
// its own Show button. On a phone it is hidden until the Where or Filters chip opens it at `#filters`
// (CSS `:target`), where it covers the page as a page of its own, every fold open, with Clear all
// and one Show button at its foot: the same form, so neither needs a page or a JSON twin of its own.

import type { Field, Market } from '@foundationforest/markets'

import { BETA, betaFlag, fieldLabel, inWords, layoutOf, marketHtml, offerOf, pricesOf, type Result, resultsHtml, results, wordFor } from './common.ts'
import { icon } from './icons.ts'
import { askedBy, carried, filterable, find, hiddenOf, linker, moreHtml, type Near, namesOf, noPlaceHtml, orderHtml, PRICE, placeWords, pricedIn, RATINGS, wantedOf, whereInputs } from './search.ts'
import { html, type Page, type Raw, type Site, urls } from './template.ts'
import { amountText } from './words.ts'

export type MarketPage = {
  index: string
  market: unknown
  /** Every listing this index lists in it, by role, in the order Top rated gives. */
  listings: { [role: string]: Result[] }
  /** The side the page shows: the query's role, else the market's first. */
  role: string
  /** Each filter as it was given, as search gives it; the market is the page's own. */
  query: { [filter: string]: string }
  /** How many listings of that side the query finds, every page of them. */
  total: number
  /** A page of them, in the query's order; with a place, each with `km`. */
  results: Array<Result & { km?: number }>
  /** The place the results are near, or null. */
  place: Near | null
  /** The currencies that side's listings price in, most used first: the price filter's picker. */
  currencies: string[]
}

/** The most values a choice field's filter shows as chips; one with more is a picker. */
const CHIPS = 12

/** The currencies listings price in, most used first, each listing counting once for each; then by code. */
function currenciesOf(listings: Result[]): string[] {
  const uses = new Map<string, number>()
  for (const r of listings) for (const c of new Set(pricesOf(r.listing.body).map((p) => p.currency))) uses.set(c, (uses.get(c) ?? 0) + 1)
  return [...uses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c]) => c)
}

/** A per as a price says it for one: "an hour", "a month". */
const onePer = (per: string) => `${/^(hour|[aeio])/.test(per) ? 'an' : 'a'} ${per}`

/** The price filter in words, for its chip on a laptop: "Up to €40 an hour", "€10 to €40", "In EUR". */
function priceWords(q: { [filter: string]: string }): string {
  const currency = q['price.currency']!
  const [min, max] = [q['price.min'], q['price.max']].map((n) => (n ? amountText(n, currency) : ''))
  const range = min && max ? `${min} to ${max}` : max ? `Up to ${max}` : min ? `From ${min}` : `In ${currency}`
  return q['price.per'] ? `${range} ${onePer(q['price.per'])}` : range
}

/** The filters form: one GET form to the market's page, its folds Where, each field the side is asked, the price and the rating. */
function filtersHtml(site: Site, base: string, o: MarketPage, m: Market, word: string, keep: { [filter: string]: string }): { form: Raw; on: number } {
  const q = o.query
  const said = askedBy(site.markets, m, o.role)
  const fields = filterable(m).filter(([name]) => said.has(name))
  const labelOf = (name: string) => said.get(name)?.label ?? fieldLabel(name)
  const wanted = (field: [string, Field]) => wantedOf((n) => q[n], field)
  const show = html`<button class="btn go show" type="submit">Show ${word}</button>`
  const fold = (title: string, now: string | null, body: Raw | Raw[]) =>
    html`<details class="drop"><summary class="${now ? 'chip on' : 'chip'}"><span>${title}${now ? html`<span class="on">: ${now}</span>` : ''}</span>${icon('caret-down', 'regular', 'xs')}</summary><div class="panel">${body}${show}</div></details>`
  const radio = (name: string, value: string, words: string, checked: boolean) => html`<label class="chip pick"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}>${words}</label>`

  const fieldFold = (field: [string, Field]) => {
    const [name, f] = field
    const label = labelOf(name)
    const asked = wanted(field)
    const now = asked === undefined ? null : site.markets.read(f, asked)
    if (f.piece === 'choice') {
      // Its values as chips, one picked, Any first; a field with more than CHIPS values, such as a
      // language from the markets' shared list, as a picker of them, which a phone can hold.
      const choices = said.get(name)!.choices ?? []
      if (choices.length > CHIPS) {
        return fold(label, now, html`<label class="inp"><select name="${name}" aria-label="${label}"><option value="">Any</option>${choices.map((c) => html`<option value="${c.value}"${c.value === q[name] ? ' selected' : ''}>${c.label}</option>`)}</select></label>`)
      }
      return fold(label, now, html`<div class="opts" role="radiogroup" aria-label="${label}">${radio(name, '', 'Any', !q[name])}${choices.map((c) => radio(name, c.value, c.label, c.value === q[name]))}</div>`)
    }
    const box = (end: 'min' | 'max', words: string) => {
      const given = q[`${name}.${end}`]
      return html`<label class="inp"><input type="number" name="${name}.${end}"${given === undefined ? '' : html` value="${given}"`} step="any" placeholder="${words}" aria-label="${`${label}, ${words.toLowerCase()}`}"></label>`
    }
    return fold(label, now, html`<div class="range">${box('min', 'From')}${box('max', 'To')}${f.unit ? html`<span class="s">${f.unit.replaceAll('-', ' ')}</span>` : ''}</div>`)
  }

  // The price: "Up to [amount] [per]", in a currency, the most used first; the per the market's own,
  // the first picked, or the whole deal. Only where the side is asked a price and some listing has one.
  const priceField = said.get('price')
  const priceFold = (() => {
    if (priceField?.piece !== 'price' || !o.currencies.length) return null
    const pers = m.listing.price?.per ?? []
    const currency = q['price.currency'] ?? o.currencies[0]!
    const per = q['price.currency'] ? (q['price.per'] ?? '') : (pers[0] ?? '')
    const perPicker = pers.length
      ? html`<label class="inp unit"><select name="price.per" aria-label="Per">${pers.map((p) => html`<option value="${p}"${p === per ? ' selected' : ''}>${onePer(p)}</option>`)}<option value=""${per === '' ? ' selected' : ''}>in all</option></select></label>`
      : ''
    const currencyPicker = html`<label class="inp unit"><select name="price.currency" aria-label="Currency">${[...new Set([currency, ...o.currencies])].map((c) => html`<option value="${c}"${c === currency ? ' selected' : ''}>${c}</option>`)}</select></label>`
    return fold('Price', pricedIn(q) ? priceWords(q) : null, html`<div class="price"><span class="s">Up to</span><label class="inp"><input type="number" name="price.max"${q['price.max'] ? html` value="${q['price.max']}"` : ''} step="any" min="0" placeholder="Amount" aria-label="Up to"></label>${perPicker}${currencyPicker}</div>`)
  })()

  const ratingFold = fold(
    'Rating',
    q.minRating ? `${q.minRating} or more` : null,
    html`<div class="opts" role="radiogroup" aria-label="Rating">${[...new Set(['', ...RATINGS, q.minRating ?? ''])].map((n) => radio('minRating', n, n ? `${n} or more` : 'Any', n === (q.minRating ?? '')))}</div>`,
  )

  const on = fields.filter((field) => wanted(field) !== undefined).length + (pricedIn(q) ? 1 : 0) + (q.minRating ? 1 : 0)
  const asks = [...fields.flatMap(namesOf), ...PRICE, 'minRating', 'near', 'near.name', 'km']
  const clear = urls(base).market(m.name, { ...(q.q && { q: q.q }), ...(q.role && { role: q.role }) })
  const form = html`<form class="filters" id="filters" action="${urls(base).market(m.name)}" method="get" aria-label="Filters"><div class="fhead"><a class="round" href="#" aria-label="Close">${icon('x', 'bold')}</a><h2>Filters</h2></div>${hiddenOf(keep, asks)}${fold('Where', o.place ? placeWords(o.place) : null, whereInputs(o.place))}${fields.map(fieldFold)}${priceFold ?? ''}${ratingFold}<div class="ffoot"><a class="link" href="${clear}">Clear all</a><button class="btn go" type="submit">Show ${word}</button></div></form>`
  return { form, on }
}

export const market: Page<MarketPage> = {
  name: 'market',
  async data(ctx, [name], q) {
    const m = name ? ctx.markets.market(name) : undefined
    if (!m) return null
    const listings = Object.fromEntries(
      m.roles.map((r) => [r.role, results(ctx.store, ctx.base, 'and f.market = ? and f.role = ?', [m.name, r.role]).map(({ time: _, ...result }) => result)]),
    )
    const role = m.roles.find((r) => r.role === q.get('role'))?.role ?? m.roles[0]!.role
    const asked = new URLSearchParams(q)
    asked.set('market', m.name)
    asked.set('role', role)
    const { query, total, results: found, place } = await find(ctx, asked)
    const { market: _, role: __, ...rest } = query
    return { index: ctx.self, market: m, listings, role, query: { ...(q.get('role') === role && { role }), ...rest }, total, results: found, place, currencies: currenciesOf(listings[role]!) }
  },
  title: (o) => `Forest index: ${(o.market as Market).name}`,
  searched: (o) => {
    const { q, near, 'near.name': name, km } = carried(o.query, o.place)
    return Object.fromEntries(Object.entries({ q, near, 'near.name': name, km }).filter((e): e is [string, string] => e[1] !== undefined))
  },
  body(o, base, site) {
    const m = o.market as Market
    const word = m.roles.find((r) => r.role === o.role)!.listings
    const keep = carried(o.query, o.place)
    const link = linker((q) => urls(base).market(m.name, q), keep)
    // A side's tab keeps the words and the place, and drops the filters, which are the other side's.
    const tab = (role: string) => urls(base).market(m.name, { ...(o.query.q && { q: o.query.q }), ...carried({}, o.place), role })
    const { form, on } = filtersHtml(site, base, o, m, word, keep)
    return html`<div class="mhead">${marketHtml(site, m.name, 'md')}<div><h1>${inWords(m.name)}${m.status === 'beta' ? betaFlag : ''}</h1><p class="s">${m.summary}</p>${m.status === 'beta' ? html`<p class="xs">${BETA}</p>` : ''}</div></div>
${m.description ? html`<details class="fold"><summary><span class="grow">More about this market</span>${icon('caret-down')}</summary><div class="fbody"><p>${m.description}</p></div></details>` : ''}
<nav class="sides" aria-label="Sides">${m.roles.map((r) => html`<a href="${tab(r.role)}"${r.role === o.role ? html` aria-current="page"` : ''}>${inWords(r.listings)} <span class="n">${o.listings[r.role]!.length}</span></a>`)}</nav>
<div class="controls"><div class="bar"><a class="${o.place ? 'chip on' : 'chip'}" href="#filters">${icon('map-pin')}${o.place ? placeWords(o.place) : 'Anywhere'}</a><a class="${on ? 'chip on' : 'chip'}" href="#filters">${icon('sliders-horizontal')}Filters${on ? html` <span class="n">${on}</span>` : ''}</a></div>${form}<div class="count"><p><b>${o.total}</b> ${wordFor(o.total, word)}</p></div>${orderHtml(link, o.query, o.place)}</div>
${noPlaceHtml(o.query, o.place)}${o.results.length ? resultsHtml(site, o.results, { layout: layoutOf(site, m.name) }) : ''}${moreHtml(link, o)}`
  },
  ld(o, base, url) {
    const m = o.market as Market
    const all = Object.values(o.listings).flat()
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          '@id': url,
          url,
          name: m.name,
          description: [m.summary, m.description].filter(Boolean).join(' '),
          mainEntity: { '@type': 'ItemList', numberOfItems: all.length, itemListElement: all.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: offerOf(r, base) })) },
        },
      ],
    }
  },
}
