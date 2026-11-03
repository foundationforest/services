// The one template every page is drawn with. A page is its JSON object: each page module builds the
// object (`data`), and the HTML is drawn from that object alone (`body`, `ld`), never from queries of
// its own, so the page and its `.json` twin never disagree.
//
// Everything interpolated is escaped unless it is already built HTML (`Raw`). No page runs any
// JavaScript; the only script element is the JSON-LD block, which browsers never execute.
//
// The look is the Forest app's (foundationforest/app, src/theme.css and src/ui.tsx), its values
// copied here, never imported: its colors, light and dark; Manrope, from the same package the app
// uses, served by this index at /fonts/ (web.ts), so a page asks no other site for it; one column at
// most 32rem wide, phone first; rows for links, never an underline.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  about: `${base}/about`,
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

/** The Manrope package the Forest app uses: its `@font-face` rules, and the folder of the files they name. */
const MANROPE = dirname(fileURLToPath(import.meta.resolve('@fontsource-variable/manrope')))
export const FONT_FILES = join(MANROPE, 'files')
/** The package's own rules, each file at /fonts/ here, where web.ts serves the package's files unchanged. */
const FONT = readFileSync(join(MANROPE, 'index.css'), 'utf8')
  .replace(/\/\*[^*]*\*\//g, '')
  .replace(/\s*\n\s*/g, '')
  .replaceAll('url(./files/', 'url(/fonts/')

/**
 * The Forest mark, the three chevrons and trunk the app's Mark draws (app src/mark.tsx), the same
 * strokes as the mcp's icon (mcp/src/icon.ts), copied here since this package and its image hold
 * only index/: stroke 4, in a 40-unit square, in the ink, so it follows light and dark.
 */
const MARK = `<svg class="mark" width="28" height="28" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true"><polyline points="8,12 20,3 32,12"/><polyline points="8,22 20,13 32,22"/><polyline points="8,32 20,23 32,32"/><line x1="20" y1="24" x2="20" y2="38"/></svg>`

/** An icon as the app draws one (app src/ui.tsx, Icon): a 24-unit box, stroke 2, round ends. */
const icon = (inner: string) =>
  new Raw(`<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`)
export const SEARCH_ICON = icon('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>')
/** The app's BackIcon. */
export const BACK_ICON = icon('<polyline points="15,5 8,12 15,19"/>')
export const NEXT_ICON = icon('<polyline points="9,5 16,12 9,19"/>')

/** A back link, at the top of a page: its chevron and where it goes. */
export const backHtml = (href: string, words: string) => html`<a class="back" href="${href}">${BACK_ICON}${words}</a>`

/** A fold: its title, with a chevron that turns when it is open, and what it holds. */
export const foldHtml = (title: string, inner: Raw) => html`<details><summary>${title}${NEXT_ICON}</summary><div class="fold">${inner}</div></details>`

/**
 * The app's colors (src/theme.css), light and dark by the device's setting: this index has no
 * switch of its own, so it needs none of the app's data-theme rules. The accent is the fill of the
 * one main button on a page; the sand chip carries a score.
 */
const STYLE = `${FONT}
:root{--paper:#edeae0;--paper-2:#c0cabf;--ink-2:#313c34;--ink:#121a15;--accent:#1e5e43;--on-accent:#edeae0;--danger:#b3261e;--chip:#efe3cc;--on-chip:#6e4106;--radius:10px;--touch:48px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#121a15;--paper-2:#313c34;--ink-2:#c0cabf;--ink:#edeae0;--danger:#f28b82;--chip:#3b2c12;--on-chip:#f0d49a;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font-family:'Manrope Variable',system-ui,sans-serif;font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
h1,h2,h3,p,dl,ul{margin:0}h1{font-size:28px;font-weight:700;line-height:1.2;overflow-wrap:anywhere}h2,h3{font-size:14px;font-weight:700}
p,li{color:var(--ink-2);overflow-wrap:anywhere}ul{padding-left:20px}strong{font-weight:700}a{color:inherit;text-decoration:none}p a,li a{color:var(--ink);font-weight:700}
code{font:inherit;color:var(--ink);overflow-wrap:anywhere}img{max-width:100%}.icon{flex:none}
header,main,footer{max-width:32rem;margin:0 auto;padding-left:16px;padding-right:16px}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px}header a{display:inline-flex;align-items:center;gap:8px;min-height:var(--touch)}
header .home{font-weight:700}.mark{color:var(--ink);flex:none}
main{display:flex;flex-direction:column;gap:16px;padding-top:8px;padding-bottom:32px}section,.lead,.fold{display:grid;gap:8px}
footer{padding-bottom:16px}footer p{border-top:1px solid var(--paper-2);padding-top:4px;font-size:14px}footer a{display:inline-flex;align-items:center;min-height:var(--touch);color:var(--ink);font-weight:700}
.back{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;min-height:var(--touch);margin-left:-4px;color:var(--ink-2)}
.rows{display:grid;gap:8px}.row{display:flex;align-items:center;gap:12px;min-height:var(--touch);padding:10px 14px;border:1px solid var(--paper-2);border-radius:var(--radius);color:var(--ink)}
.post-row,.said-row{min-height:64px}.row>.icon{color:var(--ink-2)}.grow{flex:1;min-width:0;overflow-wrap:anywhere}
.two{display:grid;gap:2px;flex:1;min-width:0}.two>strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.two>span{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.two>.said-text{color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}.two>.why{white-space:normal}
.aside{display:inline-flex;align-items:center;gap:8px;flex:none;color:var(--ink-2)}.thumb{width:48px;height:48px;border-radius:8px;object-fit:cover;flex:none;background:var(--paper-2)}
.chip{flex:none;min-width:56px;padding:3px 10px;border-radius:999px;background:var(--chip);color:var(--on-chip);font-size:14px;font-weight:700;text-align:center;white-space:nowrap}.new{color:var(--ink-2)}
.shield{color:var(--ink)}.shield.id path{fill:currentColor}.shield.id polyline{stroke:var(--paper)}
.named .role{color:var(--ink-2);font-weight:400}.titled{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.titled .shield{width:24px;height:24px}
.line{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.red{color:var(--danger)}
.search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.box{grid-column:1/-1;display:flex;align-items:center;gap:8px;min-height:var(--touch);padding:0 12px;border:1px solid var(--paper-2);border-radius:var(--radius);color:var(--ink-2)}
.box input{flex:1;min-width:0;padding:10px 0;border:0;outline:0;background:none;font:inherit;color:var(--ink)}.box:focus-within{outline:2px solid var(--accent);outline-offset:1px}
select{width:100%;min-width:0;min-height:var(--touch);padding:10px 12px;border:1px solid var(--paper-2);border-radius:var(--radius);background:var(--paper);font:inherit;color:var(--ink)}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--touch);padding:0 16px;border:1px solid var(--paper-2);border-radius:var(--radius);background:var(--paper);font:inherit;color:var(--ink);text-align:center;overflow-wrap:anywhere;cursor:pointer}
.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent);font-weight:700}.buttons{display:grid;gap:8px}
select:focus,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.facts{display:grid;border-top:1px solid var(--paper-2)}.facts>div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--paper-2)}
.facts dt{color:var(--ink-2)}.facts dd{margin:0;min-width:0;text-align:right;font-weight:700;overflow-wrap:anywhere;white-space:pre-line}
.photo img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);background:var(--paper-2)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.tiles img{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:var(--paper-2)}
.price{color:var(--ink);font-weight:700}.text{color:var(--ink);white-space:pre-line}
details{border:1px solid var(--paper-2);border-radius:var(--radius);padding:0 16px}details[open]{padding-bottom:16px}
summary{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:var(--touch);font-weight:700;list-style:none;cursor:pointer}summary::-webkit-details-marker{display:none}
summary .icon{color:var(--ink-2)}details[open] summary .icon{transform:rotate(90deg)}.fold h2{margin-top:8px}`

/** The whole page, drawn from its object. */
export function draw<T>(page: Page<T>, o: T, base: string, url: string): string {
  const ld = JSON.stringify(page.ld(o, base, url)).replaceAll('<', '\\u003c')
  const description = page.description?.(o)
  const u = urls(base)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#edeae0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121a15" media="(prefers-color-scheme: dark)">
<title>${esc(page.title(o))}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="alternate" type="application/json" href="${esc(twinOf(url))}">
<style>
${STYLE}
</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<header><a class="home" href="${esc(u.home)}">${MARK}Forest index</a><a href="${esc(u.about)}">About</a></header>
<main>
${page.body(o, base).value}
</main>
<footer><p>Run by the Forest Foundation · <a href="${esc(u.about)}">About</a> · <a href="${esc(twinOf(url))}">JSON</a></p></footer>
</body>
</html>
`
}
