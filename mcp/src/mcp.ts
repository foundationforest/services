// The MCP door: every action as a tool, over stdio for a copy run on the person's own device, or
// over Streamable HTTP for a hosted copy. HOW goes to the AI first, as the server's instructions.
//
// Each tool takes its key in the call (writeKey, messageKey, readKey), and the profile it acts for.
// A copy run over stdio may also be started with keys, used when a call carries none, so the AI
// never sees them. A hosted copy takes keys only in the call: started with one, every caller would
// act as that person. It keeps nothing: each HTTP request gets a fresh server, gone when it ends.

import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ACTIONS, type Action, HOW, checkArgs, keyNeeded, keyParam } from './actions.ts'
import { type Context, refuse } from './forest.ts'

const VERSION = '0.0.0'

/** A tool's input: the action's parameters, then the profile and the keys it takes. */
export function inputSchema(action: Action) {
  const properties: { [name: string]: { type: string; description: string } } = {}
  for (const p of action.params) properties[p.name] = { type: p.type, description: p.description }
  if (action.keys.length) {
    properties.profile = { type: 'string', description: 'The address of the profile acted for. May be left out when the tool was started with one.' }
    for (const scope of action.keys) {
      properties[keyParam(scope)] = { type: 'string', description: `The ${scope} key, as its grant writes it. May be left out when the tool was started with one.` }
    }
  }
  const required = action.params.filter((p) => p.required).map((p) => p.name)
  return { type: 'object' as const, properties, ...(required.length > 0 && { required }) }
}

/** An MCP server for one stdio connection or one HTTP request, acting with `start` where a call carries nothing. */
export function mcpServer(start: Context): Server {
  const server = new Server({ name: 'forest', version: VERSION }, { capabilities: { tools: {} }, instructions: HOW })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ACTIONS.map((a) => ({ name: a.name, description: `${a.does} Key: ${keyNeeded(a)}.`, inputSchema: inputSchema(a) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const action = ACTIONS.find((a) => a.name === call.params.name) ?? refuse(`no tool ${call.params.name}`)
      const { profile, writeKey, messageKey, readKey, ...rest } = call.params.arguments ?? {}
      const taken = action.keys.length ? ['profile', ...action.keys.map(keyParam)] : []
      for (const [name, value] of Object.entries({ profile, writeKey, messageKey, readKey })) {
        if (value === undefined) continue
        if (!taken.includes(name)) refuse(`${action.name} takes no ${name}`)
        if (typeof value !== 'string') refuse(`${name} is text`)
      }
      const args = checkArgs(action, rest)
      const ctx: Context = {
        ...start,
        profile: (profile as string | undefined) ?? start.profile,
        keys: {
          write: (writeKey as string | undefined) ?? start.keys.write,
          message: (messageKey as string | undefined) ?? start.keys.message,
          read: (readKey as string | undefined) ?? start.keys.read,
        },
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

/**
 * Serve over Streamable HTTP at /mcp, stateless: no session, a fresh server for each request.
 * Refused when started with a key. TLS is the operator's.
 */
export async function serveHttp(start: Context, hostname: string, port: number): Promise<HttpServer> {
  if (start.keys.write !== undefined || start.keys.message !== undefined || start.keys.read !== undefined) {
    refuse('a hosted copy takes keys only in each call: unset FOREST_WRITE_KEY, FOREST_MESSAGE_KEY and FOREST_READ_KEY')
  }
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Parsed without throwing: a target that is no path, such as //, would end the process.
    const url = URL.parse(req.url ?? '/', 'http://localhost')
    if (url?.pathname !== '/mcp') {
      res.writeHead(url ? 404 : 400).end()
      return
    }
    const server = mcpServer({ ...start, keys: {} })
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
