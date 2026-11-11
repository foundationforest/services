// `/`, twin `/index.json`: the markets, each with its summary, its status, how many listings each of
// its roles has listed and each role's word for its listings, this index's address, and its lists;
// drawn as the question, one search box, and a tile per market with its summary, a beta one marked
// so. The lists are drawn on the About page.

import type { Role, Status } from '@foundationforest/markets'

import { listsOf, type ListsShown } from './about.ts'
import { betaChip, colorOf, countText, inWords, marketIcon } from './common.ts'
import { html, type Page, searchBox, urls } from './template.ts'

export type Home = {
  index: string
  /** Each market in the directory, its summary, its description, its status, its role words, how many listings each role has listed here, and each role's word for its listings. */
  markets: Array<{ name: string; summary: string; description: string; status: Status; roles: string[]; listed: { [role: string]: number }; words: { [role: string]: Role['listings'] } }>
  lists: ListsShown
}

/** How many listings each role has listed, in its own word, one per line: "1 offer", "2 requests"; a role with none is left out, and "None yet" when no role has any. */
export function countsOf(m: Home['markets'][number]): string[] {
  const lines = m.roles.filter((r) => (m.listed[r] ?? 0) > 0).map((r) => countText(m.listed[r]!, m.words[r]!))
  return lines.length ? lines : ['None yet']
}

export const home: Page<Home> = {
  name: 'home',
  data({ store, lists, markets, self }) {
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
        description: m.description,
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
    // A tile's icon is the market's avatar's, in its color on the tile's tint of it, as the app's
    // market tiles draw it; the tile's name and summary say what it is, with a chip when the market
    // is beta. A live market has none: live is the usual case.
    return html`<h1 class="hello">What are you looking for?</h1>
${searchBox(base, { placeholder: 'A maths tutor, a wool coat, a plumber', button: true })}
<h2>Markets</h2>
<div class="tiles">${o.markets.map((m) => html`<a class="tile tint" style="--h:${colorOf(site, m.name)}" href="${urls(base).market(m.name)}"><span class="hue" aria-hidden="true">${marketIcon(site, m.name)}</span><span>${inWords(m.name)}${m.status === 'beta' ? html` ${betaChip}` : ''}<span class="xs">${m.summary}</span><span class="xs">${countsOf(m).map((line, i) => html`${i ? html`<br>` : ''}${line}`)}</span></span></a>`)}</div>`
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
