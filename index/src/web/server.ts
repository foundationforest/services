// The pages on node:http, for running locally and on any plain server (Railway). A serverless host
// mounts `handle` instead (README.md, "Two processes").
//
// No request stops the process. The URL the pages see is a fixed origin and the request's path: the
// Host header is never read, so no header can make a URL that does not parse. A method a web Request
// refuses (TRACE) gets 405 here, as the pages answer every method but GET and HEAD. Anything
// else that fails gets 500, logged without an address or a query.

import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { Web } from './routes.ts'

const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

/** The request as the pages take it, or the answer when it cannot be one. */
function requestOf(req: IncomingMessage): Request | Response {
  let url: URL
  try {
    url = new URL(`http://index.invalid${req.url ?? '/'}`)
  } catch {
    return new Response('That address is not written correctly.\n', { status: 400, headers: TEXT })
  }
  try {
    return new Request(url, { method: req.method })
  } catch {
    return new Response('GET only\n', { status: 405, headers: { ...TEXT, allow: 'GET, HEAD' } })
  }
}

export function serve(web: Web, port: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(async (req, res) => {
    let response: Response
    try {
      const request = requestOf(req)
      response = request instanceof Response ? request : await web.handle(request)
    } catch (err) {
      console.error('request failed', err)
      response = new Response('The index could not answer this.\n', { status: 500, headers: TEXT })
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}
