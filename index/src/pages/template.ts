// The one template every page is drawn with. A page is its JSON object: each page module builds the
// object (`data`), and the HTML is drawn from that object (`body`, `ld`) and the site's two fixed
// parts, never from queries of its own, so the page and its `.json` twin never disagree. The fixed
// parts are the markets at MARKETS, for each market's color, icon and fields, and lists/apps.json, for
// the app a page opens: both are read once, at start, and the same for every page. A page's object
// may hold what the places service said (places.ts), so `data` is asked once per request and both
// the page and its twin are drawn from what it gave.
//
// Everything interpolated is escaped unless it is already built HTML (`Raw`, html.ts). No page runs
// any JavaScript; the only script element is the JSON-LD block, which browsers never execute.
//
// The look is the Forest app's, its values copied here, never imported: its colors, light and dark
// by the device's setting, since a page with no script has no switch; Figtree for every word, from
// the package the app uses, served by this index at /fonts/ (web.ts), titles and prices at its
// heaviest, a little tight; Phosphor's icons, drawn into the page (icons.ts); each market's icon from
// its market file, and its color from its number (../avatar.ts); each profile's animal (../animals.ts).
// One rule for the greens: strong green does something (Search, Message, Show offers); soft green
// is what is picked (a side, a filter that is on, a place once set); black is for words and the check
// badges; every other action is outlined in black; nothing else is green. Phone first, one column;
// from 900px, the laptop's.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Markets } from '@foundationforest/markets'

import type { ListedApp, Lists } from '../lists.ts'
import type { Places } from '../places.ts'
import type { Store } from '../store.ts'
import { esc, html, Raw } from './html.ts'
import { icon } from './icons.ts'

export { esc, html, Raw } from './html.ts'

/** What a page reads the store with, the places service it asks for names, and `base`, where the pages are published, for the links its JSON gives. */
export type Context = { store: Store; lists: Lists; markets: Markets; self: string; base: string; places: Places }

/** The site's fixed parts every page is drawn with: the markets, each market's icon and number among them, and the apps. */
export type Site = { markets: Markets; apps: ListedApp[] }

export const siteOf = (markets: Markets, apps: ListedApp[]): Site => ({ markets, apps })

export type Page<T> = {
  /** The page's name, which the stylesheet lays it out by. */
  name: 'home' | 'about' | 'market' | 'search' | 'profile' | 'listing'
  /** The page's JSON object, or null when there is no such page. */
  data(ctx: Context, path: string[], query: URLSearchParams): Promise<T | null>
  /** The page's title, drawn, as its body is, from its object and the site's fixed parts. */
  title(o: T, site: Site): string
  body(o: T, base: string, site: Site): Raw
  /** The page's meta description, when it has one. */
  description?(o: T): string | null
  /** What the top bar's search pill holds and carries along: the words, and the place. */
  searched?(o: T): { [filter: string]: string }
  /** schema.org JSON-LD. */
  ld(o: T, base: string, url: string): unknown
  /** Left out of search engines and the sitemap. */
  noindex?: boolean
}

const query = (q: Record<string, string>) => (Object.keys(q).length ? `?${new URLSearchParams(q)}` : '')

/** The URLs of every page, from one place. */
export const urls = (base: string) => ({
  home: `${base}/`,
  about: `${base}/about`,
  skill: `${base}/skill.md`,
  market: (name: string, q: Record<string, string> = {}) => `${base}/markets/${encodeURIComponent(name)}${query(q)}`,
  profile: (address: string) => `${base}/profiles/${encodeURIComponent(address)}`,
  /** A listing's page, by its address, `<profile>/listing/<id>`: the address is its path under /profiles. */
  listing: (address: string) => `${base}/profiles/${address.split('/').map(encodeURIComponent).join('/')}`,
  search: (q: Record<string, string>) => `${base}/search${query(q)}`,
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
 * The font the Forest app uses, Figtree, from the same package: its rules (its index.css), as the
 * app loads them. Each file is at /fonts/ here, where web.ts serves the package's files unchanged.
 */
const FIGTREE = fileURLToPath(import.meta.resolve('@fontsource-variable/figtree'))
export const FONT_FILES = [join(dirname(FIGTREE), 'files')]
const FONT = readFileSync(FIGTREE, 'utf8')
  .replace(/\/\*[^*]*\*\//g, '')
  .replace(/\s*\n\s*/g, '')
  .replaceAll('url(./files/', 'url(/fonts/')

/**
 * The Forest mark, the three chevrons and trunk the app's Mark draws (app src/mark.tsx), the same
 * strokes as the MCP server's icon (mcp/src/icon.ts), copied here since this package and its image
 * hold only index/: stroke 4, in a 40-unit square, in the ink, so it follows light and dark.
 */
const MARK = `<svg class="mark" width="26" height="26" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true"><polyline points="8,12 20,3 32,12"/><polyline points="8,22 20,13 32,22"/><polyline points="8,32 20,23 32,32"/><line x1="20" y1="24" x2="20" y2="38"/></svg>`

/** The app a page opens: the first lists/apps.json names, at its message link's own origin. */
export const appOf = (site: Site) => (site.apps[0] ? `${new URL(site.apps[0].message.replaceAll('{address}', 'x')).origin}/` : null)

/**
 * A market's tile on the front page, as numbers the stylesheet and the contrast test share: its
 * least height, its padding, its name's size and weight, which make it large text, and the size and
 * line height of its counts, which sit at its foot; and the fade
 * laid behind its words, black from 0 at `fadeFrom` percent of its height to `fade` at `fadeFull`
 * percent and below, so the counts, whose line starts lower than `fadeFull` on any tile at least
 * `height` tall, sit on the full fade. In dark mode, black at `dark` over the whole tile as well.
 */
export const TILE = { height: 112, laptopHeight: 132, pad: 14, name: 19, nameWeight: 800, counts: 13, countsLine: 17, fadeFrom: 50, fadeFull: 70, fade: 0.25, dark: 0.18 } as const

/**
 * The fade's stops: black from 0 at `fadeFrom` to `fade` at `fadeFull`, eased (smoothstep), so no
 * band shows where it reaches its full strength; from `fadeFull` down, `fade`.
 */
const FADE = [0, 0.25, 0.5, 0.75, 1]
  .map((t) => `rgb(0 0 0/${+(TILE.fade * t * t * (3 - 2 * t)).toFixed(4)}) ${+(TILE.fadeFrom + (TILE.fadeFull - TILE.fadeFrom) * t).toFixed(2)}%`)
  .join(',')

/** The Search Forest pill: a GET form to search, holding the words, `keep` the other filters it carries along. */
export function pillHtml(base: string, o: { q?: string; keep?: { [filter: string]: string } }): Raw {
  return html`<form class="pill" action="${urls(base).search({})}" method="get" role="search"><label>${icon('magnifying-glass')}<input type="search" name="q"${o.q ? html` value="${o.q}"` : ''} placeholder="Search Forest" aria-label="Search Forest"></label>${Object.entries(o.keep ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}</form>`
}

/** The app's colors, light and dark by the device's setting: this index has no switch of its own. A market's color is `--h`, set where it is drawn. */
const STYLE = `${FONT}
:root{--bg:#f2f0e8;--surface:#fdfcf8;--sunk:#e8e5d9;--ink:#111a15;--ink2:#46524a;--ink3:#626d66;--line:#e1ded1;--line2:#cbc7b8;--green:#1e5e43;--on-green:#f7f5ee;--soft:#dcedde;--on-soft:#1e5e43;--sun:#e8a317;--danger:#b73f2c;--shadow:0 1px 2px rgb(17 26 21/.05),0 10px 28px -14px rgb(17 26 21/.18);--look-tint:16%;--look-icon:85%;--look-to:var(--ink);--tile-dark:0;--text:'Figtree Variable',system-ui,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1511;--surface:#18211b;--sunk:#0a100d;--ink:#eef0ea;--ink2:#b9c3bb;--ink3:#8f9a92;--line:#243029;--line2:#36443b;--green:#7fd1a3;--on-green:#0e1511;--soft:#1f3529;--on-soft:#7fd1a3;--sun:#f0b93b;--danger:#f08a78;--shadow:0 1px 2px rgb(0 0 0/.3),0 10px 28px -14px rgb(0 0 0/.6);--look-tint:24%;--look-icon:45%;--look-to:#fff;--tile-dark:${TILE.dark};color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.45 var(--text);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{min-height:100dvh;display:flex;flex-direction:column}
h1,h2,h3,p,dl,dd,ul,figure{margin:0}ul{padding-left:20px}li{color:var(--ink2)}a{color:inherit;text-decoration:none}button,input,select{font:inherit;color:inherit}img{display:block;max-width:100%}
p{color:var(--ink2);overflow-wrap:anywhere}code{font:inherit;font-size:14px;color:var(--ink);overflow-wrap:anywhere}b,strong{font-weight:700}
h1,.d{font-weight:900;letter-spacing:-.02em}h1{font-size:28px;line-height:1.1;overflow-wrap:anywhere}h2{font-size:18px;line-height:1.2;font-weight:800;letter-spacing:-.01em}h3{font-size:15px;font-weight:700}
.s{font-size:14px;line-height:1.4;color:var(--ink3)}.xs{font-size:12.5px;line-height:1.35;color:var(--ink3)}.red{color:var(--danger)}
.hide{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.grow{flex:1 1 auto;min-width:0}.i{display:block;flex:none;width:22px;height:22px}.i.xs{display:inline-block;vertical-align:-2px;width:14px;height:14px}.mark{display:block;flex:none}
a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
summary{list-style:none;cursor:pointer}summary::-webkit-details-marker{display:none}details[open]>summary>[data-icon=caret-down]{transform:rotate(180deg)}
.top{display:flex;align-items:center;gap:10px;width:100%;max-width:34rem;margin:0 auto;min-height:64px;padding:10px 16px}
.home{display:inline-grid;place-items:center;flex:none;width:40px;height:40px;margin-left:-6px}
.top .pill{flex:1 1 auto}.top .open{display:none}[data-page=home] .top .open{display:inline-flex}
.pill{display:flex;min-width:0}.pill label{display:flex;flex:1;align-items:center;gap:8px;min-width:0;height:44px;padding:0 16px;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line2)}
.pill input,.ask input,.inp input,.inp select{flex:1;min-width:0;border:0;outline:0;background:none;padding:0;font-size:16px}.pill input,.ask input,.inp input{-webkit-appearance:none;appearance:none}
.pill input::placeholder,.ask input::placeholder,.inp input::placeholder{color:var(--ink3)}.pill .i,.ask .i{color:var(--ink2)}
.pill label:focus-within,.ask:focus-within,.inp:focus-within{outline:2px solid var(--ink);outline-offset:1px}
main{width:100%;max-width:34rem;margin:0 auto;padding:4px 16px 32px;flex:1 0 auto;display:flex;flex-direction:column;gap:16px}
.foot{width:100%;max-width:34rem;margin:0 auto;padding:16px 16px 28px;display:flex;flex-wrap:wrap;gap:0 18px;border-top:1px solid var(--line)}
.foot a{display:inline-flex;align-items:center;min-height:36px;font-size:13.5px;font-weight:600;color:var(--ink3)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 22px;border:0;border-radius:999px;background:none;color:var(--ink);font-size:16px;font-weight:800;line-height:1;white-space:nowrap;cursor:pointer}
.btn.go{background:var(--green);color:var(--on-green)}.btn.out{box-shadow:inset 0 0 0 1.5px var(--ink)}.btn.sm{min-height:38px;padding:0 15px;font-size:14.5px}.btn.wide{display:flex;width:100%}.btn .i{width:19px;height:19px}
.link{display:inline-flex;align-items:center;min-height:40px;font-weight:700;color:var(--ink2);text-decoration:underline;text-underline-offset:3px}
.chip{position:relative;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:999px;font-size:14.5px;font-weight:700;line-height:1;white-space:nowrap;flex:none;color:var(--ink);background:none;box-shadow:inset 0 0 0 1px var(--ink);cursor:pointer}
.chip.on,.chip:has(:checked){background:var(--soft);color:var(--on-soft);box-shadow:none}.chip .n{color:var(--ink);font-weight:800}.chip .i{width:16px;height:16px}.chip .av{margin-left:-6px}
.pick input{position:absolute;width:1px;height:1px;opacity:0}.pick:has(:focus-visible){outline:2px solid var(--ink);outline-offset:2px}
.flag{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;background:var(--sunk);color:var(--ink2);font-size:12.5px;font-weight:700;line-height:1;letter-spacing:0;white-space:nowrap}
.round{display:inline-grid;place-items:center;flex:none;width:40px;height:40px;border-radius:50%;background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--ink)}.round .i{width:18px;height:18px}
.box{display:block;background:var(--surface);border-radius:22px;box-shadow:var(--shadow)}
.av{display:inline-grid;place-items:center;flex:none;width:44px;height:44px;border-radius:14px;background:var(--h);color:#fff}
.av.look{background:color-mix(in srgb,var(--h) var(--look-tint),var(--surface));color:color-mix(in srgb,var(--h) var(--look-icon),var(--look-to))}
.av .i{width:58%;height:58%}.av.animal .i{width:72%;height:72%}.av .letter{font-weight:900;font-size:20px;line-height:1}
.av.xs{width:22px;height:22px;border-radius:7px}.av.xs .letter{font-size:11px}.av.mk{width:28px;height:28px;border-radius:9px}.av.mk .letter{font-size:14px}
.av.md{width:48px;height:48px;border-radius:16px}.av.lg{width:88px;height:88px;border-radius:28px}.av.lg .letter{font-size:40px}
.vb{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:6px;background:var(--ink);color:var(--bg)}.vb .i{width:14px;height:14px}.vb.lg{width:26px;height:26px;border-radius:8px}.vb.lg .i{width:18px;height:18px}
.badges{display:inline-flex;gap:4px;vertical-align:middle}.rated{display:inline-flex;flex-wrap:wrap;align-items:center;gap:5px}
.rate{display:inline-flex;align-items:center;gap:3px;font-weight:700;color:var(--ink)}.rate .i{width:14px;height:14px;color:var(--sun)}
.ask{display:flex;align-items:center;gap:8px;width:100%;height:58px;padding:0 6px 0 18px;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line2),var(--shadow)}.ask label{display:flex;flex:1;align-items:center;gap:10px;min-width:0}.ask .btn{min-height:46px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tile{position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;min-height:${TILE.height}px;padding:${TILE.pad}px;border-radius:22px;color:#fff;background:linear-gradient(${FADE}),linear-gradient(rgb(0 0 0/var(--tile-dark)),rgb(0 0 0/var(--tile-dark))),var(--h)}
.tile .big{position:absolute;top:-14px;right:-18px;display:grid;place-items:center;width:104px;height:104px;opacity:.28}.tile .big .i{width:100%;height:100%}.tile .big .letter{font-size:96px;font-weight:900;line-height:1}
.tile .name{position:relative;font-size:${TILE.name}px;font-weight:${TILE.nameWeight};line-height:1.15;letter-spacing:-.01em;overflow-wrap:anywhere}.tile .n{position:relative;font-size:${TILE.counts}px;font-weight:600;line-height:${TILE.countsLine}px}
.chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin-right:-16px;padding:2px 16px 2px 2px}
.seek{display:flex;align-items:center;gap:8px}.seek>.chips{flex:1 1 auto;min-width:0}
.drop{position:relative;flex:none}.drop>summary{list-style:none}
.drop .panel{position:absolute;z-index:5;top:calc(100% + 8px);left:0;width:300px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:18px;background:var(--surface);box-shadow:var(--shadow),0 0 0 1px var(--line)}
.drop.end .panel{left:auto;right:0;width:200px}
.menu a{display:flex;align-items:center;min-height:40px;padding:0 8px;border-radius:10px;font-weight:600;color:var(--ink2)}.menu a[aria-current]{font-weight:800;color:var(--ink)}
.lab{font-size:14px;font-weight:800;color:var(--ink)}.opts{display:flex;flex-wrap:wrap;gap:8px}
.inp{display:flex;align-items:center;gap:10px;min-height:48px;padding:0 14px;border-radius:14px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line2);color:var(--ink)}
.range,.price{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.range .inp{flex:1 1 90px;min-width:0}.price .inp{flex:1 1 110px;min-width:0}.price .inp.unit{flex:0 1 auto}
.count{display:flex;align-items:center;gap:8px}.count p{flex:1;font-size:15px;color:var(--ink)}.count b{font-weight:800}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 12px}
.result{display:flex;flex-direction:column;gap:3px;min-width:0}.grid .pic{margin-bottom:4px}
.pic{position:relative;display:block;aspect-ratio:1;border-radius:18px;overflow:hidden;background:color-mix(in srgb,var(--h) 22%,var(--surface))}.pic img{width:100%;height:100%;object-fit:cover}
.pic .none{position:absolute;inset:0;display:grid;place-items:center;color:var(--h)}.pic .none .i{width:40%;height:40%}.pic .none .letter{font-size:56px;font-weight:900}.pic .av.mk{position:absolute;left:8px;bottom:8px}
.l1{display:flex;align-items:baseline;gap:8px;min-width:0}.l1 .t{flex:1 1 auto;min-width:2.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:15.5px}
.l1 .p{flex:0 0 auto;max-width:72%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:900;font-size:15.5px;letter-spacing:-.01em}
.grid .result>.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:15.5px}.grid .result>.p{font-weight:900;font-size:15.5px;line-height:1.25;letter-spacing:-.01em;overflow-wrap:anywhere}
.l2{display:flex;align-items:center;gap:4px;min-height:18px;font-size:13.5px;color:var(--ink3)}.l2:empty{display:none}
.list{display:flex;flex-direction:column}.list .result{gap:3px;padding:14px 16px}.list .result+.result{border-top:1px solid var(--line)}
.more{align-self:center}
.mhead{display:flex;gap:14px;align-items:flex-start}.mhead>div{display:flex;flex-direction:column;gap:4px;min-width:0}.mhead h1{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.sides{display:flex;gap:4px;padding:4px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--ink)}
.sides a{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 12px;border-radius:999px;font-weight:700;color:var(--ink2)}.sides a[aria-current]{background:var(--soft);color:var(--on-soft)}.sides .n{color:var(--ink);font-weight:800}
.controls{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"bar bar" "count order";gap:12px 8px;align-items:center}
.controls>.bar{grid-area:bar;display:flex;gap:8px}.controls>.count{grid-area:count}.controls>.order{grid-area:order}
.filters{grid-area:filters;display:flex;flex-wrap:wrap;gap:8px}.filters .fhead,.filters .ffoot,.controls>.filters{display:none}
@media (max-width:899.98px){
.controls>.filters:target{display:flex;flex-direction:column;flex-wrap:nowrap;gap:0;position:fixed;inset:0;z-index:20;overflow-y:auto;padding:0 16px 110px;background:var(--bg)}
.filters .fhead{display:flex;align-items:center;gap:12px;min-height:64px;position:sticky;top:0;z-index:1;background:var(--bg)}
.filters .drop{padding:14px 0;border-bottom:1px solid var(--line)}.filters .drop::details-content{content-visibility:visible}
.filters .drop>summary.chip{height:auto;padding:0;background:none;box-shadow:none;color:var(--ink);font-size:16px;font-weight:800;cursor:default}.filters .drop>summary>[data-icon=caret-down],.filters .drop>summary .on{display:none}
.filters .drop .panel{position:static;width:auto;max-width:none;padding:12px 0 0;background:none;box-shadow:none}.filters .panel .show{display:none}
.filters .ffoot{display:flex;align-items:center;gap:16px;position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bg);box-shadow:0 -1px 0 var(--line)}.filters .ffoot .btn{flex:1}
}
details.fold{border-radius:22px;background:var(--surface);box-shadow:var(--shadow)}
details.more>summary{display:inline-flex;align-items:center;gap:4px;min-height:32px;font-size:14px;font-weight:600;color:var(--ink2)}details.more>p{padding-top:2px}
details.fold>summary{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 16px;font-weight:700}details.fold>summary>.i:last-child{color:var(--ink3)}
.fbody{display:flex;flex-direction:column;gap:12px;padding:0 16px 16px}.fbody h3{margin-top:4px}
.num{display:flex;gap:12px;align-items:baseline}.num .d{font-size:22px;min-width:52px;flex:none}
.lpage{display:flex;flex-direction:column;gap:18px}.side{display:contents}.lpage .gal{order:1}.lpage .sum{order:2}.lpage .details{order:3}.lpage .about{order:4}.lpage .reviews{order:5}.lpage .listed{order:6}
.gal{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;margin:-4px -16px 0;scrollbar-width:none}
.ph{position:relative;flex:none;width:100%;scroll-snap-align:start;scroll-margin-top:80px}.ph img{width:100%;aspect-ratio:1;object-fit:cover;background:color-mix(in srgb,var(--h) 22%,var(--surface))}
.ph .at{position:absolute;right:12px;bottom:12px;padding:5px 10px;border-radius:999px;background:rgb(0 0 0/.6);color:#fff;font-size:13px;font-weight:700;line-height:1}.ph .round{display:none}
.sum{display:flex;flex-direction:column;gap:12px}.from{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.mk{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:700}
.prices{display:flex;flex-direction:column;gap:8px}.prices .d{font-size:24px;line-height:1.15;color:var(--ink)}.prices .note{font-size:14px;color:var(--ink3);white-space:pre-line}
.poster{display:flex;align-items:center;gap:12px;padding-top:14px;border-top:1px solid var(--line)}.poster .who{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.poster .who b{display:inline-flex;align-items:center;gap:6px}.poster>.i{color:var(--ink3)}
.details{padding:4px 0}.kv{display:flex;flex-direction:column;gap:2px;padding:10px 16px}.kv+.kv{border-top:1px solid var(--line)}
.kv dt{font-size:12.5px;font-weight:600;color:var(--ink3)}.kv dd{font-size:15.5px;font-weight:600;white-space:pre-line;overflow-wrap:anywhere}.kv a{text-decoration:underline;text-underline-offset:3px}
.about{display:flex;flex-direction:column;gap:8px}.about .text{font-size:16px;line-height:1.5;white-space:pre-line;color:var(--ink)}
.reviews{display:flex;flex-direction:column;gap:12px;padding:16px}.rv{display:flex;flex-direction:column;gap:4px}.rv+.rv{padding-top:12px;border-top:1px solid var(--line)}
.rv .line{display:flex;align-items:center;gap:8px}.rv .text{font-size:15px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}.rv .who{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--ink2)}
.listed{font-size:13px;color:var(--ink3)}.listed a{text-decoration:underline;text-underline-offset:3px}
.dock{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;align-items:center;gap:12px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--surface);box-shadow:0 -1px 0 var(--line)}
.dock .dp{display:flex;flex-direction:column;flex:1;min-width:0}.dock .dp .d{font-size:18px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-page=listing] main:has(.dock){padding-bottom:110px}
.phead{display:flex;flex-direction:column;gap:14px}.phead .me{display:flex;align-items:center;gap:16px}.phead .me>div{display:flex;flex-direction:column;gap:4px;min-width:0}
.phead h1{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:26px}.role{font-weight:600;color:var(--ink2)}
.lists{display:flex;flex-direction:column;gap:12px}.lists>h2:not(:first-child){margin-top:10px}
.prose{display:flex;flex-direction:column;gap:16px}.prose p{font-size:16px;line-height:1.5}
.li{display:flex;align-items:center;gap:13px;min-height:64px;padding:14px 16px}.li+.li{border-top:1px solid var(--line)}.li .ico{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:13px;background:var(--sunk);color:var(--ink2)}.li>.i{color:var(--ink3)}
.fact{display:flex;flex-direction:column;gap:2px;padding:12px 16px;font-size:15px}.fact+.fact{border-top:1px solid var(--line)}
@media (min-width:900px){
.top{max-width:none;padding:12px 28px;border-bottom:1px solid var(--line)}.top .pill{flex:0 1 460px}.top .open{display:inline-flex}
main{max-width:1180px;padding:28px 48px 48px;gap:20px}.foot{max-width:none;padding:18px 28px 28px}h1{font-size:34px}
[data-page=home] main{max-width:1040px;padding-top:56px;gap:32px}.ask{max-width:680px;align-self:center;height:62px}
.tiles{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.tile{min-height:${TILE.laptopHeight}px}.tile .big{width:124px;height:124px}.tile .big .letter{font-size:116px}
.grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:26px 18px}.list{max-width:820px}
.sides{align-self:flex-start;min-width:340px}
.controls{grid-template-areas:"filters order" "count count";align-items:start}.controls>.bar{display:none}.controls>.filters{display:flex}
[data-page=listing] main,[data-page=listing] main:has(.dock){padding-bottom:48px}
.lpage{display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-areas:"gal side" "details side" "about side" "listed side";gap:24px 40px;align-items:start}
.lpage:not(:has(.gal)){grid-template-areas:"details side" "about side" "listed side"}
.gal{grid-area:gal;margin:0;border-radius:22px;overflow:hidden}.ph img{aspect-ratio:auto;height:470px}
.ph .round{display:inline-grid;position:absolute;top:50%;margin-top:-20px}.ph .back{left:14px}.ph .next{right:14px}
.side{display:flex;flex-direction:column;gap:16px;grid-area:side;position:sticky;top:20px}
.sum{padding:20px;border-radius:22px;background:var(--surface);box-shadow:var(--shadow)}
.details{grid-area:details}.about{grid-area:about}.listed{grid-area:listed}
.dock{position:static;flex-direction:column;align-items:stretch;gap:8px;padding:0;background:none;box-shadow:none}.dock .dp{display:contents}.dock .dp .d{display:none}.dock .dp .xs{order:2;text-align:center}
[data-page=profile] main{display:grid;grid-template-columns:380px minmax(0,1fr);grid-template-areas:"head lists" "mean lists" "all lists" ". lists";grid-template-rows:auto auto auto 1fr;gap:16px 32px;align-items:start}
.phead{grid-area:head}.mean{grid-area:mean}.all{grid-area:all}.lists{grid-area:lists}[data-page=about] main{max-width:760px}
details.wide::details-content{content-visibility:visible}details.wide>summary{cursor:default}details.wide>summary>.i:last-child{display:none}
}`

/** The whole page, drawn from its object and the site's fixed parts. */
export function draw<T>(page: Page<T>, o: T, base: string, url: string, site: Site): string {
  const ld = JSON.stringify(page.ld(o, base, url)).replaceAll('<', '\\u003c')
  const description = page.description?.(o)
  const u = urls(base)
  const app = appOf(site)
  const { q, ...keep } = page.searched?.(o) ?? {}
  const pill = page.name === 'home' ? '' : pillHtml(base, { q, keep }).value
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f2f0e8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1511" media="(prefers-color-scheme: dark)">
<title>${esc(page.title(o, site))}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="alternate" type="application/json" href="${esc(twinOf(url))}">
<style>
${STYLE}
</style>
<script type="application/ld+json">${ld}</script>
</head>
<body data-page="${page.name}">
<header class="top"><a class="home" href="${esc(u.home)}" aria-label="Forest index, home">${MARK}</a>${pill}<span class="grow"></span>${app ? `<a class="btn out sm open" href="${esc(app)}">Open Forest</a>` : ''}</header>
<main>
${page.body(o, base, site).value}
</main>
<footer class="foot"><a href="${esc(u.about)}">About this index</a><a href="${esc(u.skill)}">For AI agents</a>${app ? `<a href="${esc(app)}">Open Forest</a>` : ''}</footer>
</body>
</html>
`
}
