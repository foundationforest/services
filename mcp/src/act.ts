// Acting for the person: one of their profiles, by its label, from the call's pack, its access key
// made from its 32 bytes for this call alone; the folders a tool reads and writes, from their hosts;
// and the person's own addresses, which no answer of a tool that acts for them holds.
//
// Where someone else's folder is looked for: at the hosts the person's own profiles use, the
// pack's, and any a tool is given (a message's `host`), then every host its profile entry names. A
// folder on a host none of those reach is not found. Every host is reached with `hostFetch`, which
// reaches only public addresses unless told otherwise, since anyone can make a pack, and a profile
// entry names any host.

import { type Body, type ReadHow, type View, b64u, readFolder } from '@foundationforest/folders'
import { type KeyPair, accessKey } from '@foundationforest/keys'
import { isObject, refuse } from './forest.ts'
import type { Ctx } from './params.ts'

export type Own = {
  label: string
  /** The profile's address: what no answer holds. */
  address: string
  /** Where its folder is read from first: the pack's hosts for it. */
  hosts: string[]
  can: string[]
  /** Its access key, both halves, for this call. */
  key: KeyPair
}

/** How every host is reached: with the call's fetch, refusing a host that redirects. */
export const how = (ctx: Ctx): ReadHow => ({ fetch: ctx.hostFetch, redirect: 'error' })

/** One of the person's profiles this login acts in, by its label, or a refusal. */
export async function ownProfile(ctx: Ctx, label: string): Promise<Own> {
  const p = (await ctx.pack()).profiles.find((x) => x.label === label) ?? refuse(`${label} is not a profile this login acts in: my_profiles lists them`)
  return { label, address: p.address, hosts: p.hosts, can: p.can, key: await accessKey(b64u.decode(p.key)) }
}

/** A folder as its hosts serve it now: read from `hosts`, then every host its profile entry names. */
export function folderOf(ctx: Ctx, address: string, hosts: string[]): Promise<View> {
  return readFolder(hosts, address, Date.now(), how(ctx))
}

/** A view's current profile entry's body, or null when it has none. */
export const profileEntryOf = (view: View): Body | null => view.current.get('profile')?.entry.body ?? null

/** One of the person's own folders, read, its profile entry's pay addresses added to what answers leave out; refused when its hosts hold no profile entry. */
export async function ownFolder(ctx: Ctx, me: Own): Promise<{ view: View; profile: Body }> {
  const view = await folderOf(ctx, me.address, me.hosts)
  const profile = profileEntryOf(view) ?? refuse(`${me.label}'s hosts hold no profile entry for it`)
  if (isObject(profile.pay)) for (const [type, address] of Object.entries(profile.pay)) if (typeof address === 'string') ctx.own.set(address, `${me.label}'s ${type} pay address`)
  return { view, profile }
}

/** Someone's folder, looked for at the hosts the person's profiles use and at `more`; null when none holds its profile entry. */
export async function folderAt(ctx: Ctx, address: string, more: string[] = []): Promise<View | null> {
  const known = (await ctx.pack()).profiles.flatMap((p) => p.hosts)
  const view = await folderOf(ctx, address, [...new Set([...more, ...known])])
  return profileEntryOf(view) ? view : null
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `value` with each of `own`'s addresses, wherever it appears in a text, replaced by what stands for it there. */
export function leaveOut<T>(value: T, own: Map<string, string>): T {
  if (own.size === 0) return value
  const pattern = new RegExp([...own.keys()].map(escape).join('|'), 'gi')
  const instead = new Map([...own].map(([address, label]) => [address.toLowerCase(), label]))
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(pattern, (found) => instead.get(found.toLowerCase())!)
    if (Array.isArray(v)) return v.map(walk)
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k) as string, walk(x)]))
    return v
  }
  return walk(value) as T
}
