// The hosted copy: the MCP door over Streamable HTTP at its root (and at /mcp, where connectors
// added before point), the login (login.ts), the live link at /signer (link.ts), and the icon.
// Stateless: each MCP request gets a fresh server, gone when it ends, and nothing about a call is
// kept.
//
// Reading needs no login. A call to a tool that goes to the person's app with no token gets a 401
// whose challenge starts the AI app's login, and a token this copy did not give gets a 401 on any
// request. The request's
// Origin is not checked: the transport's check guards a server on a person's own computer from a
// web page's requests, and here every act needs a token no web page holds, while reading is open
// to anyone. TLS is the operator's.

import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { publicFetch } from '@foundationforest/records/public'
import { type Context, isObject, refuse } from './forest.ts'
import { TooLarge, json, readBody } from './http.ts'
import { ICO, ICON, SVG } from './icon.ts'
import { Login, loadKey } from './login.ts'
import { Link, MAX_FRAME } from './link.ts'
import { type Ctx, type Tool, checkArgs } from './params.ts'
import { HOW, TOOLS } from './tools.ts'

const VERSION = '0.0.0'

/** A tool's input: its parameters, as a JSON Schema. */
export function inputSchema(tool: Tool) {
  const properties: { [name: string]: { type: string | string[]; description: string; enum?: string[]; minimum?: number } } = {}
  for (const p of tool.params) {
    properties[p.name] = { type: p.nullable ? [p.type, 'null'] : p.type, description: p.description, ...(p.values && { enum: p.values }), ...(p.type === 'integer' && { minimum: p.minimum ?? 0 }) }
  }
  const required = tool.params.filter((p) => p.required).map((p) => p.name)
  return { type: 'object' as const, properties, ...(required.length > 0 && { required }) }
}

/** An MCP server for one request: HOW first, as its instructions, the mark as its icon, and every tool. */
export function mcpServer(ctx: Ctx): Server {
  const server = new Server({ name: 'forest', version: VERSION, icons: [ICON] }, { capabilities: { tools: {} }, instructions: HOW })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const tool = TOOLS.find((t) => t.name === call.params.name) ?? refuse(`no tool ${call.params.name}`)
      const out = await tool.run(checkArgs(tool, call.params.arguments ?? {}), ctx)
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }
    }
  })
  return server
}

/** What a hosted copy serves besides its tools: the icon. */
const FILES: { [path: string]: { type: string; body: string | Buffer } } = {
  '/favicon.ico': { type: 'image/x-icon', body: ICO },
  '/icon.svg': { type: 'image/svg+xml', body: SVG },
}

const TO_APP = new Set(TOOLS.filter((t) => t.toApp).map((t) => t.name))

export type Settings = {
  /** This copy's origin, as people and AI apps reach it; the address it listens on when left out. */
  origin?: string
  /** The app's connect page; without it, logins wait and reading works. */
  appUrl?: string
  /** Where its key is kept. */
  dataDir: string
  /** The index it reads. */
  read: Context
  /** How a client document is fetched: the standard's publicFetch unless told otherwise. */
  clientFetch?: typeof fetch
}

/** A copy serving: its origin, where it listens, and its live sockets. */
export type Served = { http: HttpServer; origin: string; url: string; link: Link; close: () => Promise<void> }

/** Serve on `hostname`:`port` until closed. */
export async function serve(settings: Settings, hostname: string, port: number): Promise<Served> {
  const key = loadKey(settings.dataDir)
  const known = { origin: settings.origin ?? '', ...(settings.appUrl && { appUrl: settings.appUrl }), clientFetch: settings.clientFetch ?? publicFetch }
  const login = new Login(key, known)
  const link = new Link(() => known.origin)

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const connection = login.bearer(req)
    if (connection === 'bad') return login.challenge(res, true)
    // No session and no stream of the server's own: only POST.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    let body: unknown
    try {
      body = JSON.parse(await readBody(req, MAX_FRAME))
    } catch (err) {
      return json(res, err instanceof TooLarge ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const calls = (Array.isArray(body) ? body : [body]).filter((m) => isObject(m) && m.method === 'tools/call' && isObject(m.params))
    if (connection === null && calls.some((m) => TO_APP.has((m as { params: { name?: unknown } }).params.name as string))) return login.challenge(res, false)
    const ctx: Ctx = { ...settings.read, ask: (ask) => (connection ? link.ask(connection, ask) : refuse('Acting for the person needs a login.')) }
    const server = mcpServer(ctx)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parsed without throwing: a target that is no path, such as //, would end the process.
    const url = URL.parse(req.url ?? '/', 'http://localhost')
    if (!url) {
      res.writeHead(400).end()
      return
    }
    const get = req.method === 'GET' || req.method === 'HEAD'
    const file = FILES[url.pathname]
    if (file && get) {
      res.writeHead(200, { 'content-type': file.type }).end(file.body)
      return
    }
    switch (url.pathname) {
      case '/':
      case '/mcp':
        return mcp(req, res)
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/':
        if (get) return login.protectedResource(res)
        break
      case '/.well-known/oauth-authorization-server':
        if (get) return login.authorizationServer(res)
        break
      case '/register':
        if (req.method === 'POST') return login.register(req, res)
        break
      case '/authorize':
        if (get) return login.authorize(url, res)
        break
      case '/connected':
        if (get) return login.connected(url, res)
        break
      case '/token':
        if (req.method === 'POST') return login.token(req, res)
        break
      default:
        res.writeHead(404).end()
        return
    }
    res.writeHead(405).end()
  }

  const http = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  http.on('upgrade', (req, stream, head) => {
    if (URL.parse(req.url ?? '/', 'http://localhost')?.pathname === '/signer') link.upgrade(req, stream, head)
    else stream.destroy()
  })
  await new Promise<void>((resolve) => http.listen(port, hostname, resolve))
  const url = `http://${hostname}:${(http.address() as AddressInfo).port}`
  known.origin ||= url
  return {
    http,
    origin: known.origin,
    url,
    link,
    close: async () => {
      link.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    },
  }
}
