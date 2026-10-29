// The pack: what a person's app hands this copy at the end of a login, on the person's yes. It is
// this service's own format, which an app follows (README.md, The pack):
//
//   { request: <SHA-256 of the login request, lowercase hex>,
//     profiles: [{ label, address, hosts, key: <the access key's 64 bytes, base64url>, can }, …] }
//
// locked with folders/locked's lock to this copy's open key alone, and handed back as that
// envelope's text (the `private` of a locked body). The app made each access key (keys/'s
// newAccessKey) and listed it in that profile's entry with `can`; this copy holds the key only in
// the pack. The access token carries the pack as it came, so nothing is kept here: each call opens
// it in memory, with this copy's identity, and forgets it when the call ends.
//
// `request` ties the pack to one login: a pack seen on its way back, in a browser's history or a
// proxy's log, opens no other login, since every other login's request is another text.

import { createHash } from 'node:crypto'
import { CAN, MAX_HOSTS, b64u, normalizeOrigin, publicKeyFromAddress } from '@foundationforest/folders'
import { openLocked } from '@foundationforest/folders/locked'
import { isObject } from './forest.ts'

/** The longest pack taken, in characters: about 15 profiles with one host each, so the access token stays under Node's 16 KB of headers. */
export const MAX_PACK = 8192

/** One of the person's profiles, as the pack holds it. */
export type PackProfile = { label: string; address: string; hosts: string[]; key: string; can: string[] }
export type Pack = { request: string; profiles: PackProfile[] }

/** What the pack names a login request by: SHA-256 of its text, in lowercase hex. */
export const requestHash = (request: string) => createHash('sha256').update(request, 'utf8').digest('hex')

const B64U = /^[A-Za-z0-9_-]+$/
const HEX64 = /^[0-9a-f]{64}$/
const only = (value: { [key: string]: unknown }, fields: string[]) => Object.keys(value).every((k) => fields.includes(k)) && fields.every((k) => k in value)

/** Why `value` is not a pack, or null when it is one. */
export function packWrong(value: unknown): string | null {
  if (!isObject(value) || !only(value, ['request', 'profiles'])) return 'a pack is { request, profiles } and nothing else'
  if (typeof value.request !== 'string' || !HEX64.test(value.request)) return "its request is the login request's SHA-256, in lowercase hex"
  const profiles = value.profiles
  if (!Array.isArray(profiles) || profiles.length < 1) return 'it holds one profile or more'
  const labels = new Set<string>()
  const addresses = new Set<string>()
  for (const p of profiles as unknown[]) {
    if (!isObject(p) || !only(p, ['label', 'address', 'hosts', 'key', 'can'])) return 'each profile is { label, address, hosts, key, can } and nothing else'
    if (typeof p.label !== 'string' || !p.label || labels.has(p.label)) return 'each label is text, and each once'
    if (!publicKeyFromAddress(p.address) || addresses.has(p.address as string)) return "each address is a profile's, and each once"
    const hosts = p.hosts
    if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > MAX_HOSTS || new Set(hosts).size !== hosts.length || !hosts.every((h) => typeof h === 'string' && normalizeOrigin(h) === h)) {
      return `each profile's hosts are 1 to ${MAX_HOSTS} origins, each once`
    }
    if (typeof p.key !== 'string' || !B64U.test(p.key) || b64u.decode(p.key).length !== 64) return "each key is an access key's 64 bytes, in base64url"
    const can = p.can
    if (!Array.isArray(can) || new Set(can).size !== can.length || !can.every((c) => (CAN as readonly unknown[]).includes(c))) return `each can holds any of ${CAN.join(', ')}, each once`
    labels.add(p.label)
    addresses.add(p.address as string)
  }
  return null
}

/** The pack in `text`, opened with this copy's `identity` and checked; throws, saying why, if it is not one. */
export async function openPack(text: unknown, identity: string): Promise<Pack> {
  if (typeof text !== 'string' || !B64U.test(text) || text.length > MAX_PACK) throw new Error(`a pack is an envelope's text, in base64url, at most ${MAX_PACK} characters`)
  let body: unknown
  try {
    body = await openLocked({ private: text }, identity)
  } catch {
    throw new Error("the pack is not locked to this server's open key")
  }
  const wrong = packWrong(body)
  if (wrong) throw new Error(`not a pack: ${wrong}`)
  return body as Pack
}
