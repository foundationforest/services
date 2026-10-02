// A host for devnet testing only: forest/records' reference host (forest/records/src/host.ts),
// unchanged, run so the e2e run (../e2e.ts) and the devnet index have somewhere to read and write
// records. The foundation runs no host; hosts are run by apps. This one takes anyone's records,
// sets no policy of its own, and may be wiped at any time.
//
// Around forest's host, one thing only: a front that answers `GET /` with one line saying what this
// is, and passes every other request, untouched, to the host on loopback (forest's host answers
// only /v1/records).

import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { Host } from '../../../forest/records/src/host.ts'

/** What `GET /` says: what this is, for anyone who opens it. */
export const LABEL =
  'A Forest host for devnet testing only: forest/records’ reference host, run for the e2e run in ' +
  'foundationforest/services. The foundation runs no host. Anyone may write here, and it may be wiped at any time.\n'

export type Config = {
  /** The SQLite file; in memory when null. */
  file: string | null
  port: number
}

/** Reads DATABASE_PATH and PORT. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT || 8080)
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  return { file: env.DATABASE_PATH || null, port }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

export type TestHost = { url: string; host: Host; server: Server; close(): Promise<void> }

export async function startHost(config: Config): Promise<TestHost> {
  if (config.file) mkdirSync(dirname(config.file), { recursive: true })
  const host = new Host({ file: config.file ?? undefined })
  const inner = new URL(await host.listen(0))

  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://host.invalid').pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      return void res.end(req.method === 'HEAD' ? undefined : LABEL)
    }
    const upstream = request({ host: inner.hostname, port: inner.port, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await host.close()
    },
  }
}
