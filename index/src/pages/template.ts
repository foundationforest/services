// The one template every page is drawn with. A page is its JSON object: each page module builds the
// object (`data`), and the HTML is drawn from that object (`body`, `ld`) and the site's two fixed
// parts, never from queries of its own, so the page and its `.json` twin never disagree. The fixed
// parts are the markets at MARKETS, for each market's color, icon and fields, and lists/apps.json, for
// the app a page opens: both are read once, at start, and the same for every page.
//
// Everything interpolated is escaped unless it is already built HTML (`Raw`, html.ts). No page runs
// any JavaScript; the only script element is the JSON-LD block, which browsers never execute.
//
// The look is the Forest app's (foundationforest/app, src/theme.css), its values copied here, never
// imported: its colors, light and dark by the device's setting, since a page with no script has no
// switch; its shapes, chips and badges; Figtree for words and Bricolage Grotesque for titles, prices
// and scores, from the packages the app uses, served by this index at /fonts/ (web.ts); Phosphor's
// icons, drawn into the page (icons.ts); each market's color and icon by the rule the app shares
// (../avatar.ts). Phone first, one column; from 900px, a top bar and the laptop's columns.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Markets } from '@foundationforest/markets'

import { colorsFor } from '../avatar.ts'
import type { ListedApp, Lists } from '../lists.ts'
import type { Store } from '../store.ts'
import { esc, html, Raw } from './html.ts'
import { icon } from './icons.ts'

export { esc, html, Raw } from './html.ts'

/** What a page reads the store with, and `base`, where the pages are published, for the links its JSON gives. */
export type Context = { store: Store; lists: Lists; markets: Markets; self: string; base: string }

/** The site's fixed parts every page is drawn with: the markets, each market's color, and the apps. */
export type Site = { markets: Markets; colors: Record<string, string>; apps: ListedApp[] }

/** The site's fixed parts, each market's color by the directory's order. */
export const siteOf = (markets: Markets, apps: ListedApp[]): Site => ({ markets, colors: colorsFor(markets.directory.markets.map((m) => m.name)), apps })

export type Page<T> = {
  /** The page's name, which the stylesheet lays it out by. */
  name: 'home' | 'about' | 'market' | 'search' | 'profile' | 'listing'
  /** The page's JSON object, or null when there is no such page. */
  data(ctx: Context, path: string[], query: URLSearchParams): T | null
  title(o: T): string
  body(o: T, base: string, site: Site): Raw
  /** The page's meta description, when it has one. */
  description?(o: T): string | null
  /** What was searched, for the top bar's search box to hold. */
  searched?(o: T): { [filter: string]: string }
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
  /** A listing's page, by its address, `<profile>/listing/<id>`: the address is its path under /profiles. */
  listing: (address: string) => `${base}/profiles/${address.split('/').map(encodeURIComponent).join('/')}`,
  search: (q: Record<string, string>) => `${base}/search${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`,
})

/** A page's twin: the same URL with `.json` on its path, the query kept. The home page's is /index.json. */
export function twinOf(pageUrl: string): string {
  const u = new URL(pageUrl)
  u.pathname = u.pathname === '/' ? '/index.json' : `${u.pathname}.json`
  return u.toString()
}

export const SOURCE = 'https://github.com/foundationforest/services/tree/main/index'

/** A short name for a profile on a page: the start and the end of its address. */
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/**
 * The fonts the Forest app uses, from the same packages: Figtree's rules (its index.css), and
 * Bricolage Grotesque's with its optical sizes (its opsz.css), as the app's main.tsx loads them. Each
 * file is at /fonts/ here, where web.ts serves the packages' files unchanged.
 */
const PACKAGES = ['@fontsource-variable/figtree', '@fontsource-variable/bricolage-grotesque/opsz.css'].map((name) => fileURLToPath(import.meta.resolve(name)))
export const FONT_FILES = PACKAGES.map((css) => join(dirname(css), 'files'))
const FONT = PACKAGES.map((css) =>
  readFileSync(css, 'utf8')
    .replace(/\/\*[^*]*\*\//g, '')
    .replace(/\s*\n\s*/g, '')
    .replaceAll('url(./files/', 'url(/fonts/'),
).join('')

/**
 * The Forest mark, the three chevrons and trunk the app's Mark draws (app src/mark.tsx), the same
 * strokes as the MCP server's icon (mcp/src/icon.ts), copied here since this package and its image
 * hold only index/: stroke 4, in a 40-unit square, in the ink, so it follows light and dark.
 */
const MARK = `<svg class="mark" width="24" height="24" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true"><polyline points="8,12 20,3 32,12"/><polyline points="8,22 20,13 32,22"/><polyline points="8,32 20,23 32,32"/><line x1="20" y1="24" x2="20" y2="38"/></svg>`

/** The app a page opens: the first lists/apps.json names, at its message link's own origin. */
export const appOf = (site: Site) => (site.apps[0] ? `${new URL(site.apps[0].message.replaceAll('{address}', 'x')).origin}/` : null)

/**
 * A search box: a form that asks search for words, with the search icon, `keep` the other filters it
 * carries along; and the page's Search button, on a laptop, when `button`.
 */
export function searchBox(base: string, o: { placeholder: string; q?: string; keep?: { [filter: string]: string }; button?: boolean }): Raw {
  return html`<form class="ask" action="${urls(base).search({})}" method="get" role="search"><label class="inp find">${icon('magnifying-glass')}<input type="search" name="q"${o.q ? html` value="${o.q}"` : ''} placeholder="${o.placeholder}" aria-label="${o.placeholder}"></label>${Object.entries(o.keep ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}${o.button ? html`<button class="btn primary fit" type="submit">Search</button>` : ''}</form>`
}

/** The way back, on a phone, to `href`: a round button; a laptop has the top bar instead. */
export const backHtml = (href: string, clear = false) => html`<a class="${clear ? 'round clear back' : 'round back'}" href="${href}" aria-label="Back">${icon('arrow-left')}</a>`

/**
 * The app's colors (src/theme.css), light and dark by the device's setting: this index has no
 * switch of its own, so it needs none of the app's data-theme rules. One forest-green button per
 * page, for its main action. A market's color is `--h`, set where it is drawn.
 */
const STYLE = `${FONT}
:root{--bg:#f2f0e8;--card:#fdfcf8;--sunk:#e8e5d9;--ink:#111a15;--ink2:#46524a;--ink3:#626d66;--line:#e1ded1;--line2:#cbc7b8;--edge:#8a8a7f;--forest:#1e5e43;--on-forest:#f7f5ee;--mint:#dcedde;--on-mint:#174a35;--sun:#e8a317;--danger:#b73f2c;--seg-on:var(--card);--shadow:0 1px 2px rgb(17 26 21/.05),0 10px 28px -14px rgb(17 26 21/.18);--tile-tint:13%;--look-tint:16%;--look-icon:85%;--look-to:var(--ink);--text:'Figtree Variable',system-ui,sans-serif;--display:'Bricolage Grotesque Variable','Figtree Variable',system-ui,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1511;--card:#18211b;--sunk:#0a100d;--ink:#eef0ea;--ink2:#b9c3bb;--ink3:#8f9a92;--line:#243029;--line2:#36443b;--edge:#626d65;--forest:#7fd1a3;--on-forest:#0e1511;--mint:#1f3529;--on-mint:#a8dfc0;--sun:#f0b93b;--danger:#f08a78;--seg-on:var(--line2);--shadow:0 1px 2px rgb(0 0 0/.3),0 10px 28px -14px rgb(0 0 0/.6);--tile-tint:18%;--look-tint:24%;--look-icon:45%;--look-to:#fff;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.45 var(--text);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{min-height:100dvh;display:flex;flex-direction:column}
h1,h2,h3,p,dl,dd,ul{margin:0}ul{padding-left:20px}li{color:var(--ink2)}a{color:inherit;text-decoration:none}button,input,select{font:inherit;color:inherit}img{display:block;max-width:100%}
p{color:var(--ink2);overflow-wrap:anywhere}code{font:inherit;font-size:14px;color:var(--ink);overflow-wrap:anywhere}b,strong{font-weight:700}
h1,.d{font-family:var(--display);font-weight:700;letter-spacing:-.02em}h1{font-size:30px;line-height:1.1;overflow-wrap:anywhere}
h2{font-size:14px;font-weight:700;color:var(--ink3);padding:0 6px}h3{font-size:15px;font-weight:700;color:var(--ink)}
.h2{font-size:22px;line-height:1.15}.s{font-size:14px;line-height:1.4;color:var(--ink3)}.xs{font-size:12.5px;line-height:1.35;color:var(--ink3)}.red{color:var(--danger)}
.grow{flex:1 1 auto;min-width:0}.i{display:block;flex:none;width:22px;height:22px}.i.xs{width:14px;height:14px}.mark{display:block;flex:none}
a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--forest);outline-offset:2px}
.ibar{display:flex;align-items:center;gap:8px;width:100%;max-width:32rem;margin:0 auto;min-height:56px;padding:0 14px 0 20px}
[data-page]:not([data-page=home]) .ibar,.ibar .ask,.ibar .btn.open{display:none}
.ibrand{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-family:var(--display);font-weight:700;font-size:20px;letter-spacing:-.02em}
main{width:100%;max-width:32rem;margin:0 auto;padding:0 20px 24px;flex:1 0 auto;display:flex;flex-direction:column;gap:16px}
.bar{display:flex;align-items:center;gap:8px;min-height:56px;margin:0 -6px}
.ifoot{width:100%;max-width:32rem;margin:0 auto;padding:16px 20px 26px;display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;font-size:13.5px;color:var(--ink3)}
.ifoot a{display:inline-flex;align-items:center;min-height:32px;color:var(--ink2);font-weight:600}
.btn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;min-height:54px;padding:0 22px;border:0;border-radius:16px;background:var(--card);color:var(--ink);font-size:17px;font-weight:700;line-height:1;white-space:nowrap;cursor:pointer}
.btn.primary{background:var(--forest);color:var(--on-forest)}.btn.soft{background:var(--mint);color:var(--on-mint)}.btn.plain{box-shadow:inset 0 0 0 1px var(--line2)}
.btn.text{min-height:44px;padding:0 6px;background:none;font-size:16px;font-weight:600;color:var(--ink2)}.btn.sm{min-height:38px;border-radius:12px;padding:0 14px;font-size:14.5px;gap:6px}.btn.fit,.btn.sm{display:inline-flex;width:auto}.btn .i{width:20px;height:20px}
.round{display:inline-grid;place-items:center;flex:none;width:42px;height:42px;border-radius:50%;background:var(--card);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}.round.clear{background:none;box-shadow:none}
.also{display:flex;flex-wrap:wrap;justify-content:center;gap:0 16px}.also a{display:inline-flex;align-items:center;min-height:40px;font-size:15px;font-weight:600;color:var(--ink2)}
.card{display:block;background:var(--card);border-radius:22px;box-shadow:var(--shadow)}.divide>*+*{border-top:1px solid var(--line)}.list{display:grid;gap:10px}
.av{display:inline-grid;place-items:center;flex:none;width:46px;height:46px;border-radius:15px;background:var(--h);color:#fff}
.av.look{background:color-mix(in srgb,var(--h) var(--look-tint),var(--card));color:color-mix(in srgb,var(--h) var(--look-icon),var(--look-to))}
.av .i{width:56%;height:56%}.av .letter{font-family:var(--display);font-weight:700;font-size:22px;line-height:1}
.av.xs{width:22px;height:22px;border-radius:7px}.av.xs .letter{font-size:11px}.av.lg{width:68px;height:68px;border-radius:22px}.av.lg .letter{font-size:32px}
.tint{background:color-mix(in srgb,var(--h) var(--tile-tint),var(--card))}.hue{color:color-mix(in srgb,var(--h) var(--look-icon),var(--look-to))}
.vb{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:7px;background:var(--mint);color:var(--on-mint)}.vb.id{background:var(--forest);color:var(--on-forest)}
.vb .i{width:14px;height:14px}.vb.lg{width:26px;height:26px;border-radius:9px}.vb.lg .i{width:18px;height:18px}
.chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:999px;font-size:13.5px;font-weight:600;line-height:1;white-space:nowrap;flex:none;color:var(--ink2);background:var(--sunk)}
.chip.sm{height:24px;font-size:12px}.chip .i{width:15px;height:15px}.chip.mint{background:var(--mint);color:var(--on-mint)}
.rate{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:var(--ink)}.rate .i{width:16px;height:16px;color:var(--sun)}
.nm{display:inline-flex;flex-wrap:wrap;align-items:center;gap:5px;font-weight:700;font-size:16.5px;line-height:1.25;color:var(--ink)}.nm .role{font-weight:500;color:var(--ink2)}
.inp{display:flex;align-items:center;gap:10px;width:100%;min-height:54px;padding:0 16px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 1px var(--edge);color:var(--ink)}
.inp:focus-within{outline:2px solid var(--forest);outline-offset:1px}.inp .i{color:var(--ink2)}
.inp input,.inp select{flex:1;min-width:0;border:0;outline:0;background:none;padding:0;font-size:16.5px}.inp input{-webkit-appearance:none;appearance:none}.inp input::placeholder{color:var(--ink3)}
.ask{display:flex;gap:10px;width:100%}.find{border-radius:999px;min-height:52px}.ask .btn{display:none}
.lab{font-size:14px;font-weight:700;color:var(--ink2)}
.title{font-size:17px;line-height:1.25;font-weight:700;overflow-wrap:anywhere}.what{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.price{display:flex;flex-direction:column;align-items:flex-end;flex:none;white-space:nowrap}.price .d{font-size:21px;line-height:1.1}
.thumb{width:64px;height:64px;border-radius:16px;object-fit:cover;flex:none;background:var(--sunk)}
.rcard{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border-radius:22px;background:var(--card);box-shadow:var(--shadow)}
.rcard .top,.lcard{display:flex;gap:12px;align-items:flex-start}.lcard{padding:14px 16px}
.who{display:flex;align-items:center;gap:8px;font-size:14px}.rcard .who{padding-top:10px;border-top:1px solid var(--line)}.rcard .nm,.said .nm{font-size:14px}.rcard .rate,.poster .rate{font-size:14px}
.said{display:flex;flex-direction:column;gap:10px;padding:14px 16px}.said .line{display:flex;align-items:center;gap:8px}.said .rate{font-size:17px}
.said .text{font-size:15.5px;line-height:1.4;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
details.fold{border-radius:22px;background:var(--card);box-shadow:var(--shadow)}
details.fold>summary{list-style:none;display:flex;align-items:center;gap:10px;min-height:52px;padding:0 16px;font-weight:700;cursor:pointer}details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary>.i:last-child{color:var(--ink3)}details.fold[open]>summary>.i:last-child{transform:rotate(180deg)}
.fbody{display:flex;flex-direction:column;gap:12px;padding:0 16px 16px}.fbody h3{margin-top:4px}
.num{display:flex;gap:12px;align-items:baseline}.num .d{font-size:22px;min-width:52px;flex:none}
.head{display:flex;flex-direction:column;gap:16px;margin:0 -20px;padding:8px 16px 20px;border-radius:0 0 30px 30px}
.head .me{display:flex;align-items:center;gap:14px}.head .me>div{display:flex;flex-direction:column;gap:6px;min-width:0}.head p{font-size:15.5px;line-height:1.45}
.titled{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.rated{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.hello{font-size:32px;line-height:1.08;margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tile{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;gap:12px;min-height:132px;padding:14px;border-radius:20px;font-weight:700;font-size:16.5px;line-height:1.2;color:var(--ink)}
.tile .i,.tile .letter{width:30px;height:30px}.tile .letter{font-family:var(--display);font-size:26px;line-height:30px}.tile .xs{display:block;margin-top:4px;color:var(--ink2);font-weight:600}
.ptabs{display:flex;gap:6px;padding:4px;border-radius:14px;background:var(--sunk)}
.ptabs a{flex:1;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 8px;border-radius:11px;font-size:15px;font-weight:600;color:var(--ink2);text-align:center}
.ptabs a[aria-current],.seg label:has(:checked){background:var(--seg-on);color:var(--ink);font-weight:700;box-shadow:0 1px 2px rgb(17 26 21/.12)}
.side{display:flex;flex-direction:column;gap:12px}
[data-page=market] main:not(:has(.side:target)) .side+.side{display:none}[data-page=market] main:has(.side:target) .side:not(:target){display:none}
.fchips{display:flex;gap:8px;overflow-x:auto;margin:0 -20px;padding:0 20px 2px;scrollbar-width:none}
.fchip{position:relative;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 13px;border-radius:999px;font-size:14.5px;font-weight:600;white-space:nowrap;flex:none;color:var(--ink);background:var(--card);box-shadow:inset 0 0 0 1px var(--line2);cursor:pointer}
.fchip.on,.fchip:has(:checked){background:var(--ink);color:var(--bg);box-shadow:none}.fchip .i{width:15px;height:15px}.fchip .av{margin-left:-6px}
.pick input{position:absolute;width:1px;height:1px;opacity:0}.pick:has(:focus-visible){outline:2px solid var(--forest);outline-offset:2px}
.filters{display:none;flex-direction:column;gap:20px;padding:16px;border-radius:22px;background:var(--card);box-shadow:var(--shadow)}.filters:target{display:flex}
.group{display:flex;flex-direction:column;gap:8px}.group .s a{color:var(--forest);font-weight:600}.chips{display:flex;flex-wrap:wrap;gap:8px}
.radio{display:flex;align-items:center;gap:10px;min-height:32px;font-size:15px}.radio .r{width:18px;height:18px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--edge);flex:none}.radio[aria-current]{font-weight:700}.radio[aria-current] .r{box-shadow:inset 0 0 0 5px var(--forest)}
.seg{display:flex;gap:4px;padding:4px;border-radius:14px;background:var(--sunk)}
.seg label{position:relative;flex:1;display:inline-flex;align-items:center;justify-content:center;min-height:40px;border-radius:11px;font-size:15px;font-weight:600;color:var(--ink2);cursor:pointer}
.found{display:flex;flex-direction:column;gap:12px}.count{display:flex;align-items:center;gap:8px}.count .s{flex:1}.count b{color:var(--ink)}
.split,.lists{display:flex;flex-direction:column;gap:16px}.lists{gap:10px}.lists>h2:not(:first-child){margin-top:10px}
.gal{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding:0 20px;margin:0 -20px;padding:0 20px;scrollbar-width:none}
.gal a{flex:none;width:82%;scroll-snap-align:start}.gal a:only-child{width:100%}.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:22px;background:color-mix(in srgb,var(--h) 16%,var(--card))}
.info{display:flex;flex-direction:column;gap:14px}.info .text{font-size:16px;line-height:1.5;white-space:pre-line}.cost{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;color:var(--ink)}.info .d.big{font-size:28px;line-height:1.1}
.kv{display:flex;justify-content:space-between;gap:16px;padding:12px 16px;font-size:15.5px}.kv dt{color:var(--ink3)}.kv dd{min-width:0;font-weight:600;text-align:right;overflow-wrap:anywhere;white-space:pre-line}
.kv a{color:var(--forest)}.kv a .i{display:inline-block;vertical-align:-2px;margin-left:4px}
.poster{display:flex;align-items:center;gap:12px;padding:14px 16px}.poster>.i{color:var(--ink3)}
.foot{position:sticky;bottom:0;display:flex;flex-direction:column;gap:4px;margin:0 -20px -24px;padding:12px 20px 16px;background:var(--bg);box-shadow:0 -1px 0 var(--line)}
.prose{display:flex;flex-direction:column;gap:16px}.prose p{font-size:16px;line-height:1.5}
.li{display:flex;align-items:center;gap:13px;min-height:64px;padding:14px 16px}.li .ico{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:13px;background:var(--sunk);color:var(--ink2)}.li>.i{color:var(--ink3)}
.fact{display:flex;flex-direction:column;gap:2px;padding:12px 16px;font-size:15px}
@media (min-width:900px){
.ibar,[data-page]:not([data-page=home]) .ibar{display:flex;max-width:none;min-height:64px;gap:12px;padding:0 28px;border-bottom:1px solid var(--line)}
.ibar .ask{display:flex;width:min(420px,36vw)}.ibar .find{min-height:42px}.ibar .btn.open{display:inline-flex}.back,.bar,.fchips{display:none}
main{max-width:1180px;padding:28px 48px 40px}.ifoot{max-width:none;padding:18px 28px 26px;border-top:1px solid var(--line)}
[data-page=home] main{max-width:1040px;padding-top:56px}.hello{font-size:44px;line-height:1.05;text-align:center}
[data-page=home] .ask{max-width:680px;align-self:center}.ask .btn{display:inline-flex}.find{min-height:56px}[data-page=home] h2{margin-top:32px}
.tiles{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.head{margin:0;padding:20px;border-radius:26px}[data-page=about] main{max-width:760px}
[data-page=market] .list,.found .list,.lists .list{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
[data-page=search] main{max-width:none;padding:0;flex-direction:row;align-items:stretch;gap:0}
.filters,.filters:target{display:flex;width:264px;flex:none;padding:24px 20px;border-radius:0;background:none;box-shadow:none;border-right:1px solid var(--line)}
.found{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px;padding:24px 32px}
[data-page=profile] main{display:grid;grid-template-columns:380px minmax(0,1fr);grid-template-areas:"head lists" "mean lists" "all lists" ". lists";grid-template-rows:auto auto auto 1fr;gap:12px 24px;align-items:start}
.profile-head{grid-area:head}.mean{grid-area:mean}.all{grid-area:all}.lists{grid-area:lists}
.split{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:36px;align-items:start}[data-page=listing] main{max-width:1180px}[data-page=listing] main:not(:has(.split)){max-width:720px}
.gal{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;padding:0;overflow:visible}.gal a,.gal a:only-child{width:auto}.gal a:first-child{grid-column:1/-1}.gal a+a img{aspect-ratio:1;border-radius:14px}
.info h1{font-size:34px;line-height:1.08}.info .d.big{font-size:30px}.foot{position:static;margin:0;padding:0;background:none;box-shadow:none}
}
@media (min-width:900px){details.wide::details-content{content-visibility:visible}details.wide>summary{cursor:default}details.wide>summary>.i:last-child{display:none}}`

/** The whole page, drawn from its object and the site's fixed parts. */
export function draw<T>(page: Page<T>, o: T, base: string, url: string, site: Site): string {
  const ld = JSON.stringify(page.ld(o, base, url)).replaceAll('<', '\\u003c')
  const description = page.description?.(o)
  const u = urls(base)
  const app = appOf(site)
  const { q, offset: _, ...keep } = page.searched?.(o) ?? {}
  const search = page.name === 'home' ? '' : searchBox(base, { placeholder: 'Search listings', q, keep }).value
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f2f0e8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1511" media="(prefers-color-scheme: dark)">
<title>${esc(page.title(o))}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="alternate" type="application/json" href="${esc(twinOf(url))}">
<style>
${STYLE}
</style>
<script type="application/ld+json">${ld}</script>
</head>
<body data-page="${page.name}">
<header class="ibar"><a class="ibrand" href="${esc(u.home)}">${MARK}Forest index</a>${search}<span class="grow"></span><a class="btn text fit" href="${esc(u.about)}">About</a>${app ? `<a class="btn soft sm open" href="${esc(app)}">Open the app</a>` : ''}</header>
<main>
${page.body(o, base, site).value}
</main>
<footer class="ifoot"><span>Ranked by ${esc(new URL(base).host)}</span><a href="${esc(u.about)}">How it ranks</a><a href="${esc(twinOf(url))}">JSON</a><a href="${SOURCE}">Source</a></footer>
</body>
</html>
`
}
