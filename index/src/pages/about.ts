// `/about`, twin `/about.json`: this index's address and the lists it reads by. Drawn as what this
// index is, in three short paragraphs; links to its JSON, its file for AI agents and its source;
// then, quietly, what it reads and its address, the key that signs what each profile shows.

import type { Lists } from '../lists.ts'
import { icon } from './icons.ts'
import { backHtml, html, type Page, SOURCE, urls } from './template.ts'

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

/** A link, in the About page's list: its icon, its words and a chevron. */
const linkHtml = (href: string, name: string, words: string) => html`<a class="li" href="${href}"><span class="ico">${icon(name)}</span><span class="grow"><b>${words}</b></span>${icon('caret-right')}</a>`

export const about: Page<About> = {
  name: 'about',
  data: ({ lists, self }) => ({ index: self, lists: listsOf(lists, self) }),
  title: () => 'Forest index: about',
  body(o, base) {
    return html`<div class="bar">${backHtml(urls(base).home, true)}</div>
<h1>About this index</h1>
<div class="prose"><p>It reads every listing, review, vouch and report on the hosts it lists, and ranks them with open rules. It runs no ads, and nobody can pay to be higher.</p>
<p>A profile counts once it's verified as one real person. Reviews count more from people this index trusts more, and it hides nothing: what it doesn't count, it shows with why.</p>
<p>Anyone can run another index with its own lists and rules, starting from this code.</p></div>
<div class="card divide">${linkHtml(`${base}/index.json`, 'file-code', 'Everything as JSON')}${linkHtml(`${base}/skill.md`, 'sparkle', 'For AI: skill.md')}${linkHtml(SOURCE, 'github-logo', 'Source code')}</div>
<h2>What it reads</h2>
<div class="card divide"><div class="fact"><span class="s">Hosts, each read in full</span>${o.lists.hosts.length ? o.lists.hosts.map((h) => html`<code>${h}</code>`) : html`<span>None</span>`}</div>
<div class="fact"><span class="s">Verifier keys it counts</span>${o.lists.keys.length ? o.lists.keys.map((k) => html`<span>The ${k.label} of ${k.verifier}, confidence ${k.confidence}${k.until ? `, until ${k.until}` : ''}: <code>${k.key}</code></span>`) : html`<span>None yet, so no profile counts here yet.</span>`}</div>
<div class="fact"><span class="s">Reputation proofs it shows</span>${o.lists.indexes.map((i) => html`<span>${i.name}: <code>${i.index}</code></span>`)}<span class="xs">Against an index's newest root, or one it signed in the last ${o.lists.maxAgeDays} days.</span></div>
<div class="fact"><span class="s">Its address</span><code>${o.index}</code><span class="xs">The address of this index's key, which signs what each profile shows and each root of its tree of trusts.</span></div></div>`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'AboutPage', '@id': url, url, name: 'About this index', mainEntity: { '@type': 'WebSite', url: urls(base).home, name: 'Forest index', identifier: o.index } }],
    }
  },
}
