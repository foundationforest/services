// A review at review/<id> in the profile's folder: written, corrected or withdrawn with the write
// key, its body checked against the profile's market first.

import { type Context, pathFor, refuse, writeAt } from '../forest.ts'
import { checkReview } from '../markets.ts'
import { ACTION, type Args, PROFILE, type Param, WRITE_KEY, id } from '../params.ts'

export const name = 'review'
export const description =
  "Write key. Post, update or remove a review of another profile at review/<id> in the profile's folder, on each of its hosts, so a person can correct or withdraw one. Its fields are the market's: subject (the reviewed profile's address), and where the market has them, score (\"1\" to \"10\", at most one decimal), text, offer (the post's address, <profile address>/offer/<id>) and evidence (a receipt address or a payment signature), and any the market adds. A body that does not fit is refused, naming the field."
export const params: Param[] = [
  ACTION,
  id('review'),
  { name: 'body', type: 'object', description: "The review's fields, by the names its market gives them (market shows them). Needed to post or update." },
  PROFILE,
  WRITE_KEY,
]

export async function run(args: Args, ctx: Context) {
  const action = args.action as 'post' | 'update' | 'remove'
  if (action !== 'post' && args.id === undefined) refuse(`review ${action} needs id`)
  if ((action === 'remove') !== (args.body === undefined)) refuse(action === 'remove' ? 'review remove takes no body' : `review ${action} needs body`)
  return writeAt(args, ctx, pathFor('review', args.id as string | undefined), action, (view) => checkReview(ctx, view, args.body))
}
