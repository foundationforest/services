// Every URL the index answers, GET and HEAD only, open to any origin, with no login and no request
// log. Each page answers at its path as HTML, and at the same path with `.json` as the object it is
// drawn from (pages/template.ts). The rest is JSON or text only.

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { home } from './pages/home.ts'
import { market } from './pages/market.ts'
import { profile } from './pages/profile.ts'
import { search } from './pages/search.ts'
import { type Context, draw, esc, type Page, urls } from './pages/template.ts'
import { newestRoot, servedLeaves } from './tree.ts'

/** The address llms.txt and skill.md are written for; each copy serves them with its own PUBLIC_URL. */
export const WRITTEN_FOR = 'https://index.forest.foundation'

const PAGES: { [first: string]: Page<never> } = { markets: market, profiles: profile, search } as never
const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30, stale-while-revalidate=300' }
const TEXT = 'text/plain; charset=utf-8'

const answer = (status: number, type: string, body: string) => new Response(body, { status, headers: { ...HEADERS, 'content-type': type } })
const json = (value: unknown, status = 200) => answer(status, 'application/json; charset=utf-8', JSON.stringify(value))

export type Web = { handle(request: Request): Response }

/** The pages over `ctx`, published at `base`. `root` is this directory, which holds llms.txt and skill.md. */
export function web(ctx: Context, base: string, root: string): Web {
  const files = Object.fromEntries(['llms.txt', 'skill.md'].map((f) => [f, readFileSync(join(root, f), 'utf8').replaceAll(WRITTEN_FOR, base)]))

  function sitemap(): string {
    const u = urls(base)
    const list = [
      u.home,
      ...ctx.markets.list.map((m) => u.market(m.name)),
      ...(ctx.store.db.prepare('select address from profiles where counted = 1 order by address').all() as Array<{ address: string }>).map((p) => u.profile(p.address)),
    ]
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list.map((l) => `<url><loc>${esc(l)}</loc></url>\n`).join('')}</urlset>\n`
  }

  function route(url: URL): Response {
    const path = url.pathname
    if (path === '/robots.txt') return answer(200, TEXT, `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`)
    if (path === '/sitemap.xml') return answer(200, 'application/xml; charset=utf-8', sitemap())
    if (path === '/llms.txt') return answer(200, TEXT, files['llms.txt']!)
    if (path === '/skill.md') return answer(200, 'text/markdown; charset=utf-8', files['skill.md']!)
    if (path === '/v1/reputation' || path === '/v1/reputation/leaves') {
      const leaves = servedLeaves(ctx.store)
      const root = newestRoot(ctx.store)
      if (!root || !leaves.length) return json({ error: 'no tree yet' }, 404)
      if (path === '/v1/reputation') return json({ index: ctx.self, root: root.root, time: root.time, signature: root.signature, leaves: root.leaves })
      return json({ root: root.root, leaves })
    }

    const twin = path === '/index.json' || (path.endsWith('.json') && path !== '/.json')
    const bare = path === '/index.json' ? '/' : twin ? path.slice(0, -'.json'.length) : path
    const [first, ...rest] = bare.split('/').slice(1).map((s) => decodeURIComponent(s))
    const page = bare === '/' ? (home as Page<never>) : PAGES[first ?? '']
    const params = first === 'search' ? [] : rest
    if (!page || (first === 'search' && rest.length) || (bare !== '/' && first !== 'search' && params.length !== 1)) return answer(404, TEXT, 'Nothing here.\n')
    const o = page.data(ctx, params, url.searchParams)
    if (o === null) return twin ? json({ error: 'not found' }, 404) : answer(404, TEXT, 'Nothing here.\n')
    if (twin) return json(o)
    const pageUrl = `${base}${bare === '/' ? '/' : bare}${url.search}`
    return answer(200, 'text/html; charset=utf-8', draw(page, o, base, pageUrl, ctx.self))
  }

  return {
    handle(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET only\n', { status: 405, headers: { ...HEADERS, allow: 'GET, HEAD', 'content-type': TEXT } })
      let url: URL
      try {
        url = new URL(request.url)
        decodeURIComponent(url.pathname)
      } catch {
        return answer(400, TEXT, 'That address is not written correctly.\n')
      }
      const res = route(url)
      return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
    },
  }
}

/** One request's answer: 400 for a URL that does not parse, 500 for a page that fails, logged with its error only. */
function respond(pages: Web, path: string | undefined, method: string | undefined): Response {
  let url: URL
  try {
    url = new URL(`http://index.invalid${path ?? '/'}`)
  } catch {
    return new Response('That address is not written correctly.\n', { status: 400, headers: { 'content-type': TEXT } })
  }
  try {
    return pages.handle(new Request(url, { method: method === 'HEAD' || method === 'GET' ? method : 'POST' }))
  } catch (err) {
    console.error(`request failed: ${url.pathname}: ${(err as Error).message}`)
    return new Response('The index could not answer this.\n', { status: 500, headers: { 'content-type': TEXT } })
  }
}

/**
 * The pages on node:http. The URL the pages see is a fixed origin and the request's path: the Host
 * header is never read. Nothing about a request is logged, but a failed request's path and error.
 */
export function serve(pages: Web, port: number, hostname: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    const response = respond(pages, req.url, req.method)
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => (headers[k] = v))
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, hostname, () => resolve(server)))
}
