// `/markets/<name>`: the market's file, verbatim from the pinned directory, and its listed posts by
// role, each with what its profile shows, sorted as search sorts them (search.ts).

import type { Market } from '@foundationforest/markets'

import { offerOf, type Result, resultHtml, results } from './common.ts'
import { html, type Page } from './template.ts'

export type MarketPage = { index: string; market: unknown; posts: { [role: string]: Result[] } }

export const market: Page<MarketPage> = {
  data({ store, markets, self }, [name]) {
    const m = name ? markets.market(name) : undefined
    if (!m) return null
    const posts = Object.fromEntries(
      m.roles.map((r) => [r.role, results(store, 'and f.market = ? and f.role = ?', [m.name, r.role]).map(({ time: _, ...result }) => result)]),
    )
    return { index: self, market: m, posts }
  },
  title: (o) => `Forest index: ${(o.market as Market).name}`,
  body(o, base) {
    const m = o.market as Market
    return html`<h1>${m.name}</h1><p>${m.description}</p>
${m.roles.map((r) => html`<h2>${r.role} (${r.posts})</h2>${o.posts[r.role]!.length ? o.posts[r.role]!.map((x) => resultHtml(x, base)) : html`<p class="muted">Nothing listed yet.</p>`}`)}`
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
