// The connections service: forest's own (forest/records/src/connections.ts), unchanged, run as a
// service. It is an MCP server for assistants: `forest_read` reads a profile's public notes, and
// `forest_draft` answers with an approval link the person opens on their own device, where the note
// is shown, signed and posted. It holds no key, no grant and no draft, and asks for no login.
//
// Forest's `Connections.listen` answers on 127.0.0.1 only, and a service on a host must answer on
// every interface. So a front here takes each request as it comes and passes it, untouched, to that
// loopback address, and passes the answer back as it streams. The front reads nothing, keeps
// nothing and logs nothing.

import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Connections } from '../../forest/records/src/connections.ts'

export type Config = {
  /** The approval page every link opens, e.g. https://forest.foundation/approve. */
  approvalPage: string
  /** The hosts it reads a profile from first; it then reads the hosts the profile's folder names. */
  hosts: string[]
  /** How long a returning `forest_draft` reads the hosts for the person's approval before answering. */
  waitMs: number
  port: number
}

function url(name: string, value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return value
  } catch {}
  throw new Error(`${name} must be http or https URLs`)
}

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/** Reads the variables `README.md` lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['APPROVAL_PAGE', 'HOSTS'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  return {
    approvalPage: url('APPROVAL_PAGE', env.APPROVAL_PAGE!.trim()),
    hosts: env.HOSTS!.split(',').map((h) => h.trim()).filter(Boolean).map((h) => url('HOSTS', h)),
    waitMs: whole('WAIT_SECONDS', env.WAIT_SECONDS || '30', 0) * 1000,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

/** Headers that belong to one connection and are not passed on. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

export type Service = {
  /** The front's address, on loopback, for tests. */
  url: string
  server: Server
  close(): Promise<void>
}

export async function startConnections(config: Config): Promise<Service> {
  const connections = new Connections({ approvalPage: config.approvalPage, hosts: config.hosts, waitMs: config.waitMs })
  const inner = new URL(await connections.listen(0))

  const server = createServer((req, res) => {
    const upstream = request(
      { host: inner.hostname, port: inner.port, method: req.method, path: req.url, headers: passed(req.headers) },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
        answer.pipe(res)
      },
    )
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

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await connections.close()
    },
  }
}
