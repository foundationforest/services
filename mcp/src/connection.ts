// The connection: where a person's app keeps, for one AI app, the access keys this copy acts with,
// and what the AI app's token points to. It is this service's own format, which an app follows
// (README.md, The connection):
//
// - the connection folder: an ordinary folder on the person's hosts, named by a key the app makes
//   at random. Each of its locked entries is locked to that key's open key and this copy's:
//     connection:  { name: <the AI app's name>, secret: <32 random bytes, base64url> }
//     access/<id>: { label, address, hosts, key: <the access key's 64 bytes, base64url> }, one a
//                  profile, at a random id;
// - the pointer, what the app hands /connected and the token carries, locked to this copy's open
//   key alone: { request: <SHA-256 of the login request>, folder: <its address>, hosts, secret }.
//
// Each call that acts for the person opens the pointer, reads the folder from its hosts, opens its
// connection entry and checks that its secret is the pointer's, then opens each access entry; it
// keeps none of it after the call. The secret is what ties a pointer to the folder's own app: this
// copy's open key is public, so anyone can lock a pointer naming someone's folder, and only the
// keys the entry is locked to read the secret in it.
//
// `request` ties the pointer to one login: a pointer seen on its way back, in a browser's history
// or a proxy's log, opens no other login, since every other login's request is another text.

import { createHash, timingSafeEqual } from 'node:crypto'
import { type Body, MAX_HOSTS, type ReadHow, b64u, isLocked, normalizeOrigin, publicKeyFromAddress, readFolder } from '@foundationforest/folders'
import { openLocked } from '@foundationforest/folders/locked'
import { isObject } from './forest.ts'

/** The longest pointer taken, in characters: one envelope, to one key, holding up to 8 hosts, so the access token stays under Node's 16 KB of headers. */
export const MAX_POINTER = 4096

/** What the token carries, opened. */
export type Pointer = { request: string; folder: string; hosts: string[]; secret: string }
/** One of the person's profiles, as its access entry holds it. */
export type ConnectionProfile = { label: string; address: string; hosts: string[]; key: string }
/** A connection, opened: the AI app's name, and each profile it acts in, in the order of their labels. */
export type Connection = { name: string; profiles: ConnectionProfile[] }

/** What the pointer names a login request by: SHA-256 of its text, in lowercase hex. */
export const requestHash = (request: string) => createHash('sha256').update(request, 'utf8').digest('hex')

const B64U = /^[A-Za-z0-9_-]+$/
const HEX64 = /^[0-9a-f]{64}$/
const only = (value: Body, fields: string[]) => Object.keys(value).every((k) => fields.includes(k)) && fields.every((k) => k in value)
const isHosts = (hosts: unknown): hosts is string[] =>
  Array.isArray(hosts) && hosts.length >= 1 && hosts.length <= MAX_HOSTS && new Set(hosts).size === hosts.length && hosts.every((h) => typeof h === 'string' && normalizeOrigin(h) === h)
/** Whether `value` is `length` bytes in base64url: text of a length no bytes give does not decode. */
function isBytes(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !B64U.test(value)) return false
  try {
    return b64u.decode(value).length === length
  } catch {
    return false
  }
}

/** Why `value` is not a pointer, or null when it is one. */
export function pointerWrong(value: unknown): string | null {
  if (!isObject(value) || !only(value, ['request', 'folder', 'hosts', 'secret'])) return 'a pointer is { request, folder, hosts, secret } and nothing else'
  if (typeof value.request !== 'string' || !HEX64.test(value.request)) return "its request is the login request's SHA-256, in lowercase hex"
  if (!publicKeyFromAddress(value.folder)) return "its folder is a folder's address"
  if (!isHosts(value.hosts)) return `its hosts are 1 to ${MAX_HOSTS} origins, each once`
  if (!isBytes(value.secret, 32)) return 'its secret is 32 bytes, in base64url'
  return null
}

/** The pointer in `text`, opened with this copy's `identity` and checked; throws, saying why, if it is not one. */
export async function openPointer(text: unknown, identity: string): Promise<Pointer> {
  if (typeof text !== 'string' || !B64U.test(text) || text.length > MAX_POINTER) throw new Error(`a pointer is an envelope's text, in base64url, at most ${MAX_POINTER} characters`)
  let body: unknown
  try {
    body = await openLocked({ private: text }, identity)
  } catch {
    throw new Error("the pointer is not locked to this server's open key")
  }
  const wrong = pointerWrong(body)
  if (wrong) throw new Error(`not a pointer: ${wrong}`)
  return body as Pointer
}

const isHead = (v: unknown): v is { name: string; secret: string } => isObject(v) && only(v, ['name', 'secret']) && typeof v.name === 'string' && isBytes(v.secret, 32)
const isAccess = (v: unknown): v is ConnectionProfile =>
  isObject(v) && only(v, ['label', 'address', 'hosts', 'key']) && typeof v.label === 'string' && v.label !== '' && !!publicKeyFromAddress(v.address) && isHosts(v.hosts) && isBytes(v.key, 64)

/** A locked body, opened with `identity`; null when it is not locked, or does not open. */
async function opened(body: Body | null | undefined, identity: string): Promise<unknown> {
  if (!isLocked(body)) return null
  try {
    return await openLocked(body, identity)
  } catch {
    return null
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The connection a pointer names, read from its hosts now and opened with this copy's `identity`:
 * 'gone' when its folder holds no connection entry this copy opens with the pointer's secret
 * (deleted, never written, or someone else's); `unreached` when none of its hosts answered.
 */
export async function readConnection(pointer: Pointer, identity: string, how: ReadHow): Promise<Connection | 'gone' | { unreached: string }> {
  const view = await readFolder(pointer.hosts, pointer.folder, Date.now(), how)
  if (view.current.size === 0 && view.failed.length) return { unreached: `the connection's hosts did not answer: ${view.failed.map((f) => `${f.host} (${f.error})`).join('; ')}` }
  const head = await opened(view.current.get('connection')?.entry.body, identity)
  if (!isHead(head) || !same(head.secret, pointer.secret)) return 'gone'
  // In path order, so every call counts the same ones. One that does not open or fit, or names a
  // profile already named, counts for nothing: one bad entry from an app does not end the rest.
  const paths = [...view.current.keys()].filter((p) => p.startsWith('access/')).sort()
  const bodies = await Promise.all(paths.map((p) => opened(view.current.get(p)!.entry.body, identity)))
  const profiles: ConnectionProfile[] = []
  for (const p of bodies) if (isAccess(p) && !profiles.some((q) => q.label === p.label || q.address === p.address)) profiles.push(p)
  return { name: head.name, profiles: profiles.sort((a, b) => (a.label < b.label ? -1 : 1)) }
}
