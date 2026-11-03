// `/about`, twin `/about.json`: this index's address and the lists it reads by. Drawn as what this
// index is, what it reads, what a profile's words and numbers mean, its address, and where its JSON,
// its files for AI agents and its source are.

import type { Lists } from '../lists.ts'
import { KEY } from './common.ts'
import { html, NEXT_ICON, type Page, SOURCE, urls } from './template.ts'

export type ListsShown = {
  hosts: string[]
  keys: Array<{ key: string; verifier: string; label: string; confidence: number; until?: string }>
  indexes: Array<{ index: string; name: string }>
  maxAgeDays: number
}

export type About = { index: string; lists: ListsShown }

/** The lists this index reads by, as `/` and `/about` give them: each key with its confidence, and `self` as this index's address. */
export function listsOf(lists: Lists, self: string): ListsShown {
  return {
    hosts: lists.hosts,
    keys: lists.keys.map((k) => ({ key: k.key, verifier: k.verifier, label: k.label, confidence: k.confidence, ...(k.until !== undefined && { until: new Date(k.until).toISOString() }) })),
    indexes: lists.indexes.map((i) => ({ index: i.index === 'self' ? self : i.index, name: i.name })),
    maxAgeDays: lists.maxAgeDays,
  }
}

const linkRow = (href: string, name: string, what: string) => html`<a class="row" href="${href}"><span class="two"><strong>${name}</strong><span>${what}</span></span>${NEXT_ICON}</a>`

export const about: Page<About> = {
  data: ({ lists, self }) => ({ index: self, lists: listsOf(lists, self) }),
  title: () => 'Forest index: about',
  body(o, base) {
    return html`<div class="lead"><h1>About this index</h1>
<p>The Forest Foundation runs this index. It reads the hosts it lists, counts verified profiles only, and ranks them by reputation in each market: pages for people, JSON for programs, free.</p>
<p>Anyone can run another index; the main way is this code with lists of its own.</p></div>
<section><h2>What this index reads</h2>
<p>Hosts, each read in full: ${o.lists.hosts.join(', ') || 'none'}.</p>
<p>Verifier keys it counts: ${o.lists.keys.length ? o.lists.keys.map((k) => html`<br><code>${k.key}</code>, the ${k.label} of ${k.verifier}, confidence ${k.confidence}${k.until ? `, until ${k.until}` : ''}`) : 'none yet, so no profile counts here yet.'}</p>
<p>Reputation proofs it shows: ${o.lists.indexes.map((i) => html`${i.name} (<code>${i.index}</code>)`)}, against an index's newest root or one it signed in the last ${o.lists.maxAgeDays} days.</p></section>
<section><h2>What the numbers mean</h2>
${KEY}</section>
<section><h2>Its address</h2>
<p><code>${o.index}</code>: the address of this index's key, which signs what each profile shows and each root of its tree of trusts.</p></section>
<section><h2>For programs and AI agents</h2>
<div class="rows">${linkRow(`${base}/index.json`, 'JSON', "Every page at its address with .json; the home page's is /index.json")}${linkRow(`${base}/skill.md`, 'skill.md', 'Every field and filter, for AI agents')}${linkRow(`${base}/llms.txt`, 'llms.txt', 'This index in a few lines, with its links')}${linkRow(SOURCE, 'Source', 'How it works, open for anyone to run')}</div></section>`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'AboutPage', '@id': url, url, name: 'About this index', mainEntity: { '@type': 'WebSite', url: urls(base).home, name: 'Forest index', identifier: o.index } }],
    }
  },
}
