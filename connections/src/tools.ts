// The two tools an assistant gets on a connection: post an offer, post a review. Each record is
// signed by the connection's access key, never the main key, and posted to every host the profile's
// own hosts record names (forest/records/README.md, "Access keys" and "Apps that write records").
//
// Before signing, the profile is read where it lives: from the hosts this service looks at first,
// then every host its hosts record names (forest's `readProfile`). The record goes out only if the
// profile's current permissions record lists this access key for its path now, the main key
// has not written there (the owner wins), and the body fits forest's shape for it. The shapes are
// forest's own JSON Schemas, served to the assistant as each tool's input.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { type Body, allowsArrival, keyFromPrivate, nextTime, publish, readProfile, accessRecord } from '../../forest/records/src/index.ts'

import { FOREST } from './paths.ts'

const KINDS = { offer: 'post_offer', review: 'post_review' } as const
type Kind = keyof typeof KINDS

const schema = (kind: Kind) => JSON.parse(readFileSync(join(FOREST, 'records/schemas', `${kind}.json`), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)
const validators = { offer: ajv.compile(schema('offer')), review: ajv.compile(schema('review')) }

/** A record id: a path segment, as forest's paths allow. */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const newId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

/** The tool's input: an optional id for the record's path, and the record, in forest's own shape. */
function inputSchema(kind: Kind): Record<string, unknown> {
  const { $schema: _s, title: _t, ...shape } = schema(kind)
  return {
    type: 'object',
    required: [kind],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: ID.source, description: `The record's id: it is posted at ${kind}/<id>. Posting the same id again replaces the record. Left out, a new one is made.` },
      [kind]: { ...shape, description: `${shape.description} \`createdAt\` is filled in with now when left out.` },
    },
  }
}

export type ToolConnection = { profile: string; accessKey: Uint8Array }

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** Post one record for the connection's profile. */
export async function post(connection: ToolConnection, kind: Kind, args: Record<string, unknown>, hosts: string[], now = Date.now()): Promise<CallToolResult> {
  const id = args.id === undefined ? newId() : args.id
  if (typeof id !== 'string' || !ID.test(id)) return fail(`id must be a path segment: ${ID.source}`)
  const given = args[kind]
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return fail(`${kind} must be an object`)
  const body = { createdAt: new Date(now).toISOString(), ...given } as Body
  const validate = validators[kind]
  if (!validate(body)) return fail(`not a valid ${kind}: ${ajv.errorsText(validate.errors, { dataVar: kind })}`)

  const key = keyFromPrivate(connection.accessKey)
  const path = `${kind}/${id}`
  const view = await readProfile(hosts, connection.profile, now)
  if (!view.hosts.length) return fail('the profile names no hosts: its app has not published its hosts record where this service looks')
  if (view.current.get(path)?.record.by === undefined && view.current.has(path)) return fail(`the profile's main key wrote ${path}; an access key cannot replace it. Use another id.`)
  const record = accessRecord(key, connection.profile, path, body, nextTime(now, view, path))
  if (!allowsArrival(view.access, record)) {
    return fail(`this connection's access key (${key.address}) is not on the profile's permissions list for ${path}, or it is revoked. The person adds it in their app, or connects again.`)
  }
  const outcomes = await publish(view.hosts, [record])
  const took = outcomes.filter((o) => o.results[0]?.ok)
  const report = outcomes.map((o) => ({ host: o.host, ok: o.results[0]?.ok ?? false, error: o.error ?? o.results[0]?.error ?? null }))
  if (!took.length) return fail(`no host took the record: ${JSON.stringify(report)}`)
  return {
    content: [{ type: 'text', text: `Posted ${path} for ${connection.profile} to ${took.length} of ${outcomes.length} hosts.` }],
    structuredContent: { profile: connection.profile, path, id: took[0]!.results[0]!.id ?? null, time: record.time, hosts: report },
  }
}

/** An MCP server for one connection: its two tools, nothing else. */
export function toolServer(connection: ToolConnection, hosts: string[]): Server {
  const server = new Server({ name: 'forest-connections', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: KINDS.offer,
        title: 'Post an offer',
        description: `Post an offer or a request for the profile this connection writes for (${connection.profile}), signed by its access key, to the hosts its profile names. The market and side are the profile's own.`,
        inputSchema: inputSchema('offer') as never,
      },
      {
        name: KINDS.review,
        title: 'Post a review',
        description: `Post a review of another profile, by the profile this connection writes for (${connection.profile}), signed by its access key. Name the deal it is about with dealId: the escrow's address.`,
        inputSchema: inputSchema('review') as never,
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const kind = (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k] === req.params.name)
    if (!kind) return fail(`no tool named ${req.params.name}`)
    try {
      return await post(connection, kind, req.params.arguments ?? {}, hosts)
    } catch (err) {
      return fail(`could not post: ${(err as Error).message}`)
    }
  })
  return server
}
