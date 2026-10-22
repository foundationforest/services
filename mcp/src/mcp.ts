// The MCP door: every tool, over stdio for a copy run on the person's own device, or over
// Streamable HTTP for a hosted copy. HOW goes to the AI first, as the server's instructions, and
// the mark on paper is the server's icon.
//
// Each tool takes the profile it acts for and its key in the call. A copy run over stdio may also
// be started with them, used when a call carries none, so the AI never sees the keys. A hosted copy
// takes keys only in the call: started with one, every caller would act as that person. It keeps
// nothing: each HTTP request gets a fresh server, gone when it ends.

import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { type Context, refuse } from './forest.ts'
import { ICO, ICON, SVG } from './icon.ts'
import { FROM_START, type Start, type Tool, checkArgs } from './params.ts'
import { HOW, TOOLS } from './tools.ts'

const VERSION = '0.0.0'

/** A tool's input: its parameters, the profile and key among them. None of those is required: the copy may have started with them. */
export function inputSchema(tool: Tool) {
  const properties: { [name: string]: { type: string; description: string; enum?: string[]; minimum?: number } } = {}
  for (const p of tool.params) {
    properties[p.name] = { type: p.type, description: p.description, ...(p.values && { enum: p.values }), ...(p.type === 'integer' && { minimum: p.minimum ?? 0 }) }
  }
  const required = tool.params.filter((p) => p.required).map((p) => p.name)
  return { type: 'object' as const, properties, ...(required.length > 0 && { required }) }
}

/** A call's arguments: what the copy started with, for the profile and key the tool takes, then what the call carries. */
export function withStart(tool: Tool, start: Start, args: { [name: string]: unknown }) {
  const taken = FROM_START.filter((name) => start[name] !== undefined && tool.params.some((p) => p.name === name))
  return { ...Object.fromEntries(taken.map((name) => [name, start[name]])), ...args }
}

/** An MCP server for one stdio connection or one HTTP request, acting with `start` where a call carries nothing. */
export function mcpServer(ctx: Context, start: Start): Server {
  const server = new Server({ name: 'forest', version: VERSION, icons: [ICON] }, { capabilities: { tools: {} }, instructions: HOW })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const tool = TOOLS.find((t) => t.name === call.params.name) ?? refuse(`no tool ${call.params.name}`)
      const out = await tool.run(checkArgs(tool, withStart(tool, start, call.params.arguments ?? {})), ctx)
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }
    }
  })
  return server
}

/** Serve over stdio until the client goes. */
export async function serveStdio(ctx: Context, start: Start): Promise<void> {
  await mcpServer(ctx, start).connect(new StdioServerTransport())
}

/** What a hosted copy serves besides its tools: the icon. */
const FILES: { [path: string]: { type: string; body: string | Buffer } } = {
  '/favicon.ico': { type: 'image/x-icon', body: ICO },
  '/icon.svg': { type: 'image/svg+xml', body: SVG },
}

/**
 * Serve over Streamable HTTP at the root, and at /mcp for connectors added before, stateless: no
 * session, a fresh server for each request; and the icon at /favicon.ico and /icon.svg. Refused
 * when started with a key. TLS is the operator's.
 */
export async function serveHttp(ctx: Context, start: Start, hostname: string, port: number): Promise<HttpServer> {
  if (start.writeKey !== undefined || start.readKey !== undefined) refuse('a hosted copy takes keys only in each call: unset FOREST_WRITE_KEY and FOREST_READ_KEY')
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Parsed without throwing: a target that is no path, such as //, would end the process.
    const url = URL.parse(req.url ?? '/', 'http://localhost')
    const file = url && FILES[url.pathname]
    if (file) {
      res.writeHead(200, { 'content-type': file.type }).end(file.body)
      return
    }
    if (url?.pathname !== '/' && url?.pathname !== '/mcp') {
      res.writeHead(url ? 404 : 400).end()
      return
    }
    const server = mcpServer(ctx, start)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
  })
  await new Promise<void>((resolve) => http.listen(port, hostname, resolve))
  return http
}
