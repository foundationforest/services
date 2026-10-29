// Writing an entry in one of the person's folders, signed with its access key, to the hosts its
// profile entry names. Public: at `<kind>/<id>`, a kind every market defines, the body checked
// against its market with the markets package's checkEntry before anything is signed, and its
// subject, and the profile its post names, checked to be addresses, which the markets manual leaves
// to the standard. Locked: at any path but `profile` and `key/…`
// (the person's notes about access keys), the body the person's own and unchecked, locked to every
// key that may read the folder (lockKeysOf). Never `profile`: no access key writes it. Whether the
// key may write is the hosts' to say: each one's refusal is passed on, so a key the person removed
// hears `unlisted`.

import { type Body, FolderError, type SignedEntry, entry, filesOf, lockKeysOf, nextTime, publicKeyFromAddress, write } from '@foundationforest/folders'
import { lock } from '@foundationforest/folders/locked'
import type { Market } from '@foundationforest/markets'
import { folderAt, how, ownFolder, ownProfile, profileEntryOf } from '../act.ts'
import { refuse } from '../forest.ts'
import { KINDS, marketFile, markets } from '../markets.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'write'
export const title = 'Write an entry'
export const description =
  "Write an entry in one of the person's profiles' folders, named by its label, signed with the access key this login holds for it, and written to the profile's hosts; a null body deletes the entry there. Public (the main way): at <kind>/<id>, a kind the profile's market defines, such as post/<id> or review/<id>, the body as the market defines that kind (read the market first); a body that does not fit is refused, naming the field. A review names its subject and the post it is about. Locked: at any path but profile and key/…, the body the person's own and unchecked, locked to every key that may read the folder, with no files. Never profile. Answers what was written, or each host's refusal. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it writes as, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', required: true, description: "Where in that profile's folder: <kind>/<id>, such as post/maths; the id is lowercase letters, digits, dots, underscores and dashes." },
  { name: 'body', type: 'object', nullable: true, required: true, description: "What it says: the entry's fields, as the market defines them for its kind; null to delete the entry." },
  { name: 'locked', type: 'boolean', description: 'true: locked, so only the person and the keys that may read the folder open it.' },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * The role of the profile a review is about, read from its profile entry, when the body holds a field
 * the market keeps for some roles and that profile is in this market; else none, and checkEntry
 * leaves such a field unchecked.
 */
async function aboutRole(ctx: Ctx, market: Market, body: Body): Promise<string | undefined> {
  const fields = market.review ?? {}
  if (!Object.keys(body).some((name) => fields[name]?.roles) || !publicKeyFromAddress(body.subject)) return undefined
  const theirs = await folderAt(ctx, body.subject as string)
  const profile = theirs && profileEntryOf(theirs)
  return profile?.market === market.name && market.roles.some((r) => r.role === profile.role) ? (profile.role as string) : undefined
}

/** A public write of `body` at `path`, as `role` in `market`, checked; a null body removes it and is checked no further. */
async function checkPublic(ctx: Ctx, market: Market, role: string, path: string, body: Body | null): Promise<void> {
  const [kind, ...rest] = path.split('/')
  if (!KINDS.includes(kind!)) refuse(`${kind} is no kind of entry: the kinds are ${KINDS.join(', ')}, each at <kind>/<id>`)
  if (rest.length !== 1) refuse(`an entry of a kind sits at ${kind}/<id>, one segment after the kind`)
  if (body === null) return
  const why =
    markets.checkEntry(market.name, role, kind!, body, kind === 'review' ? await aboutRole(ctx, market, body) : undefined) ??
    (kind === 'post' || publicKeyFromAddress(body.subject) ? null : `subject is the address of the profile the ${kind} is about`) ??
    (kind !== 'review' || body.post === undefined || publicKeyFromAddress((body.post as string).split('/')[0]) ? null : "post is a post's address: <profile address>/post/<id>")
  if (why) refuse(why)
}

export async function run(args: Args, ctx: Ctx) {
  const me = await ownProfile(ctx, args.label as string)
  const path = args.path as string
  const locked = args.locked === true
  if (path === 'profile') refuse("no access key writes profile: the person changes their profile entry in their Forest app")
  const { view, profile } = await ownFolder(ctx, me)
  let body = args.body as Body | null
  if (locked) {
    if (path.split('/')[0] === 'key') refuse("key/… holds the person's notes about access keys, which no access key writes")
    if (body !== null && filesOf(body).length) refuse('a locked entry carries no files: anyone fetches a file by its hash')
    if (body !== null) body = await lock(body, lockKeysOf(profile)).catch((err: Error) => refuse(`not an entry: ${err.message}`))
  } else {
    const market: Market = typeof profile.market === 'string' ? marketFile(profile.market) : refuse(`${me.label}'s profile entry names no market, so a public entry has no kind to fit: lock it`)
    await checkPublic(ctx, market, text(profile.role), path, body)
  }
  let signed: SignedEntry
  try {
    signed = entry({ profile: me.address, key: me.key }, path, body, nextTime(Date.now(), view, path))
  } catch (err) {
    refuse(err instanceof FolderError ? `not an entry: ${err.message}` : String(err))
  }
  const outcomes = await write(view.hosts, [signed], how(ctx))
  const took = outcomes.filter((o) => o.results[0]?.ok)
  const refused = outcomes.filter((o) => !o.results[0]?.ok).map((o) => ({ host: o.host, why: o.results[0] ? `${o.results[0].error}: ${o.results[0].message ?? ''}`.trim() : (o.error ?? `answered ${o.status}`) }))
  if (!took.length) refuse(`no host took it: ${refused.map((r) => `${r.host} (${r.why})`).join('; ')}`)
  return { written: path, time: signed.time, ...(body === null && { deleted: true }), ...(locked && body !== null && { locked: true }), hosts: took.length, ...(refused.length && { refused }) }
}
