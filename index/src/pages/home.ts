// `/`, twin `/index.json`: the markets, each with how many posts each of its roles has listed, this
// index's address, and its lists; and a search box.

import { html, type Page, type Raw, urls } from './template.ts'

export type Home = {
  index: string
  /** Each market in the directory, its role words, and how many posts each role has listed here. */
  markets: Array<{ name: string; description: string; roles: string[]; listed: { [role: string]: number } }>
  lists: {
    hosts: string[]
    keys: Array<{ key: string; verifier: string; label: string; confidence: number; until?: string }>
    indexes: Array<{ index: string; name: string }>
    maxAgeDays: number
  }
}

/** The search box: words, and the market, any of the directory's. */
export function searchForm(base: string, markets: string[]): Raw {
  return html`<form action="${urls(base).search({})}" method="get"><input name="q" placeholder="Words" aria-label="Words"> <select name="market" aria-label="Market"><option value="">Any market</option>${markets.map((m) => html`<option value="${m}">${m}</option>`)}</select> <button>Search</button></form>`
}

const posts = (n: number, role: string) => `${n} ${role} post${n === 1 ? '' : 's'}`

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
      })),
      lists: {
        hosts: lists.hosts,
        keys: lists.keys.map((k) => ({ key: k.key, verifier: k.verifier, label: k.label, confidence: k.confidence, ...(k.until !== undefined && { until: new Date(k.until).toISOString() }) })),
        indexes: lists.indexes.map((i) => ({ index: i.index === 'self' ? self : i.index, name: i.name })),
        maxAgeDays: lists.maxAgeDays,
      },
    }
  },
  title: () => 'Forest index: markets',
  body(o, base) {
    return html`<h1>Markets</h1>
${searchForm(base, o.markets.map((m) => m.name))}
${o.markets.map((m) => html`<section><h2><a href="${urls(base).market(m.name)}">${m.name}</a></h2><p>${m.description}</p><p class="muted">${m.roles.map((r) => posts(m.listed[r] ?? 0, r)).join(' · ')}</p></section>`)}
<h2>What this index reads</h2>
<p>Hosts, each read in full: ${o.lists.hosts.join(', ') || 'none'}.</p>
<p>Verifier keys it counts: ${o.lists.keys.length ? o.lists.keys.map((k) => html`<br><code>${k.key}</code>, the ${k.label} of ${k.verifier}, confidence ${k.confidence}${k.until ? `, until ${k.until}` : ''}`) : 'none yet, so no profile counts here yet.'}</p>
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
