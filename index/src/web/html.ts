// HTML for people: an escaping template tag, the page layout, and the URLs of every page.
//
// Everything interpolated is escaped unless it is `Raw` (already-built HTML). No page runs any
// JavaScript; the only script element is the JSON-LD data block, which browsers never execute.

export class Raw {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export const raw = (s: string): Raw => new Raw(s)

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  if (v instanceof Raw) return v.value
  if (Array.isArray(v)) return v.map(render).join('')
  return esc(String(v))
}

/** `html\`<p>${text}</p>\`` escapes `text`; nest `html` results, arrays of them, or `raw(...)` freely. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]
  return new Raw(out)
}

// -----------------------------------------------------------------------------------------------
// URLs. One place builds them, so the pages, their twins, the sitemap and the pay link agree.
// -----------------------------------------------------------------------------------------------

/** A path segment, encoded, keeping the colons of a DID readable (a colon is legal in a path). */
export function seg(s: string): string {
  return encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@')
}

export type Urls = ReturnType<typeof urlsFor>

/** Offers within `km` kilometres of a point, as `near=lat,lon&km=N` asks. */
export type Near = { lat: number; lon: number; km: number }

/** `near=lat,lon&km=N`, the comma kept readable, or nothing. */
const nearQuery = (near: Near | null | undefined): string[] => (near ? [`near=${near.lat},${near.lon}`, `km=${near.km}`] : [])
const query = (parts: string[]) => (parts.length ? `?${parts.join('&')}` : '')

export function urlsFor(base: string) {
  return {
    base,
    home: () => `${base}/`,
    folder: (f: string) => `${base}/folders/${seg(f)}`,
    market: (m: string, offset = 0, near: Near | null = null) =>
      `${base}/markets/${seg(m)}${query([...nearQuery(near), ...(offset ? [`offset=${offset}`] : [])])}`,
    profile: (did: string) => `${base}/profiles/${seg(did)}`,
    deal: (id: string) => `${base}/deals/${seg(id)}`,
    search: (q: string, near: Near | null = null) => `${base}/search${query([`q=${encodeURIComponent(q)}`, ...nearQuery(near)])}`,
    file: (name: string) => `${base}/${name}`,
    /** The twin of a page: the same URL with `.json` on its path, the query kept. The home page's is /index.json. */
    json: (pageUrl: string) => {
      const u = new URL(pageUrl)
      u.pathname = u.pathname === '/' || u.pathname === '' ? '/index.json' : `${u.pathname}.json`
      return u.toString()
    },
  }
}

export const SOURCE = 'https://github.com/foundationforest/forest'
export const SCORING_DOC = `${SOURCE}/blob/main/index/SCORING.md`
export const PAYLINK_DOC = `${SOURCE}/blob/main/index/PAYLINK.md`

// -----------------------------------------------------------------------------------------------
// The layout
// -----------------------------------------------------------------------------------------------

const STYLE = `
:root{--fg:#1b1f1d;--muted:#5b645f;--line:#d9dfdb;--bg:#fbfcfb;--card:#fff;--accent:#1f6b45;--warn:#8a4b0f}
@media (prefers-color-scheme:dark){:root{--fg:#e7ece9;--muted:#a3ada7;--line:#2f3833;--bg:#121614;--card:#1a201d;--accent:#7fd1a4;--warn:#e6a667}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main,header,footer{max-width:42rem;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding-top:12px;padding-bottom:12px;border-bottom:1px solid var(--line)}
header a.home{font-weight:700;color:var(--fg);text-decoration:none;font-size:1.15rem}
form.search{display:flex;gap:6px;flex:1;min-width:14rem}
form.search input{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit}
form.search button,a.pay{padding:6px 12px;border:0;border-radius:6px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;text-decoration:none;display:inline-block}
h1{font-size:1.6rem;line-height:1.25;margin:20px 0 4px}
h2{font-size:1.15rem;margin:28px 0 8px}
h3{font-size:1rem;margin:0 0 4px}
p{margin:6px 0}
a{color:var(--accent)}
.muted{color:var(--muted)}
.small{font-size:.875rem}
.warn{color:var(--warn)}
ul.cards{list-style:none;padding:0;margin:0}
ul.cards>li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 10px}
.row{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
.score{font-weight:700}
.id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;word-break:break-all;color:var(--muted)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0}
dt{color:var(--muted)}dd{margin:0}
footer{margin-top:40px;padding-top:12px;padding-bottom:32px;border-top:1px solid var(--line);font-size:.875rem;color:var(--muted)}
`

export type Head = {
  title: string
  description: string
  /** The page's own URL: the canonical link. */
  url: string
  /** The twin's URL; null for a page with no twin (a 404). */
  json: string | null
  jsonLd: unknown | null
  /** Search results, near views of a market, pay links and deals with no receipt: open to all, not for search engines to list. */
  noindex?: boolean
}

/** A data block browsers never run. `<` is escaped so no text in it can close the element. */
function jsonLdBlock(data: unknown): Raw {
  const text = JSON.stringify(data).replace(/</g, '\\u003c')
  return raw(`<script type="application/ld+json">${text}</script>`)
}

export function layout(urls: Urls, head: Head, body: Raw, q = ''): string {
  return (
    '<!doctype html>\n' +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${head.title}</title>
<meta name="description" content="${head.description}">
${head.noindex ? raw('<meta name="robots" content="noindex">') : ''}
<link rel="canonical" href="${head.url}">
${head.json ? html`<link rel="alternate" type="application/json" href="${head.json}">` : ''}
<style>${raw(STYLE)}</style>
${head.jsonLd ? jsonLdBlock(head.jsonLd) : ''}
</head>
<body>
<header>
<a class="home" href="${urls.home()}">Forest</a>
<form class="search" action="${urls.base}/search" method="get" role="search">
<input type="search" name="q" value="${q}" placeholder="Find a service or a person" aria-label="Search">
<button type="submit">Search</button>
</form>
</header>
<main>
${body}
</main>
<footer>
<p>Open to everyone, no sign-in. ${head.json ? html`<a href="${head.json}">This page as data (JSON)</a> · ` : ''}<a href="${SCORING_DOC}">How the scores work</a> · <a href="${urls.file('skill.md')}">For AI agents</a> · <a href="${SOURCE}">Source</a></p>
<p>Forest shows what people publish about themselves and each other. It never holds anyone's money.</p>
</footer>
</body>
</html>
`.value
  )
}
