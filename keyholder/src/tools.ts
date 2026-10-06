// The tools an assistant gets on a connection, the same on both doors: MCP at /mcp, and plain HTTP
// at /v1/tools (service.ts). Each acts for the connection's profile with the keys its app handed
// over, and only those: a write key posts and removes offers and posts reviews; a message key pulls
// the inbox and sends messages for the profile; a read key opens what is sealed to it. No tool
// writes the card, the hosts or permissions record, or the grants.
//
// Before a record goes out, the profile is read where it lives (forest's readProfile): it is posted
// only if the profile's permissions record lists the write key for that path now, the main key has
// not written there (the owner wins), and the body fits forest's own shape for it. A message goes
// out as it is: the recipient's hosts check the message key against the profile's permissions
// record themselves, so revoking it is the person's, on their hosts.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { type Body, type Scope, RecordError, allowsArrival, covers, deliver, isPrivate, liveContent, nextTime, publicKeyFromAddress, publish, pull, readProfile } from '../../forest/records/src/index.ts'

import type { Held, KeyStore } from './keys.ts'
import { FOREST } from './paths.ts'
import { type Signer, accessRecord, message, pullRequest } from './sign.ts'

/** One connection, as the tools see it. */
export type Context = {
  connection: string
  /** The profile its keys are for. */
  profile: string
  keys: KeyStore
  /** The hosts it reads a profile from first; then the hosts the profile's hosts record names. */
  hosts: string[]
  /** The index it reads markets and scores from: an origin. */
  index: string
  /** End the connection: its keys, its codes and its tokens. */
  end(): Promise<void>
}

type Result = { text: string; data: Record<string, unknown> }
type Tool = { name: string; title: string; description: string; input: Record<string, unknown>; run(c: Context, args: any): Promise<Result> }

class Refused extends Error {}
const refuse = (text: string): never => {
  throw new Refused(text)
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)

/** forest's shape for a kind of record, as its JSON Schema. */
const shape = (kind: 'offer' | 'review') => JSON.parse(readFileSync(join(FOREST, 'records/schemas', `${kind}.json`), 'utf8')) as Record<string, any>
const bodies = { offer: ajv.compile(shape('offer')), review: ajv.compile(shape('review')) }

/** A record id: a path segment, as forest's paths allow. */
const ID = '^[a-z0-9][a-z0-9._-]{0,63}$'
const ADDRESS = '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
const newId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, required, properties })

/** A tool's input for a record: an optional id, and the record in forest's own shape, `createdAt` filled in when left out. */
function recordInput(kind: 'offer' | 'review'): Record<string, unknown> {
  const { $schema: _s, title: _t, $defs, ...rest } = shape(kind)
  return {
    ...object(
      {
        id: { type: 'string', pattern: ID, description: `The record's id: it is posted at ${kind}/<id>. Posting the same id again replaces the record. Left out, a new one is made.` },
        [kind]: { ...rest, required: rest.required.filter((f: string) => f !== 'createdAt'), description: `${rest.description} \`createdAt\` is filled in with now when left out.` },
      },
      [kind],
    ),
    $defs,
  }
}

/** The first key this connection holds with this scope, covering `path` when one is given. */
async function heldKey(c: Context, scope: Scope, path?: string): Promise<Held> {
  const held = await c.keys.held(c.connection)
  const key = held.find((h) => h.scope === scope && (path === undefined || covers({ key: h.address, scope, ...(h.paths && { paths: h.paths }) }, path)))
  return key ?? refuse(`this connection holds no ${scope} key${path ? ` for ${path}` : ''}. The person hands one over in their app, by connecting again.`)
}

const signer = (c: Context): Signer => ({ keys: c.keys, connection: c.connection })
const said = (outcomes: Array<{ host: string; results: Array<{ ok: boolean; id?: string; error?: string }>; error?: string }>) =>
  outcomes.map((o) => ({ host: o.host, ok: o.results[0]?.ok ?? false, id: o.results[0]?.id ?? null, error: o.error ?? o.results[0]?.error ?? null }))
const why = (report: Array<{ host: string; error: string | null }>) => report.map((r) => `${r.host} (${r.error})`).join(', ')

/** Sign a record at `path` with a write key, and post it to every host the profile names. */
async function write(c: Context, path: string, body: Body | null): Promise<Result> {
  const key = await heldKey(c, 'write', path)
  const now = Date.now()
  const view = await readProfile(c.hosts, c.profile, now)
  if (!view.hosts.length) refuse('the profile names no hosts: its app has not published its hosts record where this key holder looks')
  const current = view.current.get(path)
  if (current && current.record.by === undefined) refuse(`the profile's main key wrote ${path}; an access key cannot replace or remove it.${body ? ' Use another id.' : ''}`)
  if (body === null && (!current || current.record.body === null)) refuse(`there is nothing at ${path}`)
  const record = await accessRecord(signer(c), key.address, c.profile, path, body, nextTime(now, view, path))
  if (!allowsArrival(view.access, record)) {
    refuse(`this connection's write key (${key.address}) is not on the profile's permissions list for ${path}, or it is revoked. The person adds it in their app, or connects again.`)
  }
  const report = said(await publish(view.hosts, [record]))
  const took = report.filter((r) => r.ok)
  if (!took.length) refuse(`no host took the record: ${why(report)}`)
  return {
    text: `${body ? 'Posted' : 'Removed'} ${path} for ${c.profile} on ${took.length} of ${report.length} hosts.`,
    data: { profile: c.profile, path, id: took[0]!.id, time: record.time, hosts: report },
  }
}

/** Seal `body` to `to`'s card and deliver it, signed by a message key for the profile, naming its first host. */
async function send(c: Context, to: string, body: Body): Promise<Result> {
  if (!publicKeyFromAddress(to)) refuse(`${to} is not a profile's address`)
  const key = await heldKey(c, 'message')
  const now = Date.now()
  const mine = await readProfile(c.hosts, c.profile, now)
  const host = mine.hosts[0] ?? refuse('the profile names no hosts: its app has not published its hosts record where this key holder looks')
  const theirs = to === c.profile ? mine : await readProfile(c.hosts, to, now)
  const card = theirs.current.get('profile')?.record.body
  if (!card || !theirs.hosts.length) refuse(`no card for ${to} on the hosts this key holder reads`)
  let m
  try {
    m = await message(signer(c), key.address, c.profile, host, to, body, now, card!)
  } catch (err) {
    if (err instanceof RecordError) refuse(`${to} takes no messages this key holder can seal: ${err.message}`)
    throw err
  }
  const report = said(await deliver(theirs.hosts, [m]))
  const took = report.filter((r) => r.ok)
  if (!took.length) refuse(`no host took the message: ${why(report)}`)
  return {
    text: `Sent to ${to}, signed by the message key ${key.address} for ${c.profile}, on ${took.length} of ${report.length} hosts.`,
    data: { to, from: c.profile, key: key.address, host, id: took[0]!.id, time: m.time, hosts: report },
  }
}

/** A JSON page of the index, or null when it has none. */
async function fromIndex(c: Context, url: URL): Promise<unknown | null> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (res.status === 404) return null
  if (!res.ok) refuse(`the index answered ${res.status}`)
  return res.json()
}

const TOOLS: Tool[] = [
  {
    name: 'read_profile',
    title: 'Read a profile',
    description:
      "Read a profile as its hosts serve it: its card, its offers and the reviews it wrote, each checked by forest's rules. Also what the index says of it (its rows, scores and the reviews it received), or null when the index does not count it. Left out, `address` is the profile this connection acts for.",
    input: object({ address: { type: 'string', pattern: ADDRESS } }),
    async run(c, { address = c.profile }) {
      if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
      const view = await readProfile(c.hosts, address, Date.now())
      if (!view.current.size) refuse(`no host this key holder reads has records for ${address}`)
      const live = liveContent(view)
      const under = (prefix: string) =>
        [...live].filter(([p]) => p.startsWith(`${prefix}/`)).map(([path, { record }]) => ({ path, by: record.by ?? null, time: record.time, body: record.body }))
      const index = await fromIndex(c, new URL(`/profiles/${address}.json`, c.index)).catch(() => null)
      const data = { address, hosts: view.hosts, card: live.get('profile')?.record.body ?? null, offers: under('offer'), reviewsGiven: under('review'), index }
      return { text: JSON.stringify(data), data }
    },
  },
  {
    name: 'read_market',
    title: 'Read a market',
    description: "Read a market through the index: the market's file, its counts, and its live offers, 50 a page. `near` (\"lat,lon\") with `km` keeps offers within that distance.",
    input: object(
      {
        market: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
        near: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?,-?[0-9]+(\\.[0-9]+)?$' },
        km: { type: 'number', exclusiveMinimum: 0 },
        offset: { type: 'integer', minimum: 0 },
      },
      ['market'],
    ),
    async run(c, { market, near, km, offset }) {
      const url = new URL(`/markets/${market}.json`, c.index)
      for (const [k, v] of Object.entries({ near, km, offset })) if (v !== undefined) url.searchParams.set(k, String(v))
      const data = (await fromIndex(c, url)) ?? refuse(`the index has no market named ${market}`)
      return { text: JSON.stringify(data), data: data as Record<string, unknown> }
    },
  },
  {
    name: 'post_offer',
    title: 'Post or update an offer',
    description: "Post an offer or a request for the profile, signed by this connection's write key, to the hosts the profile names. Posting the same id again updates it. The market and side are the profile's own.",
    input: recordInput('offer'),
    run: (c, args) => post(c, 'offer', args),
  },
  {
    name: 'remove_offer',
    title: 'Remove an offer',
    description: "Remove an offer this connection's write key, or another access key, posted at offer/<id>. One the profile's main key wrote stays.",
    input: object({ id: { type: 'string', pattern: ID } }, ['id']),
    run: (c, { id }) => write(c, `offer/${id}`, null),
  },
  {
    name: 'post_review',
    title: 'Post a review',
    description: "Post a review of another profile, by the profile, signed by this connection's write key. Name the deal it is about with dealId: the escrow's address.",
    input: recordInput('review'),
    run: (c, args) => post(c, 'review', args),
  },
  {
    name: 'pull_inbox',
    title: 'Pull the inbox',
    description:
      "Pull the profile's inbox from each of its hosts with this connection's message key, and open each message a read key it holds opens; the others come back unopened. `after` is the `cursors` a previous pull gave, to get only what arrived since.",
    input: object({ after: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } }),
    async run(c, { after = {} }) {
      const key = await heldKey(c, 'message')
      const readers = (await c.keys.held(c.connection)).filter((h) => h.scope === 'read')
      const view = await readProfile(c.hosts, c.profile, Date.now())
      if (!view.hosts.length) refuse('the profile names no hosts: its app has not published its hosts record where this key holder looks')
      const cursors: Record<string, number> = {}
      const refused: Array<{ host: string; error: string | null }> = []
      const found = new Map<string, { host: string; message: Awaited<ReturnType<typeof pull>>['messages'][number]['message'] }>()
      for (const host of view.hosts) {
        try {
          const page = await pull(host, await pullRequest(signer(c), key.address, c.profile, after[host] ?? 0, Date.now()))
          cursors[host] = page.cursor
          for (const m of page.messages) if (!found.has(m.id)) found.set(m.id, { host, message: m.message })
        } catch (err) {
          refused.push({ host, error: err instanceof RecordError ? err.code : 'host' })
        }
      }
      if (!Object.keys(cursors).length) refuse(`no host took the pull: ${why(refused)}`)
      const messages = []
      for (const [id, { host, message: m }] of found) {
        let body: Body | null = null
        for (const r of readers) {
          body = await c.keys.open(c.connection, r.address, m.body).catch(() => null)
          if (body) break
        }
        messages.push({ id, host, from: m.from, ...(m.key !== undefined && { key: m.key }), time: m.time, opened: body !== null, body })
      }
      const data = { profile: c.profile, messages, cursors, refused }
      return { text: JSON.stringify(data), data }
    },
  },
  {
    name: 'open_private',
    title: 'Open a private record',
    description: "Open one of the profile's private records, at its path, with a read key this connection holds. The person's app chooses which private records it seals to that key.",
    input: object({ path: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}(/[a-z0-9][a-z0-9._-]{0,63}){0,3}$' } }, ['path']),
    async run(c, { path }) {
      const readers = (await c.keys.held(c.connection)).filter((h) => h.scope === 'read')
      if (!readers.length) refuse('this connection holds no read key. The person hands one over in their app, by connecting again.')
      const current = (await readProfile(c.hosts, c.profile, Date.now())).current.get(path)
      if (!current || current.record.body === null) refuse(`there is nothing at ${path}`)
      if (!isPrivate(current!.record.body)) refuse(`${path} is not private: read it with read_profile`)
      for (const r of readers) {
        const body = await c.keys.open(c.connection, r.address, current!.record.body!).catch(() => null)
        if (body) {
          const data = { profile: c.profile, path, time: current!.record.time, body }
          return { text: JSON.stringify(data), data }
        }
      }
      return refuse(`${path} is not sealed to a read key this connection holds`)
    },
  },
  {
    name: 'send_message',
    title: 'Send a message',
    description:
      "Send a message to a profile's inbox, for the profile this connection acts for: sealed to the recipient's inbox key and readers, signed by this connection's message key, naming the profile's first host, where the recipient's hosts check that the profile lists the key.",
    input: object({ to: { type: 'string', pattern: ADDRESS }, text: { type: 'string', minLength: 1 } }, ['to', 'text']),
    run: (c, { to, text }) => send(c, to, { text }),
  },
  {
    name: 'request_payment',
    title: 'Ask the person to pay',
    description:
      "Ask the person this connection acts for to pay: a message to their own inbox, { request: \"pay\", amount, to, note }, which they approve or not in their app. This key holder holds no key that can pay. `amount` is decimal text, such as \"30\"; `to` is the address to pay.",
    input: object(
      { amount: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' }, to: { type: 'string', pattern: ADDRESS }, note: { type: 'string' } },
      ['amount', 'to'],
    ),
    async run(c, { amount, to, note }) {
      if (!publicKeyFromAddress(to)) refuse(`${to} is not an address`)
      return send(c, c.profile, { request: 'pay', amount, to, ...(note !== undefined && { note }) })
    },
  },
  {
    name: 'list_grants',
    title: 'What this connection may do',
    description: "List the keys this connection holds for the profile, as the person's app handed them over: each one's scope (write, message or read), its paths, who handed it over and when. Never a private half.",
    input: object({}),
    async run(c) {
      const data = { profile: c.profile, grants: await c.keys.held(c.connection) }
      return { text: JSON.stringify(data), data }
    },
  },
  {
    name: 'disconnect',
    title: 'Disconnect',
    description:
      "End this connection: the key holder deletes its copies of the keys, and every token for it. The keys still work wherever the profile's permissions record lists them, until the person removes them in their app.",
    input: object({}),
    async run(c) {
      await c.end()
      return { text: `Disconnected. This key holder no longer holds the keys for ${c.profile}; the person removes them in their app to stop them.`, data: { profile: c.profile } }
    },
  },
]

/** Post an offer or a review: an id, and a body that fits forest's shape once `createdAt` is filled in. */
async function post(c: Context, kind: 'offer' | 'review', args: Record<string, unknown>): Promise<Result> {
  const body = { createdAt: new Date().toISOString(), ...(args[kind] as object) } as Body
  const valid = bodies[kind]
  if (!valid(body)) refuse(`not a valid ${kind}: ${ajv.errorsText(valid.errors, { dataVar: kind })}`)
  return write(c, `${kind}/${(args.id as string | undefined) ?? newId()}`, body)
}

const inputs = new Map<string, ValidateFunction>(TOOLS.map((t) => [t.name, ajv.compile(t.input)]))

/** The tools, as both doors list them. */
export function listTools() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.input }))
}

/** Call a tool: its result, or why not. */
export async function callTool(c: Context, name: string, args: unknown): Promise<({ ok: true } & Result) | { ok: false; status: number; error: string }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { ok: false, status: 404, error: `no tool named ${name}` }
  const valid = inputs.get(name)!
  if (!valid(args ?? {})) return { ok: false, status: 400, error: `not valid arguments: ${ajv.errorsText(valid.errors, { dataVar: 'arguments' })}` }
  try {
    return { ok: true, ...(await tool.run(c, args ?? {})) }
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Refused ? err.message : `could not do it: ${(err as Error).message}` }
  }
}

/** An MCP server for one connection: the tools, nothing else. */
export function toolServer(c: Context): Server {
  const server = new Server({ name: 'forest-connections', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() as never }))
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const out = await callTool(c, req.params.name, req.params.arguments)
    return out.ok ? { content: [{ type: 'text', text: out.text }], structuredContent: out.data } : { isError: true, content: [{ type: 'text', text: out.error }] }
  })
  return server
}
