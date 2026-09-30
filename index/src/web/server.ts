// The pages on node:http, for running locally and on any plain server (Railway). A serverless host
// mounts `handle` instead (HOSTING.md).

import { createServer, type Server } from 'node:http'

import type { Web } from './routes.ts'

export function serve(web: Web, port: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
    const response = await web.handle(new Request(url, { method: req.method }))
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}
