// `/`, twin `/index.json`: the markets, each with its summary, its status, how many listings each of
// its roles has listed and each role's word for its listings, this index's address, and its lists;
// drawn as one search box and a tile per market, filled with its color, its icon big at its top
// right, its name and how many listings each of its roles has, every role and 0 among them. Its
// summary, its description and whether it is beta are on its own page. The lists are drawn on the
// About page.

import type { Role, Status } from '@foundationforest/markets'

import { listsOf, type ListsShown } from './about.ts'
import { colorOf, countText, inWords, marketIcon } from './common.ts'
import { icon } from './icons.ts'
import { html, type Page, urls } from './template.ts'

export type Home = {
  index: string
  /** Each market in the directory, its summary, its description if it has one, its status, its role words, how many listings each role has listed here, and each role's word for its listings. */
  markets: Array<{ name: string; summary: string; description?: string; status: Status; roles: string[]; listed: { [role: string]: number }; words: { [role: string]: Role['listings'] } }>
  lists: ListsShown
}

/** How many listings each role has listed, in its own word, every role and 0 among them: "48 offers · 12 requests", "0 offers · 1 request". */
export const countsOf = (m: Home['markets'][number]): string => m.roles.map((r) => countText(m.listed[r] ?? 0, m.words[r]!)).join(' · ')

export const home: Page<Home> = {
  name: 'home',
  async data({ store, lists, markets, self }) {
    const counted = store.db.prepare('select f.market, f.role, count(*) as n from listings l join profiles f on f.address = l.profile where l.listed = 1 group by f.market, f.role').all() as Array<{
      market: string
      role: string
      n: number
    }>
    const listed = (market: string, role: string) => counted.find((c) => c.market === market && c.role === role)?.n ?? 0
    return {
      index: self,
      markets: markets.directory.markets.map((m) => ({
        name: m.name,
        summary: m.summary,
        ...(m.description !== undefined && { description: m.description }),
        status: m.status,
        roles: m.roles.map((r) => r.role),
        listed: Object.fromEntries(m.roles.map((r) => [r.role, listed(m.name, r.role)])),
        words: Object.fromEntries(m.roles.map((r) => [r.role, r.listings])),
      })),
      lists: listsOf(lists, self),
    }
  },
  title: () => 'Forest index: markets',
  body(o, base, site) {
    // A tile's words are white on its color: its name large (19px at 800, large text, at least 3:1
    // on every color), its counts small, over the fade laid behind them (template.ts, TILE), which
    // keeps them past 4.5:1 on every color, tested in test/contrast.test.ts.
    return html`<h1 class="hide">Forest index</h1>
<form class="ask" action="${urls(base).search({})}" method="get" role="search"><label>${icon('magnifying-glass')}<input type="search" name="q" placeholder="Search Forest" aria-label="Search Forest"></label><button class="btn go" type="submit">Search</button></form>
<nav class="tiles" aria-label="Markets">${o.markets.map((m) => html`<a class="tile" style="--h:${colorOf(site, m.name)}" href="${urls(base).market(m.name)}"><span class="big" aria-hidden="true">${marketIcon(site, m.name)}</span><span class="name">${inWords(m.name)}</span><span class="n">${countsOf(m)}</span></a>`)}</nav>`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': url, url, name: 'Forest index', identifier: o.index },
        { '@type': 'ItemList', name: 'Markets', itemListElement: o.markets.map((m, i) => ({ '@type': 'ListItem', position: i + 1, name: m.name, description: m.summary, url: urls(base).market(m.name) })) },
      ],
    }
  },
}
