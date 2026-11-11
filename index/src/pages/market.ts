// `/markets/<name>`: the market's file, verbatim from the pinned directory, and the listings this
// index lists, by role, each with what its profile shows, sorted as search sorts them (search.ts).
// Drawn as a header on the market's tint: its avatar, its name in words, a chip when it is beta, its
// counts, its summary and then its description, as the markets' directory.md shows them, since the
// description says only what the summary leaves out, and for a beta market the line saying what beta
// means; then one side per role, each with the tabs, a search box for that side, and its results.
//
// The page reads no query, and its body is drawn from its JSON alone, so its tabs are links to each
// side's own anchor, `#<role>`, and the stylesheet shows the side the address names (`:target`), the
// first when it names none. A browser that cannot ask which side is named (`:has`) shows both.

import type { Market } from '@foundationforest/markets'

import { avatarHtml, BETA, betaChip, colorOf, countText, inWords, offerOf, type Result, resultHtml, results } from './common.ts'
import { backHtml, html, type Page, searchBox, urls } from './template.ts'

export type MarketPage = { index: string; market: unknown; listings: { [role: string]: Result[] } }

export const market: Page<MarketPage> = {
  name: 'market',
  data({ store, markets, self, base }, [name]) {
    const m = name ? markets.market(name) : undefined
    if (!m) return null
    const listings = Object.fromEntries(
      m.roles.map((r) => [r.role, results(store, base, 'and f.market = ? and f.role = ?', [m.name, r.role]).map(({ time: _, ...result }) => result)]),
    )
    return { index: self, market: m, listings }
  },
  title: (o) => `Forest index: ${(o.market as Market).name}`,
  body(o, base, site) {
    const m = o.market as Market
    const counts = m.roles.filter((r) => o.listings[r.role]!.length > 0).map((r) => countText(o.listings[r.role]!.length, r.listings))
    // "Tutor offers", "Student requests": a role and its word, never a plural of a role.
    const tab = (r: Market['roles'][number]) => `${inWords(r.role)} ${r.listings}`
    return html`<div class="head tint" style="--h:${colorOf(site, m.name)}">${backHtml(urls(base).home)}
<div class="me">${avatarHtml(site, m.name, { size: 'lg' })}<div><h1>${inWords(m.name)}</h1>${m.status === 'beta' ? betaChip : ''}<span class="s">${counts.join(', ') || 'None yet'}</span></div></div>
<p>${m.summary} ${m.description}</p>${m.status === 'beta' ? html`\n<p class="s">${BETA}</p>` : ''}</div>
${m.roles.map(
  (r) => html`<section class="side" id="${r.role}" aria-label="${tab(r)}">${m.roles.length > 1 ? html`<nav class="ptabs" aria-label="Sides">${m.roles.map((t) => html`<a href="#${t.role}"${t.role === r.role ? html` aria-current="true"` : ''}>${tab(t)}</a>`)}</nav>` : ''}
${searchBox(base, { placeholder: `Search ${inWords(m.name).toLowerCase()}`, keep: { market: m.name, role: r.role } })}
${o.listings[r.role]!.length ? html`<div class="list">${o.listings[r.role]!.map((x) => resultHtml(site, x))}</div>` : html`<p>No ${r.listings} yet.</p>`}</section>`,
)}`
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
          description: `${m.summary} ${m.description}`,
          mainEntity: { '@type': 'ItemList', numberOfItems: all.length, itemListElement: all.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: offerOf(r, base) })) },
        },
      ],
    }
  },
}
