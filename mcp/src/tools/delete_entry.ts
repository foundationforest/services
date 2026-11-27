// Deleting one of the person's listings, reviews, vouches or reports: its entry at <kind>/<id>
// written as deleted, signed with the profile's access key. Nothing else: not the profile entry, not
// the person's notes, not the copies of what it sent.

import { ownFolder, ownProfile, bodyAt, publish } from '../act.ts'
import { pathOf } from '../entries.ts'
import { refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'delete_entry'
export const title = 'Delete a listing, review, vouch or report'
export const description =
  "Delete one of the person's listings, reviews, vouches or reports, in the profile named by label. Ask the person first: it cannot be undone. path is listing/<id>, review/<id>, vouch/<id> or report/<id>, as list_my_profiles(label) gives them (a listing's id, a written entry's path). Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', required: true, description: 'listing/<id>, review/<id>, vouch/<id> or report/<id>.' },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

export async function run(args: Args, ctx: Ctx) {
  const path = pathOf(args.path as string)
  const [kind, id, ...more] = path.split('/')
  if (!['listing', 'review', 'vouch', 'report'].includes(kind!) || id === undefined || more.length) refuse('delete_entry takes listing/<id>, review/<id>, vouch/<id> or report/<id>')
  const me = await ownProfile(ctx, args.label as string)
  const { view } = await ownFolder(ctx, me)
  if (bodyAt(view, path) === null) refuse(`${me.label} has no ${path}: list_my_profiles(label) lists what it holds`)
  await publish(ctx, me, view, path, null)
  return { deleted: path }
}
