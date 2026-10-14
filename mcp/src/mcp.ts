// The MCP door: every action as a tool, over stdio for a copy run on the person's own device, or
// over Streamable HTTP for a hosted copy. HOW goes to the AI first, as the server's instructions,
// and the mark on paper is the server's icon.
//
// Each tool takes its key in the call, by the name the app gives it (writingKey, inboxKey), or by
// its older name (writeKey, messageKey, readKey), and the profile it acts for. A copy run over
// stdio may also be started with keys, used when a call carries none, so the AI never sees them. A
// hosted copy takes keys only in the call: started with one, every caller would act as that person.
// It keeps nothing: each HTTP request gets a fresh server, gone when it ends.

import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ACTIONS, type Action, HOSTED, HOW, checkArgs, described } from './actions.ts'
import { type Context, type Given, keysFrom, refuse } from './forest.ts'
import { ICO, ICON, SVG } from './icon.ts'

const VERSION = '0.0.0'

/** Each name a key goes by in a call, and the scopes of the actions that take it. */
const KEY_NAMES: { [name in keyof Given]-?: Array<'write' | 'message' | 'read'> } = {
  writingKey: ['write'],
  inboxKey: ['message', 'read'],
  writeKey: ['write'],
  messageKey: ['message', 'read'],
  readKey: ['message', 'read'],
}

/** A tool's input: the action's parameters, then the profile and the keys it takes, by the names the app gives them. */
export function inputSchema(action: Action) {
  const properties: { [name: string]: { type: string; description: string; enum?: string[] } } = {}
  for (const p of action.params) properties[p.name] = { type: p.type, description: p.description, ...(p.values && { enum: p.values }) }
  if (action.keys.length) {
    properties.profile = { type: 'string', description: "The profile's address, as the app gives it." }
    if (action.keys.includes('write')) properties.writingKey = { type: 'string', description: 'The writing key, as the app gives it.' }
    else properties.inboxKey = { type: 'string', description: 'The inbox key, as the app gives it: <message key>.<read key>.' }
  }
  const required = action.params.filter((p) => p.required).map((p) => p.name)
  return { type: 'object' as const, properties, ...(required.length > 0 && { required }) }
}

/** An MCP server for one stdio connection or one HTTP request, with `actions` as its tools, acting with `start` where a call carries nothing. */
export function mcpServer(start: Context, actions: Action[] = ACTIONS): Server {
  const server = new Server({ name: 'forest', version: VERSION, icons: [ICON] }, { capabilities: { tools: {} }, instructions: HOW })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: actions.map((a) => ({ name: a.name, description: described(a), inputSchema: inputSchema(a) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const action = actions.find((a) => a.name === call.params.name) ?? refuse(`no tool ${call.params.name}`)
      const { profile, writingKey, inboxKey, writeKey, messageKey, readKey, ...rest } = call.params.arguments ?? {}
      const given = { writingKey, inboxKey, writeKey, messageKey, readKey }
      for (const [name, value] of Object.entries({ profile, ...given })) {
        if (value === undefined) continue
        const takes = name === 'profile' ? action.keys.length > 0 : KEY_NAMES[name as keyof Given].some((scope) => action.keys.includes(scope))
        if (!takes) refuse(`${action.name} takes no ${name}`)
        if (typeof value !== 'string') refuse(`${name} is text`)
      }
      const args = checkArgs(action, rest)
      const keys = keysFrom(given as Given)
      const ctx: Context = {
        ...start,
        profile: (profile as string | undefined) ?? start.profile,
        keys: { write: keys.write ?? start.keys.write, message: keys.message ?? start.keys.message, read: keys.read ?? start.keys.read },
      }
      const out = await action.run(args, ctx)
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }
    }
  })
  return server
}

/** Serve over stdio until the client goes. */
export async function serveStdio(start: Context): Promise<void> {
  await mcpServer(start).connect(new StdioServerTransport())
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
export async function serveHttp(start: Context, hostname: string, port: number): Promise<HttpServer> {
  if (start.keys.write !== undefined || start.keys.message !== undefined || start.keys.read !== undefined) {
    refuse('a hosted copy takes keys only in each call: unset FOREST_WRITING_KEY, FOREST_INBOX_KEY and the older FOREST_WRITE_KEY, FOREST_MESSAGE_KEY and FOREST_READ_KEY')
  }
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
    const server = mcpServer({ ...start, keys: {} }, HOSTED)
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
