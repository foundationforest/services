// The one template every page is drawn with. A page is its JSON object: each page module builds the
// object (`data`), and the HTML is drawn from that object alone (`body`, `ld`), never from queries of
// its own, so the page and its `.json` twin never disagree.
//
// Everything interpolated is escaped unless it is already built HTML (`Raw`). No page runs any
// JavaScript; the only script element is the JSON-LD block, which browsers never execute.

import type { Markets } from '@foundationforest/markets'

import type { Lists } from '../lists.ts'
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

/** What a page reads the store with, and `base`, where the pages are published, for the links its JSON gives. */
export type Context = { store: Store; lists: Lists; markets: Markets; self: string; base: string }

export type Page<T> = {
  /** The page's JSON object, or null when there is no such page. */
  data(ctx: Context, path: string[], query: URLSearchParams): T | null
  title(o: T): string
  body(o: T, base: string): Raw
  /** The page's meta description, when it has one. */
  description?(o: T): string | null
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
  /** A post's page, by its address, `<profile>/post/<id>`: the address is its path under /profiles. */
  post: (address: string) => `${base}/profiles/${address.split('/').map(encodeURIComponent).join('/')}`,
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

/**
 * The Forest mark, the same three chevrons and trunk the mcp's icon draws (mcp/src/icon.ts), copied
 * here since this package and its image hold only index/: stroke 4, in a 56-unit square with 8 of
 * margin, drawn in the text's own colour so it follows light and dark.
 */
const MARK = `<svg class="mark" viewBox="0 0 56 56" aria-hidden="true"><g transform="translate(8 8)" fill="none" stroke="currentColor" stroke-width="4"><polyline points="8,12 20,3 32,12"/><polyline points="8,22 20,13 32,22"/><polyline points="8,32 20,23 32,32"/><line x1="20" y1="24" x2="20" y2="38"/></g></svg>`

/**
 * What a profile's words and numbers mean, on every page, for a reader who lands on one page and
 * reads nothing else. It says what README.md, How it scores, says, in plain words.
 */
const KEY = `<p class="key">Verified by face, or by face and ID: a verifier checked the real person behind the profile, which proves it without saying who. Rated 9.2 by 14: the average of 14 raters' scores from 1 to 10, weighted toward raters with more uniqueness and trust.</p>
<p class="key">Trust, 0 to 100: how much the profile's own scores and words weigh. A new profile starts at half its uniqueness; vouches and ratings raise it, reports lower it. Uniqueness, 0 to 100: how sure this index is that the profile is one real person.</p>
<p class="key">Each profile is one person in one market and role, and nothing here links one person's profiles.</p>`

const STYLE = `:root{--ink:#1b1b1b;--paper:#fff;--muted:#666;--line:#ddd;--link:#205d3b;--no:#8a2a2a;--card:#f6f6f2}
@media (prefers-color-scheme:dark){:root{--ink:#e6e6e6;--paper:#151515;--muted:#aaa;--line:#333;--link:#8fd1a8;--no:#e59a9a;--card:#1d1f1d}}
body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:0 1rem;color:var(--ink);background:var(--paper)}
a{color:var(--link)}header{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1rem;padding:1rem 0;color:var(--muted)}
header .home{display:inline-flex;align-items:center;gap:.4rem;font-weight:600;text-decoration:none;color:var(--ink)}.mark{width:1.75rem;height:1.75rem}
footer{padding:1rem 0;color:var(--muted);border-top:1px solid var(--line);margin-top:2rem}.key{font-size:.85em;margin:.25rem 0}
section{border-top:1px solid var(--line);padding:.5rem 0}.muted,.nums{color:var(--muted)}.nums{font-size:.85em}.no{color:var(--no)}
img{max-width:100%;height:auto}code{font-size:.9em;word-break:break-all}h1{font-size:1.6em;line-height:1.25;overflow-wrap:anywhere}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1rem;margin:1rem 0}
.card{border:1px solid var(--line);border-radius:.5rem;padding:.75rem;background:var(--card);overflow-wrap:anywhere}.card p{margin:.25rem 0}
.card img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:.25rem;margin-bottom:.5rem}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:.5rem}.photos img{width:100%;border-radius:.25rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere;white-space:pre-line}
@media (max-width:30rem){dl{grid-template-columns:1fr}dd{margin-bottom:.5rem}}
details{border-top:1px solid var(--line);margin-top:1.5rem;padding-top:.5rem}summary{cursor:pointer;font-weight:600}
form{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}form input,form select,form button{font:inherit;padding:.4rem .5rem;border:1px solid var(--line);border-radius:.25rem;color:var(--ink);background:var(--paper)}
form input[name=q]{flex:1 1 12rem}form button{cursor:pointer}`

/** The whole page, drawn from its object. */
export function draw<T>(page: Page<T>, o: T, base: string, url: string, index: string): string {
  const ld = JSON.stringify(page.ld(o, base, url)).replaceAll('<', '\\u003c')
  const description = page.description?.(o)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title(o))}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="alternate" type="application/json" href="${esc(twinOf(url))}">
<style>
${STYLE}
</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<header><a class="home" href="${esc(urls(base).home)}">${MARK}Forest index</a><a href="${esc(urls(base).search({}))}">Search</a><a href="${esc(twinOf(url))}">JSON</a></header>
<main>
${page.body(o, base).value}
</main>
<footer>
${KEY}
<p>This index's address: <code>${esc(index)}</code>. Every page here has a JSON twin at the same address with .json. <a href="${SOURCE}">How it works</a>.</p>
</footer>
</body>
</html>
`
}
