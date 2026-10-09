// The work behind every action: find a profile's folder on its hosts, check that a key may do what
// it is asked before anything is signed, then read, write, send, pull and open with the records
// library. Nothing is kept between calls but the public list of hosts to start from: every call
// reads again what it needs, and carries the keys it uses.
//
// A folder is always read from hosts, every signature checked (records' readProfile). An index is
// read only for markets and scores, and what it says is passed on as its own word: its JSON is its
// own format, with no signatures, so nothing here checks it.
//
// The start hosts are reached as they are: whoever runs this copy chose them. Any other host, one a
// profile's hosts record names, is reached only at a public address; no request follows a
// redirect; and a folder read, or an inbox pull, stops after MAX_PAGES pages.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { identityToRecipient } from 'age-encryption'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import {
  type Body,
  type Checked,
  IDENTITY,
  type Key,
  PATH,
  type PublishOutcome,
  READ_TIMEOUT_MS,
  type Reach,
  RecordError,
  type View,
  accessRecord,
  b64u,
  covers,
  deliver,
  inboxOf,
  isPrivate,
  keyFromPrivate,
  liveContent,
  messageId,
  nextTime,
  normalizeOrigin,
  pathCovers,
  publicKeyFromAddress,
  publish,
  pull,
  pullRequest,
  readProfile,
  unsignedMessageOf,
} from '../../standard/records/src/index.ts'
import { message, openMessage, openPrivate } from '../../standard/records/src/private.ts'
import { publicFetch } from '../../standard/records/src/public.ts'

/** A plain refusal: what could not be done, and why, in words a person reads. */
export class Refusal extends Error {
  override name = 'Refusal'
}
export function refuse(why: string): never {
  throw new Refusal(why)
}

/** What every action refuses with when the call carries no key for it. */
export const NO_KEY = 'no key for this; use request'

/** Access keys, written as a grant writes them: 32 bytes in base64url, or a read key's age identity. */
export type Keys = { write?: string; message?: string; read?: string }

/** What one call acts with: the settings the program started with, and what the call carries. */
export type Context = {
  /** The hosts to start from. The public list below when none is given. */
  hosts?: string[]
  /** The index read for markets and scores. No default. */
  index?: string
  /** The profile acted for, by its address. */
  profile?: string
  keys: Keys
  /** Where the default list of hosts is read; HOSTS_LIST unless a test says otherwise. */
  hostsList?: string
}

/** The hosts the foundation's index reads, as it publishes them: `{ about, hosts: [origin, …] }`. */
export const HOSTS_LIST = 'https://raw.githubusercontent.com/foundationforest/services/main/index/lists/hosts.json'
/** The most of an index's JSON, or of the hosts list, read: a page's worth on the reference host. */
const MAX_JSON_BYTES = 4 * 1024 * 1024
/** The most pages one folder read, or one inbox pull, takes, across all its hosts. */
export const MAX_PAGES = 100

// ---------------------------------------------------------------------------------------------
// Reaching hosts: forest's public fetch (records/src/public.ts), the one services' host reads
// senders' hosts with.

/** How a call reaches hosts: the start hosts by the plain fetch, every other host by publicFetch, never after a redirect. */
function reach(start: string[]): Reach {
  const fetchFor = (input: string | URL | Request) => (start.includes(new URL(input instanceof Request ? input.url : input).origin) ? fetch : publicFetch)
  return { fetch: (input, init) => fetchFor(input)(input, init), redirect: 'error' }
}

// ---------------------------------------------------------------------------------------------
// Finding a folder

const lists = new Map<string, Promise<string[]>>()

/** The hosts to start from: the ones given, or the public list, read once per process. */
export async function startHosts(ctx: Context): Promise<string[]> {
  if (ctx.hosts?.length) {
    for (const host of ctx.hosts) if (normalizeOrigin(host) !== host) refuse(`${host} is not a host: give an origin, https://host[:port]`)
    return ctx.hosts
  }
  const url = ctx.hostsList ?? HOSTS_LIST
  let list = lists.get(url)
  if (!list) {
    list = readHostsList(url)
    lists.set(url, list)
    list.catch(() => lists.delete(url))
  }
  return list
}

async function readHostsList(url: string): Promise<string[]> {
  try {
    const { hosts } = (await readJson(url)) as { hosts?: unknown }
    const usable = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && normalizeOrigin(h) === h) : []
    if (usable.length) return usable
  } catch {
    // Refused below.
  }
  return refuse('no hosts to start from; set --host')
}

/** A profile's folder, read from the start hosts and every host its hosts record names, each record checked. */
export async function folder(ctx: Context, address: string): Promise<View> {
  if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
  const hosts = await startHosts(ctx)
  const how = reach(hosts)
  let pages = 0
  const counted: typeof fetch = (input, init) => (++pages > MAX_PAGES ? Promise.reject(new Error(`more than ${MAX_PAGES} pages`)) : how.fetch!(input, init))
  // By POST, so the address is not in a URL a front door logs.
  const view = await readProfile(hosts, address, Date.now(), { post: true, ...how, fetch: counted })
  if (pages > MAX_PAGES) refuse(`the hosts of ${address} served more than ${MAX_PAGES} pages; this reads no further`)
  if (!view.current.size) {
    refuse(`no records for ${address} on ${hosts.join(', ')}: a profile on a host outside that list is out of reach until the host is added (--host)`)
  }
  return view
}

/** The profile this call acts for. */
function acting(ctx: Context): string {
  return ctx.profile ?? refuse('no profile given: set --profile, or give profile')
}

// ---------------------------------------------------------------------------------------------
// Keys: each checked before anything is signed, so a refusal is plain words, not a host's code.

/** A write or message key from its grant spelling. Never the profile's main key. */
function signingKey(text: string, scope: 'write' | 'message', profile: string): Key {
  let bytes: Uint8Array | undefined
  try {
    bytes = b64u.decode(text)
  } catch {
    // Refused below.
  }
  if (!bytes || bytes.length !== 32 || b64u.encode(bytes) !== text) refuse(`the ${scope} key is not 32 bytes in base64url, as a grant writes it`)
  const key = keyFromPrivate(bytes)
  if (key.address === profile) refuse(`that is ${profile}'s main key; give an access key. The main key stays on the person's device`)
  return key
}

/** A read key from its grant spelling, with its public half. Never the profile's inbox key. */
async function readKey(text: string, view: View): Promise<{ identity: string; recipient: string }> {
  if (!IDENTITY.test(text)) refuse('the read key is not an age identity, AGE-SECRET-KEY-PQ-1…, as a grant writes it')
  const recipient = await identityToRecipient(text)
  if (card(view)?.inboxKey === recipient) {
    refuse(`that is ${view.profile}'s inbox key; give a read key. The inbox key opens every message and grant, and stays on the person's device`)
  }
  return { identity: text, recipient }
}

/** The permissions record lists `key` with `scope`, and for a write key, covering `path`. */
function listed(view: View, key: string, scope: 'write' | 'message' | 'read', path?: string): void {
  const entry = view.access.find((k) => k.key === key)
  if (!entry) refuse(`this ${scope} key is not listed in ${view.profile}'s permissions record; use request`)
  if (!entry.scope) refuse(`this key is past in ${view.profile}'s permissions record: the owner removed it; use request`)
  if (entry.scope !== scope) refuse(`this key is listed as a ${entry.scope} key, not a ${scope} key; use request`)
  if (path !== undefined && !covers(entry, path)) {
    refuse(`this write key writes only under ${entry.paths ? entry.paths.join(', ') : 'any path but profile and grants'}, not at ${path}; use request`)
  }
}

function card(view: View): Body | null {
  return view.current.get('profile')?.record.body ?? null
}

// ---------------------------------------------------------------------------------------------
// Reading

/** Where a record is, when it was written and by which access key, if one. */
function about(c: Checked) {
  const { path, time, by } = c.record
  return { path, id: c.id, time, ...(by !== undefined && { by }) }
}

/** A record as an action shows it. A private body is only said to be there. */
function shown(c: Checked) {
  return { ...about(c), ...(isPrivate(c.record.body) ? { private: true } : { body: c.record.body }) }
}

/** What an index says of a market: its own JSON, passed on as its word. */
export async function market(ctx: Context, name: string) {
  const index = ctx.index ?? refuse('no index set; set --index')
  return { index, market: name, says: await fromIndex(index, `markets/${encodeURIComponent(name)}.json`) }
}

/** A profile's card, its offers and the reviews it wrote, from its hosts; and an index's summary of it, if one is set. */
export async function profile(ctx: Context, address: string) {
  const view = await folder(ctx, address)
  const live = liveContent(view)
  const under = (prefix: string) => [...live].filter(([path]) => pathCovers(prefix, path)).map(([, c]) => shown(c))
  const top = live.get('profile')
  let index: unknown = null
  // A down index never hides what the hosts serve.
  if (ctx.index) index = await fromIndex(ctx.index, `profiles/${address}.json`).catch((err: Error) => ({ unread: err.message }))
  return { address, hosts: view.hosts, card: top ? shown(top) : null, offers: under('offer'), reviews: under('review'), index }
}

/** The private records in the profile's folder this read key opens; `under`, a path prefix, narrows them. */
export async function privateRecords(ctx: Context, under?: string) {
  const text = ctx.keys.read ?? refuse(NO_KEY)
  const address = acting(ctx)
  const view = await folder(ctx, address)
  const { identity, recipient } = await readKey(text, view)
  listed(view, recipient, 'read')
  const locked = [...liveContent(view).values()].filter((c) => isPrivate(c.record.body) && (under === undefined || pathCovers(under, c.record.path)))
  const opened = []
  for (const c of locked) {
    try {
      opened.push({ ...about(c), body: await openPrivate(c.record.body!, identity) })
    } catch {
      // Not encrypted to this key.
    }
  }
  if (locked.length && !opened.length) refuse(`this read key opens none of the ${locked.length} private records in ${address}`)
  return { profile: address, opened, unopened: locked.length - opened.length }
}

/**
 * The messages to the profile, pulled from each of its hosts, each page in turn, a message on two
 * hosts shown once. `after` holds the cursors a pull returned, by host. With a read key the inbox
 * lists, each message is opened, and marked as a request when it is one: sent by the profile to
 * itself, by its main key or by a message key its permissions record lists, with a body
 * `requestIn` names an action for. Any other request body is a plain message. It stops after
 * MAX_PAGES pages in all; the cursors say where to pull again.
 */
export async function inbox(ctx: Context, after: { [host: string]: number } = {}, requestIn: (body: Body) => string | null = () => null) {
  const text = ctx.keys.message ?? refuse(NO_KEY)
  if (Object.values(after).some((cursor) => !Number.isSafeInteger(cursor) || cursor < 0)) refuse('after holds the cursors a pull returned: whole numbers, by host')
  const address = acting(ctx)
  const key = signingKey(text, 'message', address)
  const view = await folder(ctx, address)
  listed(view, key.address, 'message')
  let identity: string | undefined
  if (ctx.keys.read !== undefined) {
    const read = await readKey(ctx.keys.read, view)
    const box = inboxOf(card(view))
    if (!box || box === 'unsupported' || !box.readers?.includes(read.recipient)) {
      refuse(`this read key is not one of ${address}'s inbox readers, so no message is encrypted to it; use request`)
    }
    identity = read.identity
  }
  const itself = (m: { from: string; key?: string }) => m.from === address && (m.key === undefined || view.access.some((k) => k.key === m.key && k.scope === 'message'))
  const found = new Map<string, { id: string; from: string; time: number; key?: string; request?: string; body?: Body; unopened?: true }>()
  const cursors: { [host: string]: number } = {}
  const failed: Array<{ host: string; why: string }> = []
  const how = reach(await startHosts(ctx))
  let pages = 0
  for (const host of view.hosts) {
    try {
      for (let cursor = after[host] ?? 0; ; ) {
        if (++pages > MAX_PAGES) throw new Error(`stopped after ${MAX_PAGES} pages; pull again from its cursor`)
        const page = await pull(host, pullRequest({ key, profile: address }, cursor, Date.now()), how)
        for (const { message: m, id } of page.messages) {
          if (found.has(id)) continue
          let body: Body | undefined
          if (identity) body = (await openMessage(m, identity).catch(() => undefined))?.body
          const asked = body && itself(m) ? requestIn(body) : null
          found.set(id, { id, from: m.from, time: m.time, ...(m.key !== undefined && { key: m.key }), ...(asked && { request: asked }), ...(body ? { body } : { unopened: true as const }) })
        }
        cursors[host] = page.cursor
        if (page.cursor === cursor) break
        cursor = page.cursor
      }
    } catch (err) {
      failed.push({ host, why: (err as Error).message })
    }
  }
  if (!Object.keys(cursors).length) refuse(`no host answered the pull: ${failed.map((f) => `${f.host}: ${f.why}`).join('; ')}`)
  const messages = [...found.values()].sort((a, b) => a.time - b.time)
  return { profile: address, messages, cursors, ...(failed.length > 0 && { failed }) }
}

// ---------------------------------------------------------------------------------------------
// Writing

const ajv = new Ajv2020({ strict: true, allErrors: true })
formats.default(ajv)
const schema = (kind: string) => JSON.parse(readFileSync(new URL(`../../standard/records/schemas/${kind}.json`, import.meta.url), 'utf8'))
const shapes = { offer: ajv.compile(schema('offer')), review: ajv.compile(schema('review')) }

const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A body that fits its record shape (records/schemas/), its createdAt set if missing: kept from the version it replaces, else now. */
function shaped(kind: 'offer' | 'review', body: unknown, before?: Checked): Body {
  if (!isObject(body)) refuse(`the ${kind} is an object`)
  const was = before?.record.body?.createdAt
  const full = 'createdAt' in body ? body : { ...body, createdAt: typeof was === 'string' ? was : new Date().toISOString() }
  const fits = shapes[kind]
  if (!fits(full)) refuse(`the ${kind} does not fit its shape: ${ajv.errorsText(fits.errors, { dataVar: kind })}`)
  return full
}

/** The path for an id, or a fresh one: 16 random hex digits. */
export function pathFor(prefix: 'offer' | 'review', id?: string): string {
  const path = `${prefix}/${id ?? randomBytes(8).toString('hex')}`
  if (id !== undefined && (id.includes('/') || !PATH.test(path))) refuse('an id is lower-case letters, digits, dots, underscores and dashes, up to 64, starting with a letter or digit')
  return path
}

/**
 * Write one record with the write key: a new one where nothing counts yet (`new`), or a new
 * version, or a delete, of one an access key wrote (`existing`). The owner wins at a path it wrote,
 * so only the owner's app changes it.
 */
async function write(ctx: Context, path: string, kind: 'new' | 'existing', body: (before?: Checked) => Body | null) {
  const text = ctx.keys.write ?? refuse(NO_KEY)
  const address = acting(ctx)
  const key = signingKey(text, 'write', address)
  const view = await folder(ctx, address)
  listed(view, key.address, 'write', path)
  const before = view.current.get(path)
  if (before && before.record.by === undefined) refuse(`the owner wrote ${path}; only the owner's app can change it; use request`)
  const there = before !== undefined && before.record.body !== null
  if (kind === 'new' && there) refuse(`${path} is already there`)
  if (kind === 'existing' && !there) refuse(`nothing at ${path}`)
  if (!view.hosts.length) refuse(`${address} has no hosts record to write to`)
  const record = accessRecord(key, address, path, body(before), nextTime(Date.now(), view, path))
  return { profile: address, path, time: record.time, ...landed(await publish(view.hosts, [record], reach(await startHosts(ctx)))) }
}

/** Where a record or message landed; refused if no host took it. */
function landed(outcomes: PublishOutcome[]) {
  const why = (o: PublishOutcome) => o.error ?? ([o.results[0]?.error, o.results[0]?.message].filter(Boolean).join(': ') || `answered ${o.status}`)
  const hosts = outcomes.filter((o) => o.results[0]?.ok).map((o) => o.host)
  const refused = outcomes.filter((o) => !o.results[0]?.ok).map((o) => ({ host: o.host, why: why(o) }))
  if (!hosts.length) refuse(`no host took it: ${refused.map((r) => `${r.host}: ${r.why}`).join('; ')}`)
  return { hosts, ...(refused.length > 0 && { refused }) }
}

export const postOffer = async (ctx: Context, offer: unknown, id?: string) => write(ctx, pathFor('offer', id), 'new', () => shaped('offer', offer))
export const updateOffer = async (ctx: Context, id: string, offer: unknown) => write(ctx, pathFor('offer', id), 'existing', (before) => shaped('offer', offer, before))
export const removeOffer = async (ctx: Context, id: string) => write(ctx, pathFor('offer', id), 'existing', () => null)
export const postReview = async (ctx: Context, review: unknown, id?: string) => write(ctx, pathFor('review', id), 'new', () => shaped('review', review))

// ---------------------------------------------------------------------------------------------
// Messages

/** A message to another profile's inbox, signed by the message key for the profile. */
export async function send(ctx: Context, to: string, body: Body) {
  return sendFrom(ctx, to, body)
}

/** A request, `{ request: <action>, ...its parameters }`, to the profile's own inbox, for the person's app to show. */
export async function request(ctx: Context, body: Body) {
  return sendFrom(ctx, null, body)
}

/** Encrypt, sign and deliver `body` to `to`'s inbox; to the profile's own when `to` is null. */
async function sendFrom(ctx: Context, recipient: string | null, body: Body) {
  const text = ctx.keys.message ?? refuse(NO_KEY)
  const address = acting(ctx)
  const to = recipient ?? address
  // A grant carries a key. This tool hands out none: the keys it holds are the person's to give.
  if ('grant' in body) refuse('a message from here never carries a grant: this tool hands out no keys')
  const key = signingKey(text, 'message', address)
  const mine = await folder(ctx, address)
  listed(mine, key.address, 'message')
  const host = mine.hosts[0] ?? refuse(`${address} has no hosts record, so no host can check this message key`)
  const theirs = to === address ? mine : await folder(ctx, to)
  let signed
  try {
    signed = await message({ key, from: address, host }, to, body, Date.now(), card(theirs) ?? {})
  } catch (err) {
    if (err instanceof RecordError && err.code === 'no_inbox') {
      refuse(to === address ? `${address} has no inbox, so nothing can reach the person this way` : `${to} has no inbox this tool can read; nothing can be sent there`)
    }
    throw err
  }
  return { from: address, to, id: messageId(unsignedMessageOf(signed)), ...landed(await deliver(theirs.hosts, [signed], reach(await startHosts(ctx)))) }
}

// ---------------------------------------------------------------------------------------------

/** JSON from a URL, read up to MAX_JSON_BYTES. */
async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`${url} answered ${res.status}`)
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
      throw new Error(`${url} sent more than ${MAX_JSON_BYTES} bytes`)
    }
    parts.push(value)
  }
}

async function fromIndex(index: string, path: string): Promise<unknown> {
  try {
    return await readJson(`${index.replace(/\/+$/, '')}/${path}`)
  } catch (err) {
    return refuse(`the index ${index} gave nothing for ${path}: ${(err as Error).message}`)
  }
}
