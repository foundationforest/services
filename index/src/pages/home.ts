// `/`, twin `/index.json`: the markets, this index's address, and its lists.

import { html, type Page, urls } from './template.ts'

export type Home = {
  index: string
  markets: Array<{ name: string; description: string; roles: string[] }>
  lists: {
    hosts: string[]
    keys: Array<{ key: string; verifier: string; label: string; points: number; until?: string }>
    indexes: Array<{ index: string; name: string }>
    maxAgeDays: number
  }
}

export const home: Page<Home> = {
  data({ lists, markets, self }) {
    return {
      index: self,
      markets: markets.list.map((m) => ({ name: m.name, description: m.description, roles: m.roles.map((r) => r.role) })),
      lists: {
        hosts: lists.hosts,
        keys: lists.keys.map((k) => ({ key: k.key, verifier: k.verifier, label: k.label, points: k.points, ...(k.until !== undefined && { until: new Date(k.until).toISOString() }) })),
        indexes: lists.indexes.map((i) => ({ index: i.index === 'self' ? self : i.index, name: i.name })),
        maxAgeDays: lists.maxAgeDays,
      },
    }
  },
  title: () => 'Forest index: markets',
  body(o, base) {
    return html`<h1>Markets</h1>
${o.markets.map((m) => html`<section><h2><a href="${urls(base).market(m.name)}">${m.name}</a></h2><p>${m.description}</p><p class="muted">Roles: ${m.roles.join(', ')}</p></section>`)}
<h2>What this index reads</h2>
<p>Hosts, each read in full: ${o.lists.hosts.join(', ') || 'none'}.</p>
<p>Verifier keys it counts: ${o.lists.keys.length ? o.lists.keys.map((k) => html`<br><code>${k.key}</code>, the ${k.label} of ${k.verifier}, ${k.points} points${k.until ? `, until ${k.until}` : ''}`) : 'none yet, so no profile counts here yet.'}</p>
<p>Reputation proofs it shows: ${o.lists.indexes.map((i) => html`${i.name} (<code>${i.index}</code>)`)}, against an index's newest root or one it signed in the last ${o.lists.maxAgeDays} days.</p>`
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
