// What the read tools do: find a profile's folder on its hosts, and read what an index says.
// Nothing is kept between calls: every call reads again what it needs. No tool here signs: what
// acts for a person goes to their signer (relay.ts).
//
// A folder is always read from hosts, every signature checked (records' readProfile). What an index
// says is passed on as its own word: nothing here checks it.
//
// The start hosts are reached as they are: whoever runs this copy chose them. Any other host, one a
// profile's hosts record names, is reached only at a public address; no request follows a
// redirect; and a folder read stops after MAX_PAGES pages.

import { type Body, READ_TIMEOUT_MS, type Reach, type View, normalizeOrigin, publicKeyFromAddress, readProfile } from '@foundationforest/records'
import { publicFetch } from '@foundationforest/records/public'

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
export const MAX_JSON_BYTES = 4 * 1024 * 1024
/** The most pages one folder read takes, across all its hosts. */
export const MAX_PAGES = 100

/** What reading starts with: the hosts to look for a profile's hosts record on first, and the index. */
export type Context = { hosts: string[]; index: string }

/** Start hosts, each an origin as a hosts record writes it. */
export function hostsFrom(hosts: string[]): string[] {
  for (const host of hosts) if (normalizeOrigin(host) !== host) refuse(`${host} is not a host: give an origin, https://host[:port]`)
  return hosts
}

export const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)

/** How a call reaches hosts: the start hosts by the plain fetch, every other host by publicFetch, never after a redirect. */
function reach(start: string[]): Reach {
  const fetchFor = (input: string | URL | Request) => (start.includes(new URL(input instanceof Request ? input.url : input).origin) ? fetch : publicFetch)
  return { fetch: (input, init) => fetchFor(input)(input, init), redirect: 'error' }
}

/** A profile's folder, read from the start hosts and every host its hosts record names, each record checked. */
export async function folder(ctx: Context, address: string): Promise<View> {
  if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
  const how = reach(ctx.hosts)
  let pages = 0
  const counted: typeof fetch = (input, init) => (++pages > MAX_PAGES ? Promise.reject(new Error(`more than ${MAX_PAGES} pages`)) : how.fetch!(input, init))
  // By POST, so the address is not in a URL a front door logs.
  const view = await readProfile(ctx.hosts, address, Date.now(), { post: true, ...how, fetch: counted })
  if (pages > MAX_PAGES) refuse(`the hosts of ${address} served more than ${MAX_PAGES} pages; this reads no further`)
  if (!view.current.size) refuse(`no records for ${address} on ${ctx.hosts.join(', ')}: a profile none of these hosts holds is out of reach here`)
  return view
}

/** The current profile record's body, or null. */
export function profileOf(view: View): Body | null {
  return view.current.get('profile')?.record.body ?? null
}

/** JSON from a URL, read up to `max` bytes, with `fetchWith`. */
export async function readJson(url: string, fetchWith: typeof fetch = fetch, max = MAX_JSON_BYTES, timeout = READ_TIMEOUT_MS): Promise<unknown> {
  const res = await fetchWith(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' })
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
    if (size > max) {
      await reader.cancel()
      throw new Error(`sent more than ${max} bytes`)
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
