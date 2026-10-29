// Writing an entry in one of the person's folders, signed with its access key, to the hosts its
// profile entry names. Public: at a path of a kind its market defines, the body checked against that
// kind's fields (check.ts) before anything is signed. Locked: at any path but `profile` and `key/…`
// (the person's notes about access keys), the body the person's own and unchecked, locked to every
// key that may read the folder (lockKeysOf). Never `profile`: no access key writes it. Whether the
// key may write is the hosts' to say: each one's refusal is passed on, so a key the person removed
// hears `unlisted`.

import { type Body, FolderError, type SignedEntry, entry, filesOf, lockKeysOf, nextTime, write } from '@foundationforest/folders'
import { lock } from '@foundationforest/folders/locked'
import { folderAt, how, ownFolder, ownProfile, profileEntryOf } from '../act.ts'
import { checkWrite } from '../check.ts'
import { refuse } from '../forest.ts'
import { type Market, marketFile } from '../markets.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'write'
export const title = 'Write an entry'
export const description =
  "Write an entry in one of the person's profiles' folders, named by its label, signed with the access key this login holds for it, and written to the profile's hosts; a null body deletes the entry there. Public (the main way): at <kind>/<id>, a kind the profile's market defines, such as offer/<id> or review/<id>, the body as the market defines that kind (read the market first); a body that does not fit is refused, naming the field. A review names its subject, the offer it is about, and may name its evidence, <chain>:<id>, such as the payment for it. Locked: at any path but profile and key/…, the body the person's own and unchecked, locked to every key that may read the folder, with no files. Never profile. Answers what was written, or each host's refusal. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it writes as, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', required: true, description: "Where in that profile's folder: <kind>/<id>, such as offer/maths; the id is lowercase letters, digits, dots, underscores and dashes." },
  { name: 'body', type: 'object', nullable: true, required: true, description: "What it says: the entry's fields, as the market defines them for its kind; null to delete the entry." },
  { name: 'locked', type: 'boolean', description: 'true: locked, so only the person and the keys that may read the folder open it.' },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

const text = (v: unknown) => (typeof v === 'string' ? v : '')

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
    await checkWrite(market, text(profile.role), path, body, async (subject) => {
      const theirs = await folderAt(ctx, subject)
      const role = theirs && profileEntryOf(theirs)?.role
      return typeof role === 'string' ? role : undefined
    })
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
