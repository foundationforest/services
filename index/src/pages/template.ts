// The one template every page is drawn with. A page is its JSON object: each page module builds the
// object (`data`), and the HTML is drawn from that object alone (`body`, `ld`), never from queries of
// its own, so the page and its `.json` twin never disagree.
//
// Everything interpolated is escaped unless it is already built HTML (`Raw`). No page runs any
// JavaScript; the only script element is the JSON-LD block, which browsers never execute.

import type { Lists } from '../lists.ts'
import type { Markets } from '../markets.ts'
import type { Store } from '../store.ts'

export class Raw {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  if (v instanceof Raw) return v.value
  if (Array.isArray(v)) return v.map(render).join('')
  return esc(String(v))
}

/** `html\`<p>${text}</p>\`` escapes `text`; nest `html` results, or arrays of them, freely. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]
  return new Raw(out)
}

/** What a page reads the store with. */
export type Context = { store: Store; lists: Lists; markets: Markets; self: string }

export type Page<T> = {
  /** The page's JSON object, or null when there is no such page. */
  data(ctx: Context, path: string[], query: URLSearchParams): T | null
  title(o: T): string
  body(o: T, base: string): Raw
  /** schema.org JSON-LD. */
  ld(o: T, base: string, url: string): unknown
  /** Left out of search engines and the sitemap. */
  noindex?: boolean
}

/** The URLs of every page, from one place. */
export const urls = (base: string) => ({
  home: `${base}/`,
  market: (name: string) => `${base}/markets/${encodeURIComponent(name)}`,
  profile: (address: string) => `${base}/profiles/${encodeURIComponent(address)}`,
  deal: (escrow: string) => `${base}/deals/${encodeURIComponent(escrow)}`,
  search: (q: Record<string, string>) => `${base}/search${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`,
})

/** A page's twin: the same URL with `.json` on its path, the query kept. The home page's is /index.json. */
export function twinOf(pageUrl: string): string {
  const u = new URL(pageUrl)
  u.pathname = u.pathname === '/' ? '/index.json' : `${u.pathname}.json`
  return u.toString()
}

export const SOURCE = 'https://github.com/foundationforest/services/tree/main/index'

/** A short name for a profile on a page: its market, role and the start of its address. */
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** The whole page, drawn from its object. */
export function draw<T>(page: Page<T>, o: T, base: string, url: string, index: string): string {
  const ld = JSON.stringify(page.ld(o, base, url)).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title(o))}</title>
${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="alternate" type="application/json" href="${esc(twinOf(url))}">
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:0 1rem;color:#1b1b1b;background:#fff}
a{color:#205d3b}header,footer{padding:1rem 0;color:#555}header a{margin-right:1rem}
section{border-top:1px solid #ddd;padding:.5rem 0}.muted{color:#666}.no{color:#8a2a2a}
.badge{display:inline-block;border:1px solid #9bc4a9;border-radius:.75rem;padding:0 .5rem;font-size:.85em}
form input{font:inherit;padding:.25rem}code{font-size:.9em;word-break:break-all}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#151515}a{color:#8fd1a8}.muted,header,footer{color:#aaa}.no{color:#e59a9a}section{border-color:#333}.badge{border-color:#4f7a5f}}
</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<header><a href="${esc(urls(base).home)}">Forest index</a><a href="${esc(urls(base).search({}))}">Search</a><a href="${esc(twinOf(url))}">JSON</a></header>
<main>
${page.body(o, base).value}
</main>
<footer>This index's address: <code>${esc(index)}</code>. Every page here has a JSON twin at the same address with .json. <a href="${SOURCE}">How it works</a>.</footer>
</body>
</html>
`
}
