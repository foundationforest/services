// Every URL the index answers, for people and machines alike. Stable URLs, GET and HEAD only, no
// session, no login, no cookies, cacheable, open to any origin. `handle` takes a web-standard
// Request and returns a Response, so it runs under node:http (server.ts) or as a serverless
// function unchanged.
//
// A page lives at its path and its JSON twin at the same path with `.json` (the home page's is
// /index.json); the twin is the very object the page is rendered from.

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Directory } from '../markets.ts'
import * as data from './data.ts'
import { type Near, urlsFor } from './html.ts'
import { robots, sitemap, textFile } from './machine.ts'
import * as pages from './pages.ts'
import { pay } from './pay.ts'

export type Web = { handle: (req: Request) => Promise<Response> }

const DECIMAL = /^-?\d{1,3}(\.\d{1,6})?$/

/**
 * `near=lat,lon&km=N`: a point in degrees and a distance in kilometres, both or neither. Null when
 * neither is asked; a string saying what is wrong when either is malformed.
 */
export function parseNear(search: URLSearchParams): Near | null | string {
  const near = search.get('near')
  const km = search.get('km')
  if (near === null && km === null) return null
  const [lat, lon, ...rest] = (near ?? '').split(',')
  const n = { lat: Number(lat), lon: Number(lon), km: Number(km) }
  if (rest.length || !DECIMAL.test(lat ?? '') || !DECIMAL.test(lon ?? '') || Math.abs(n.lat) > 90 || Math.abs(n.lon) > 180) {
    return 'near must be a point in degrees, latitude then longitude, such as near=38.72,-9.14'
  }
  if (km === null || !/^\d{1,5}(\.\d{1,3})?$/.test(km) || n.km <= 0 || n.km > 20_000) {
    return 'km must be a distance in kilometres above 0 and at most 20000, such as km=10'
  }
  return n
}

const CACHE = 'public, max-age=30, stale-while-revalidate=300'
const SECURITY = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // No script runs on any page: the JSON-LD block is data, which this does not block.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors *",
}

function respond(status: number, type: string, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': type, 'cache-control': status === 200 ? CACHE : 'public, max-age=10', ...SECURITY, ...headers },
  })
}

const HTML = 'text/html; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'
const jsonText = (body: unknown) => JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

export function createWeb(ctx: { db: Db; directory: Directory; config: Config }): Web {
  const urls = urlsFor(ctx.config.publicUrl)
  const c: data.Ctx = { ...ctx, urls }
  const view: pages.View = { urls, currencies: ctx.config.currencies }
  const files = { llms: textFile('llms.txt', urls.base), skill: textFile('skill.md', urls.base) }

  /** A page model as HTML or as its twin, with the twin linked from the page's headers too. */
  function page<M extends { url: string; json: string }>(model: M, asJson: boolean, render: (v: pages.View, m: M) => string): Response {
    if (asJson) return respond(200, JSON_TYPE, jsonText(model), { link: `<${model.url}>; rel="canonical"` })
    return respond(200, HTML, render(view, model), { link: `<${model.json}>; rel="alternate"; type="application/json"` })
  }

  function notFound(asJson: boolean, url: URL, message: string): Response {
    if (asJson) return respond(404, JSON_TYPE, jsonText({ error: 'NotFound', message }))
    return respond(404, HTML, pages.notFoundPage(view, `${urls.base}${url.pathname}`, message))
  }

  function badRequest(asJson: boolean, url: URL, message: string): Response {
    if (asJson) return respond(400, JSON_TYPE, jsonText({ error: 'BadRequest', message }))
    return respond(400, HTML, pages.notFoundPage(view, `${urls.base}${url.pathname}`, message))
  }

  async function route(url: URL): Promise<Response> {
    let path = url.pathname
    if (path === '/robots.txt') return respond(200, 'text/plain; charset=utf-8', robots(urls.base))
    if (path === '/sitemap.xml') return respond(200, 'application/xml; charset=utf-8', sitemap(await data.pages(c)))
    if (path === '/llms.txt') return respond(200, 'text/markdown; charset=utf-8', files.llms)
    if (path === '/skill.md') return respond(200, 'text/markdown; charset=utf-8', files.skill)

    const asJson = path.endsWith('.json')
    if (asJson) path = path === '/index.json' ? '/' : path.slice(0, -'.json'.length)
    let parts: string[]
    try {
      parts = path.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return notFound(asJson, url, 'That address is not written correctly.')
    }
    const [a, b] = parts

    if (parts.length === 0) return page(await data.home(c), asJson, pages.homePage)
    if (a === 'folders' && parts.length === 2) {
      const m = await data.folder(c, b)
      return m ? page(m, asJson, pages.folderPage) : notFound(asJson, url, `No folder named ${b} in this index’s directory.`)
    }
    if (a === 'markets' && parts.length === 2) {
      if (!ctx.directory.markets.has(b)) return notFound(asJson, url, `No market named ${b} in this index’s directory.`)
      const near = parseNear(url.searchParams)
      if (typeof near === 'string') return badRequest(asJson, url, near)
      const raw = Number(url.searchParams.get('offset') ?? 0)
      const offset = Number.isInteger(raw) && raw >= 0 ? Math.min(raw, 100_000) : 0
      return page((await data.market(c, b, offset, near))!, asJson, pages.marketPage)
    }
    if (a === 'profiles' && parts.length === 2) {
      const m = await data.profile(c, b)
      return m ? page(m, asJson, pages.profilePage) : notFound(asJson, url, `No profile ${b} in this index.`)
    }
    if (a === 'deals' && parts.length === 2) {
      const m = await data.deal(c, b)
      return m ? page(m, asJson, pages.dealPage) : notFound(asJson, url, `Nothing in this index names the deal ${b}.`)
    }
    if (a === 'search' && parts.length === 1) {
      const q = (url.searchParams.get('q') ?? '').trim()
      if (q.length > 200) return asJson ? respond(400, JSON_TYPE, jsonText({ error: 'BadRequest', message: 'q is at most 200 characters' })) : notFound(false, url, 'Search for 200 characters or fewer.')
      const near = parseNear(url.searchParams)
      if (typeof near === 'string') return badRequest(asJson, url, near)
      return page(await data.search(c, q, near), asJson, pages.searchPage)
    }
    if (a === 'pay' && parts.length === 1) return page(await pay(c, url.searchParams), asJson, pages.payPage)
    return notFound(asJson, url, `There is no page at ${url.pathname}.`)
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return respond(405, 'text/plain; charset=utf-8', 'GET only\n', { allow: 'GET, HEAD' })
    }
    const url = new URL(req.url)
    try {
      const res = await route(url)
      return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
    } catch (err) {
      // No address and no query in the log: only that this path failed, and why.
      console.error('request failed', url.pathname, err)
      return respond(500, 'text/plain; charset=utf-8', 'The index could not answer this.\n')
    }
  }

  return { handle }
}
