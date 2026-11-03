// `/`, twin `/index.json`: the markets, each with how many posts each of its roles has listed and
// each role's word for its posts, this index's address, and its lists; drawn as a search box and
// a row per market. The lists are drawn on the About page.

import { listsOf, type ListsShown } from './about.ts'
import { marketWords } from './common.ts'
import { html, type Page, type Raw, SEARCH_ICON, urls } from './template.ts'

/** A role's word for its posts, as the markets directory gives it. */
export type PostsWord = 'offers' | 'requests' | 'posts'

export type Home = {
  index: string
  /** Each market in the directory, its role words, how many posts each role has listed here, and each role's word for its posts. */
  markets: Array<{ name: string; description: string; roles: string[]; listed: { [role: string]: number }; words: { [role: string]: PostsWord } }>
  lists: ListsShown
}

/**
 * The search box: words, with the search icon, and the market, any of the directory's, in words;
 * the page's one green button. Filled with what was searched, when it is search's own page.
 */
export function searchForm(base: string, markets: string[], asked: { q?: string; market?: string } = {}): Raw {
  return html`<form class="search" action="${urls(base).search({})}" method="get"><label class="box">${SEARCH_ICON}<input name="q"${asked.q ? html` value="${asked.q}"` : ''} placeholder="Search posts" aria-label="Search posts"></label><select name="market" aria-label="Market"><option value="">Any market</option>${markets.map((m) => html`<option value="${m}"${m === asked.market ? ' selected' : ''}>${marketWords(m)}</option>`)}</select><button class="primary">Search</button></form>`
}

/** How many posts each role has listed, in its own word: "1 offer · 2 requests"; a role with none is left out, and "None yet" when no role has any. */
export function countsText(m: Home['markets'][number]): string {
  const parts = m.roles.filter((r) => (m.listed[r] ?? 0) > 0).map((r) => {
    const n = m.listed[r]!
    const word = m.words[r] ?? 'posts'
    return `${n} ${n === 1 ? word.slice(0, -1) : word}`
  })
  return parts.join(' · ') || 'None yet'
}

export const home: Page<Home> = {
  data({ store, lists, markets, self }) {
    const counted = store.db.prepare('select f.market, f.role, count(*) as n from posts p join profiles f on f.address = p.profile where p.listed = 1 group by f.market, f.role').all() as Array<{
      market: string
      role: string
      n: number
    }>
    const listed = (market: string, role: string) => counted.find((c) => c.market === market && c.role === role)?.n ?? 0
    return {
      index: self,
      markets: markets.directory.markets.map((m) => ({
        name: m.name,
        description: m.description,
        roles: m.roles.map((r) => r.role),
        listed: Object.fromEntries(m.roles.map((r) => [r.role, listed(m.name, r.role)])),
        words: Object.fromEntries(m.roles.map((r) => [r.role, r.posts])),
      })),
      lists: listsOf(lists, self),
    }
  },
  title: () => 'Forest index: markets',
  body(o, base) {
    return html`<div class="lead"><h1>Find verified people</h1><p>Offers and requests, ranked by their reviews.</p></div>
${searchForm(base, o.markets.map((m) => m.name))}
<section><h2>Markets</h2>
<div class="rows">${o.markets.map((m) => html`<a class="row" href="${urls(base).market(m.name)}"><span class="two"><strong>${marketWords(m.name)}</strong><span>${m.description}</span></span><span class="aside">${countsText(m)}</span></a>`)}</div></section>`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': url, url, name: 'Forest index', identifier: o.index },
        { '@type': 'ItemList', name: 'Markets', itemListElement: o.markets.map((m, i) => ({ '@type': 'ListItem', position: i + 1, name: m.name, description: m.description, url: urls(base).market(m.name) })) },
      ],
    }
  },
}
