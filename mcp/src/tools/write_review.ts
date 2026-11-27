// A review, vouch or report by one of the person's profiles about another profile, at
// <kind>/<id> in its folder, signed with its access key, checked against its market as a listing is
// (entries.ts). The index counts one vouch and one report per writer and profile, the latest, and a
// review's latest per profile and listing, so when the profile's folder already holds an entry of
// that kind about that subject (for a review, about that listing too), this writes at its path and
// updates it; else at a new random id. A folder then holds no dead copies.

import { type Body, isLocked } from '@foundationforest/folders'
import { ownFolder, ownProfile, publish } from '../act.ts'
import { checkPublic, marketOf, newId } from '../entries.ts'
import { refuse } from '../forest.ts'
import { profilePage } from '../links.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'write_review'
export const title = 'Write a review, vouch or report'
export const description =
  "Write a review, a vouch or a report about another profile, as one of the person's profiles named by label. Ask the person first, and say it is public. A review scores and describes a dealing (with the listing it is about, when there was one: its full address); a vouch says \"I know this profile is real and honest\"; a report says \"this profile is fake or a scam\". subject is the other profile's address, from a search. fields holds the rest as the market defines it for that kind: read it with list_markets(name); any field may be left out; one that does not fit is refused, naming the field. Writing again about the same profile (and, for a review, the same listing) updates the earlier one. It cannot be about one of the person's own profiles. Answers the path written and the index's page for the subject. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it is written as, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'kind', type: 'string', required: true, description: 'review, vouch or report.' },
  { name: 'subject', type: 'string', required: true, description: 'The address of the profile it is about.' },
  { name: 'fields', type: 'object', required: true, description: "The entry's other fields, as the market defines them for its kind, such as score and text; for a review, listing." },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

const KINDS = ['review', 'vouch', 'report']

export async function run(args: Args, ctx: Ctx) {
  const kind = args.kind as string
  if (!KINDS.includes(kind)) refuse(`kind is review, vouch or report: not ${kind}`)
  const subject = args.subject as string
  const fields = args.fields as Body
  if ('subject' in fields) refuse('subject is its own argument, not one of fields')
  const me = await ownProfile(ctx, args.label as string)
  const { view, profile } = await ownFolder(ctx, me)
  const market = marketOf(ctx, me, profile)
  const body: Body = { ...fields, subject }
  await checkPublic(ctx, market, typeof profile.role === 'string' ? profile.role : '', kind, body)
  // The person's own earlier entry of that kind about that subject, and for a review that listing: the newest.
  const earlier = [...view.current]
    .filter(([path, c]) => path.startsWith(`${kind}/`) && c.entry.body !== null && !isLocked(c.entry.body) && c.entry.body.subject === subject && (kind !== 'review' || c.entry.body.listing === body.listing))
    .sort(([, a], [, b]) => b.entry.time - a.entry.time)[0]
  const path = earlier?.[0] ?? `${kind}/${newId()}`
  await publish(ctx, me, view, path, body)
  return { posted: kind, path, ...(earlier && { updated: true }), page: profilePage(ctx, subject) }
}
