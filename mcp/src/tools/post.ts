// A post at offer/<id> in the profile's folder: written, updated or removed with the write key,
// its body checked against the profile's market first.

import { type Context, pathFor, refuse, writeAt } from '../forest.ts'
import { checkPost } from '../markets.ts'
import { ACTION, type Args, PROFILE, type Param, WRITE_KEY, id } from '../params.ts'

export const name = 'post'
export const description =
  "Write key. Post, update or remove a post at offer/<id> in the profile's folder, on each of its hosts. What a post is (an offer, a request, or just a post) is its profile's role's, as the market says; its fields are the market's, and a body that does not fit is refused, naming the field. Only a post an access key wrote can be updated or removed; one the person's main key wrote, only their app changes."
export const params: Param[] = [
  ACTION,
  id('offer'),
  { name: 'body', type: 'object', description: "The post's fields, by the names its market gives them (market shows them). Needed to post or update." },
  PROFILE,
  WRITE_KEY,
]

export async function run(args: Args, ctx: Context) {
  const action = args.action as 'post' | 'update' | 'remove'
  if (action !== 'post' && args.id === undefined) refuse(`post ${action} needs id`)
  if ((action === 'remove') !== (args.body === undefined)) refuse(action === 'remove' ? 'post remove takes no body' : `post ${action} needs body`)
  return writeAt(args, ctx, pathFor('offer', args.id as string | undefined), action, (view) => checkPost(view, args.body))
}
