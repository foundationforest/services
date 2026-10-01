// The connections service: forest's own (forest/records/src/connections.ts), unchanged, run as a
// service. It is an MCP server for assistants: `forest_read` reads a profile's public notes, and
// `forest_draft` answers with an approval link the person opens on their own device, where the note
// is shown, signed and posted. It holds no key, no grant and no draft, and asks for no login.
//
// It also serves that approval page: forest's own (forest/records/web), built unchanged by its
// web/build.ts, at /approve, with the policy records/SPEC.md §12 asks for. The files are read once
// at start and never change while it runs, so the hash the build wrote is the hash of what is
// served; both the hash and the list of libraries in the bundle are served beside it.
//
// Forest's `Connections.listen` answers on 127.0.0.1 only, and a service on a host must answer on
// every interface. So a front here takes each request as it comes and passes it, untouched, to that
// loopback address, and passes the answer back as it streams. The front reads nothing, keeps
// nothing and logs nothing.

import { existsSync, readFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Connections } from '../../forest/records/src/connections.ts'

export type Config = {
  /** The approval page every link opens, e.g. https://forest.foundation/approve. */
  approvalPage: string
  /** The hosts it reads a profile from first; it then reads the hosts the profile's folder names. */
  hosts: string[]
  /** How long a returning `forest_draft` reads the hosts for the person's approval before answering. */
  waitMs: number
  /** Where forest's built approval page is (records/web/dist); null: no page served here. */
  pageDir: string | null
  port: number
}

/** Forest's built page, beside this repo's copy of forest: `node web/build.ts` in forest/records writes it. */
export const PAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../forest/records/web/dist')

/**
 * The policy records/SPEC.md §12 asks the approval page to be served with: its own script and style
 * only, no HTML from strings, reads and posts over https only, never in a frame. The page's own
 * meta policy applies too; a request must pass both.
 */
export const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https:; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'"

/** The page's files, by path, as its build names them. */
const PAGE_FILES: Record<string, [file: string, type: string]> = {
  '/approve': ['approve.html', 'text/html; charset=utf-8'],
  '/approve.js': ['approve.js', 'text/javascript; charset=utf-8'],
  '/approve.css': ['approve.css', 'text/css; charset=utf-8'],
  '/approve.js.sha256': ['approve.js.sha256', 'text/plain; charset=utf-8'],
  '/approve.deps.txt': ['approve.deps.txt', 'text/plain; charset=utf-8'],
}

function loadPage(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>()
  for (const [path, [file, type]] of Object.entries(PAGE_FILES)) {
    if (!existsSync(join(dir, file))) throw new Error(`the approval page is not built: no ${file} in ${dir} (node web/build.ts in forest/records)`)
    out.set(path, { body: readFileSync(join(dir, file)), type })
  }
  return out
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
    pageDir: env.APPROVAL_PAGE_DIR === 'none' ? null : env.APPROVAL_PAGE_DIR || PAGE_DIR,
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
  const page = config.pageDir ? loadPage(config.pageDir) : null

  const server = createServer((req, res) => {
    const file = page?.get(new URL(req.url ?? '/', 'http://service.invalid').pathname)
    if (file) {
      req.resume()
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { allow: 'GET, HEAD' }).end()
      res.writeHead(200, {
        'content-type': file.type,
        'content-length': file.body.length,
        'content-security-policy': PAGE_POLICY,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      })
      return void res.end(req.method === 'HEAD' ? undefined : file.body)
    }
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
