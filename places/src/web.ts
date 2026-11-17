// Every URL the service answers, GET and HEAD only, JSON, open to any origin, with no login. Nothing
// about a request is kept or logged: a request that fails logs its error's kind only, never its
// path, its question or the error's message.

import { createServer, type Server } from 'node:http'

import { type Code } from './codes.ts'
import { CREDIT, type Places, readPoint, Refused } from './places.ts'

const HEADERS = {
  'access-control-allow-origin': '*',
  // Answers change only with a new file, which comes only with a new image.
  'cache-control': 'public, max-age=86400',
  'content-type': 'application/json; charset=utf-8',
}
const STATUS: { [code in Code]: number } = { bad_words: 400, bad_point: 400, bad_country: 400, not_found: 404, get_only: 405, failed: 500 }

const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } })
const refuse = (code: Code) => json({ error: code }, STATUS[code], code === 'get_only' ? { allow: 'GET, HEAD' } : {})

export type Web = { handle(request: Request): Response }

export function web(places: Places): Web {
  const about = places.about()
  function route(url: URL): Response {
    const q = url.searchParams
    const near = q.get('near')
    if (url.pathname === '/') return json({ ...about, find: '/v1/find?q=<words>&country=<XX>&near=<lat>,<lon>', name: '/v1/name?near=<lat>,<lon>', credit: CREDIT })
    if (url.pathname === '/v1/find') {
      const country = q.get('country')
      return json({ places: places.find(q.get('q') ?? '', { country: country ?? undefined, near: near === null ? undefined : readPoint(near) }), credit: CREDIT })
    }
    if (url.pathname === '/v1/name') return json({ places: places.name(readPoint(near ?? '')), credit: CREDIT })
    return refuse('not_found')
  }
  return {
    handle(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return refuse('get_only')
      let res: Response
      try {
        res = route(new URL(request.url))
      } catch (err) {
        if (!(err instanceof Refused)) throw err
        res = refuse(err.code)
      }
      return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
    },
  }
}

/** The answers on node:http. The URL they see is a fixed origin and the request's path: the Host header is never read. */
export function serve(pages: Web, port: number, hostname: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    let response: Response
    const method = req.method === 'HEAD' || req.method === 'GET' ? req.method : 'POST'
    try {
      response = pages.handle(new Request(`http://places.invalid${req.url ?? '/'}`, { method }))
    } catch (err) {
      if (err instanceof TypeError && /URL/.test(err.message)) response = refuse('not_found')
      else {
        // Its kind only: a message can quote the question.
        console.error(`a request failed: ${(err as Error).name} ${(err as { code?: string }).code ?? ''}`.trim())
        response = refuse('failed')
      }
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => (headers[k] = v))
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, hostname, () => resolve(server)))
}
