// The work behind every tool: find a profile's folder on its hosts, check that a key is listed for
// what it is asked before anything is signed, then write, deliver and pull with the standard's
// records library; and read what an index says. Nothing is kept between calls: every call reads
// again what it needs, and carries the keys it uses.
//
// A folder is always read from hosts, every signature checked (records' readProfile). What an index
// says is passed on as its own word: nothing here checks it.
//
// The start hosts are reached as they are: whoever runs this copy chose them. Any other host, one a
// profile's hosts record names, is reached only at a public address; no request follows a
// redirect; and a folder read, or an inbox pull, stops after MAX_PAGES pages.

import { randomBytes } from 'node:crypto'
import { type AccessKey, type ReadKey, accessKey, readKey } from '@foundationforest/keys'
import {
  type Body,
  CanonicalError,
  INBOX,
  PATH,
  type PublishOutcome,
  READ_TIMEOUT_MS,
  type Reach,
  RecordError,
  type View,
  accessRecord,
  actsOnInbox,
  b64u,
  covers,
  deliver,
  messageId,
  nextTime,
  normalizeOrigin,
  publicKeyFromAddress,
  publish,
  pull,
  pullRequest,
  readProfile,
  unsignedMessageOf,
} from '@foundationforest/records'
import { message, openMessage } from '@foundationforest/records/private'
import { publicFetch } from '@foundationforest/records/public'
import type { Args } from './params.ts'

/** A plain refusal: what could not be done, and why, in words a person reads. */
export class Refusal extends Error {
  override name = 'Refusal'
}
export function refuse(why: string): never {
  throw new Refusal(why)
}

/** The foundation's host, where a profile's hosts record is looked for first unless told otherwise. */
export const HOST = 'https://host.forest.foundation'
/** The foundation's index, read for markets' posts, search, checks and ratings unless told otherwise. */
export const INDEX = 'https://index.forest.foundation'
/** The most of an index's JSON read: a page's worth on the reference host. */
const MAX_JSON_BYTES = 4 * 1024 * 1024
/** The most pages one folder read, or one inbox pull, takes, across all its hosts. */
export const MAX_PAGES = 100

/** What a run starts with: the hosts to look for a profile's hosts record on first, and the index. */
export type Context = { hosts: string[]; index: string }

/** Start hosts, each an origin as a hosts record writes it. */
export function hostsFrom(hosts: string[]): string[] {
  for (const host of hosts) if (normalizeOrigin(host) !== host) refuse(`${host} is not a host: give an origin, https://host[:port]`)
  return hosts
}

const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)

/** How a call reaches hosts: the start hosts by the plain fetch, every other host by publicFetch, never after a redirect. */
function reach(start: string[]): Reach {
  const fetchFor = (input: string | URL | Request) => (start.includes(new URL(input instanceof Request ? input.url : input).origin) ? fetch : publicFetch)
  return { fetch: (input, init) => fetchFor(input)(input, init), redirect: 'error' }
}

// ---------------------------------------------------------------------------------------------
// Folders

/** A profile's folder, read from the start hosts and every host its hosts record names, each record checked. */
export async function folder(ctx: Context, address: string): Promise<View> {
  if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
  const how = reach(ctx.hosts)
  let pages = 0
  const counted: typeof fetch = (input, init) => (++pages > MAX_PAGES ? Promise.reject(new Error(`more than ${MAX_PAGES} pages`)) : how.fetch!(input, init))
  // By POST, so the address is not in a URL a front door logs.
  const view = await readProfile(ctx.hosts, address, Date.now(), { post: true, ...how, fetch: counted })
  if (pages > MAX_PAGES) refuse(`the hosts of ${address} served more than ${MAX_PAGES} pages; this reads no further`)
  if (!view.current.size) refuse(`no records for ${address} on ${ctx.hosts.join(', ')}: a profile none of these hosts holds is out of reach until one of its hosts is given (--host)`)
  return view
}

/** The current profile record's body, or null. */
export function profileOf(view: View): Body | null {
  return view.current.get('profile')?.record.body ?? null
}

/** The profile a call acts for. */
export function acting(args: Args): string {
  const address = (args.profile as string | undefined) ?? refuse("no profile given: give profile, the address the person's app gives")
  if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
  return address
}

// ---------------------------------------------------------------------------------------------
// Keys: each checked before anything is signed, so a refusal is plain words, not a host's code.

function bytesOf(text: string, name: string): Uint8Array {
  let bytes: Uint8Array | undefined
  try {
    bytes = b64u.decode(text)
  } catch {
    // Refused below.
  }
  if (!bytes || bytes.length !== 32 || b64u.encode(bytes) !== text) refuse(`the ${name} is its 32 bytes in base64url, 43 characters, as the person's app gives it`)
  return bytes
}

/** The write key a call carries. */
function writer(args: Args): AccessKey {
  const text = (args.writeKey as string | undefined) ?? refuse("this needs the write key (writeKey), as the person's app gives it")
  return accessKey(bytesOf(text, 'write key'))
}

/** The read key a call carries: a signing key that pulls, and an identity that opens. */
async function reader(args: Args): Promise<ReadKey> {
  const text = (args.readKey as string | undefined) ?? refuse("this needs the read key (readKey), as the person's app gives it")
  return readKey(bytesOf(text, 'read key'))
}

/**
 * The profile's permissions record lists `key` with `scope`, its paths covering `path`, or the
 * call is refused here, before anything is signed or sent. One refusal for every way it is not:
 * not listed, removed, listed with the other scope, or listed for other paths.
 */
function listed(view: View, key: string, scope: 'write' | 'read', path: string): void {
  const ok = view.access.some((k) => k.key === key && k.scope === scope && (path === INBOX ? actsOnInbox(k) : covers(k, path)))
  if (!ok) refuse(`this key is not listed for ${path}`)
}

// ---------------------------------------------------------------------------------------------
// Writing

/** The path for an id, or a fresh one: 16 random hex digits. */
export function pathFor(prefix: 'offer' | 'review', id?: string): string {
  const path = `${prefix}/${id ?? randomBytes(8).toString('hex')}`
  if (id !== undefined && (id.includes('/') || !PATH.test(path))) refuse('an id is lowercase letters, digits, dots, underscores and dashes, up to 64, starting with a letter or digit')
  return path
}

/** A record or a message made from a body records cannot take is refused in its words. */
async function signing<T>(make: () => Promise<T>): Promise<T> {
  try {
    return await make()
  } catch (err) {
    if (err instanceof CanonicalError || (err instanceof RecordError && ['canonical', 'body', 'shape'].includes(err.code))) refuse(`the body cannot be signed: ${err.message}`)
    throw err
  }
}

/**
 * Write at `path` with the write key, once its permissions are checked: `post` where nothing
 * counts yet, `update` or `remove` where an access key wrote. The main key wins at a path it
 * wrote, so only the person's app changes it. `bodyFor` checks the body against the profile's
 * market; it runs after the key is found listed, and not for a remove.
 */
export async function writeAt(args: Args, ctx: Context, path: string, action: 'post' | 'update' | 'remove', bodyFor: (view: View) => Promise<Body>) {
  const key = writer(args)
  const address = acting(args)
  const view = await folder(ctx, address)
  listed(view, key.address, 'write', path)
  const before = view.current.get(path)
  if (before && before.record.by === undefined) refuse(`the person's main key wrote ${path}, and the main key wins: only their app can change it; use ask`)
  const there = before !== undefined && before.record.body !== null
  if (action === 'post' && there) refuse(`${path} is already there; update it`)
  if (action !== 'post' && !there) refuse(`nothing at ${path}`)
  if (!view.hosts.length) refuse(`${address} has no hosts record, so there is nowhere to write`)
  const body = action === 'remove' ? null : await bodyFor(view)
  const record = await signing(async () => accessRecord(key, address, path, body, nextTime(Date.now(), view, path)))
  return { profile: address, path, address: `${address}/${path}`, time: record.time, ...landed(await publish(view.hosts, [record], reach(ctx.hosts))) }
}

/** Where a record or message landed; refused if no host took it. */
function landed(outcomes: PublishOutcome[]) {
  const why = (o: PublishOutcome) => o.error ?? ([o.results[0]?.error, o.results[0]?.message].filter(Boolean).join(': ') || `answered ${o.status}`)
  const hosts = outcomes.filter((o) => o.results[0]?.ok).map((o) => o.host)
  const refused = outcomes.filter((o) => !o.results[0]?.ok).map((o) => ({ host: o.host, why: why(o) }))
  if (!hosts.length) refuse(`no host took it: ${refused.map((r) => `${r.host}: ${r.why}`).join('; ')}`)
  return { hosts, ...(refused.length > 0 && { refused }) }
}

// ---------------------------------------------------------------------------------------------
// Messages

/** A copy, in the profile's own inbox, of a message it sent to `to`: `{ sent, to }`. */
const copyOf = (body: Body, to: string): Body => ({ sent: body, to })

/** Whom a copy's message went to, when `body` is one: `sent`, an object, and `to`, an address, and nothing else. */
function sentTo(body: Body): string | null {
  const { sent, to, ...rest } = body
  return isObject(sent) && typeof to === 'string' && publicKeyFromAddress(to) && !Object.keys(rest).length ? to : null
}

/**
 * A message to `to`'s inbox, or the profile's own when `to` is null: the body `bodyFor` gives,
 * sealed by the records library to the inbox key and the readers `to`'s profile record names,
 * and signed by the write key for the profile, naming its first host, where a receiving host
 * checks the key. The write key must be listed for the inbox. With `copy`, the same body then
 * goes to the profile's own inbox too, marked as sent, so the person sees what was said in their
 * name.
 */
export async function deliverAs(args: Args, ctx: Context, recipient: string | null, bodyFor: (mine: View) => Promise<Body>, copy = false) {
  const key = writer(args)
  const address = acting(args)
  const mine = await folder(ctx, address)
  listed(mine, key.address, 'write', INBOX)
  const host = mine.hosts[0] ?? refuse(`${address} has no hosts record, so no host can check the write key`)
  const body = await bodyFor(mine)
  const to = recipient ?? address
  const theirs = to === address ? mine : await folder(ctx, to)
  const sender = { key, from: address, host }
  const time = Date.now()
  const how = reach(ctx.hosts)
  const signed = await signing(async () => {
    try {
      return await message(sender, to, body, time, profileOf(theirs) ?? {})
    } catch (err) {
      if (err instanceof RecordError && err.code === 'no_inbox') {
        refuse(to === address ? `${address} declares no inbox, so nothing reaches the person this way` : `${to} declares no inbox this tool can read; nothing can be sent there`)
      }
      throw err
    }
  })
  const sent = { from: address, to, id: messageId(unsignedMessageOf(signed)), ...landed(await deliver(theirs.hosts, [signed], how)) }
  if (!copy || to === address) return sent
  // The message is already sent, so a copy that does not land is said, not refused: a refusal
  // would have it sent again. A message to its own inbox skips its senders, once and maxBytes.
  try {
    const own = await message(sender, address, copyOf(body, to), time, profileOf(mine) ?? {})
    return { ...sent, copy: { id: messageId(unsignedMessageOf(own)), ...landed(await deliver(mine.hosts, [own], how)) } }
  } catch (err) {
    const why = err instanceof RecordError && err.code === 'no_inbox' ? `${address} declares no inbox, so the person gets no copy` : (err as Error).message
    return { ...sent, copy: { unsent: why } }
  }
}

export type Pulled = { id: string; from: string; time: number; key?: string; sent?: string; request?: string; body?: Body; unopened?: true }

/**
 * The messages to the profile, pulled from each of its hosts with the read key, each page in turn,
 * a message on two hosts shown once, each opened with the read key's identity when it is sealed to
 * it. A message the profile sent itself, by its main key or a write key its permissions record
 * lists, shows as sent when it is a copy (`sent`, whom it went to, and `body`, what it said), or
 * is marked as the request `requestOf` names, if any. `after` holds the cursors a pull
 * returned, by host. It stops after MAX_PAGES pages in all; the cursors say where to pull again.
 */
export async function pullAs(args: Args, ctx: Context, after: { [host: string]: number }, requestOf: (body: Body) => string | null) {
  const key = await reader(args)
  if (Object.values(after).some((cursor) => !Number.isSafeInteger(cursor) || cursor < 0)) refuse('after holds the cursors a pull returned: whole numbers, by host')
  const address = acting(args)
  const view = await folder(ctx, address)
  listed(view, key.address, 'read', INBOX)
  const itself = (m: { from: string; key?: string }) => m.from === address && (m.key === undefined || view.access.some((k) => k.key === m.key && k.scope === 'write'))
  const found = new Map<string, Pulled>()
  const cursors: { [host: string]: number } = {}
  const failed: Array<{ host: string; why: string }> = []
  const how = reach(ctx.hosts)
  let pages = 0
  for (const host of view.hosts) {
    try {
      for (let cursor = after[host] ?? 0; ; ) {
        if (++pages > MAX_PAGES) throw new Error(`stopped after ${MAX_PAGES} pages; pull again from its cursor`)
        const page = await pull(host, pullRequest({ key, profile: address }, cursor, Date.now()), how)
        for (const { message: m, id } of page.messages) {
          if (found.has(id)) continue
          const body = (await openMessage(m, key.identity).catch(() => undefined))?.body
          const own = body !== undefined && itself(m)
          const to = own ? sentTo(body) : null
          const asked = own && !to ? requestOf(body) : null
          const shown = to ? { sent: to, body: body!.sent as Body } : asked ? { request: asked, body: body! } : body ? { body } : { unopened: true as const }
          found.set(id, { id, from: m.from, time: m.time, ...(m.key !== undefined && { key: m.key }), ...shown })
        }
        cursors[host] = page.cursor
        if (page.cursor === cursor) break
        cursor = page.cursor
      }
    } catch (err) {
      failed.push({ host, why: (err as Error).message })
    }
  }
  if (!Object.keys(cursors).length) refuse(`no host answered the pull: ${failed.map((f) => `${f.host}: ${f.why}`).join('; ') || `${address} has no hosts record`}`)
  const messages = [...found.values()].sort((a, b) => a.time - b.time)
  return { profile: address, messages, cursors, ...(failed.length > 0 && { failed }) }
}

// ---------------------------------------------------------------------------------------------
// The index

/** JSON from a URL, read up to MAX_JSON_BYTES. */
async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`answered ${res.status}`)
  }
  const parts: Uint8Array[] = []
  let size = 0
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return JSON.parse(Buffer.concat(parts).toString('utf8'))
    size += value.length
    if (size > MAX_JSON_BYTES) {
      await reader.cancel()
      throw new Error(`sent more than ${MAX_JSON_BYTES} bytes`)
    }
    parts.push(value)
  }
}

/** What the index says at `path`, passed on as its word, with where it was read; refused when it says nothing. */
export async function fromIndex(ctx: Context, path: string): Promise<Body> {
  const url = `${ctx.index.replace(/\/+$/, '')}/${path}`
  try {
    const says = await readJson(url)
    if (!isObject(says)) throw new Error('answered something other than a JSON object')
    return { url, ...says }
  } catch (err) {
    return refuse(`the index gave nothing for ${url}: ${(err as Error).message}`)
  }
}

/** The fields `keep` of what the index says at `path`; or why it said nothing, so a down index never hides what the hosts gave. */
export async function indexSays(ctx: Context, path: string, keep: string[]): Promise<Body> {
  try {
    const says = await fromIndex(ctx, path)
    return Object.fromEntries(['url', ...keep].filter((k) => k in says).map((k) => [k, says[k]!]))
  } catch (err) {
    return { url: `${ctx.index.replace(/\/+$/, '')}/${path}`, unread: (err as Error).message }
  }
}
