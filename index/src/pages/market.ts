// `/markets/<name>`: the market's file, verbatim from the pinned directory, and its listed posts by
// role, each with what its profile shows, sorted as search sorts them (search.ts). Drawn as the
// market's name in words, then a section per role titled by its word for its posts, each post a row
// linking to its page.

import type { Market } from '@foundationforest/markets'

import { inWords, offerOf, type Result, resultHtml, results, rowsHtml } from './common.ts'
import { backHtml, html, type Page, urls } from './template.ts'

export type MarketPage = { index: string; market: unknown; posts: { [role: string]: Result[] } }

export const market: Page<MarketPage> = {
  data({ store, markets, self, base }, [name]) {
    const m = name ? markets.market(name) : undefined
    if (!m) return null
    const posts = Object.fromEntries(
      m.roles.map((r) => [r.role, results(store, base, 'and f.market = ? and f.role = ?', [m.name, r.role]).map(({ time: _, ...result }) => result)]),
    )
    return { index: self, market: m, posts }
  },
  title: (o) => `Forest index: ${(o.market as Market).name}`,
  body(o, base) {
    const m = o.market as Market
    return html`${backHtml(urls(base).home, 'Markets')}
<div class="lead"><h1>${inWords(m.name)}</h1><p>${m.description}</p></div>
${m.roles.map((r) => html`<section><h2>${r.posts.charAt(0).toUpperCase() + r.posts.slice(1)}</h2>${rowsHtml(o.posts[r.role]!.map(resultHtml), `No ${r.posts} yet.`)}</section>`)}`
  },
  ld(o, base, url) {
    const m = o.market as Market
    const all = Object.values(o.posts).flat()
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          '@id': url,
          url,
          name: m.name,
          description: m.description,
          mainEntity: { '@type': 'ItemList', numberOfItems: all.length, itemListElement: all.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: offerOf(r, base) })) },
        },
      ],
    }
  },
}
