// A profile: its profile record, posts and reviews from its hosts, every signature checked; and
// the index's checks and rating for it.

import { type Body, type Checked, isPrivate, liveContent, pathCovers } from '@foundationforest/records'
import { type Context, folder, indexSays } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'profile'
export const description =
  "No key. A profile, read from its hosts, every signature checked: its profile record (its market, role, payment address, inbox and proofs; its inbox key and its inbox's readers, long public keys send finds itself, are left out), its posts and the reviews it wrote, each with its full address. Also the index's checks for it (which issuers' notes it shows) and its rating, as the index's word."
export const params: Param[] = [{ name: 'address', type: 'string', required: true, positional: true, description: "The profile's address." }]

/** A profile record without its inbox key and its inbox's readers: each about 2 KB, and send finds them itself. */
function withoutKeys(body: Body): Body {
  const { inboxKey: _, inbox, ...rest } = body
  if (inbox === null || typeof inbox !== 'object' || Array.isArray(inbox)) return inbox === undefined ? rest : { ...rest, inbox }
  const { readers: __, ...box } = inbox
  return { ...rest, inbox: box }
}

export async function run(args: Args, ctx: Context) {
  const address = args.address as string
  const view = await folder(ctx, address)
  const live = liveContent(view)
  const shown = ({ record: { path, body, by } }: Checked) => ({ address: `${address}/${path}`, ...(by !== undefined && { by }), ...(isPrivate(body) ? { private: true } : { body }) })
  const under = (prefix: string) => [...live.values()].filter((c) => pathCovers(prefix, c.record.path)).map(shown)
  const record = live.get('profile')?.record.body
  return {
    address,
    hosts: view.hosts,
    profile: !record ? null : isPrivate(record) ? { private: true } : withoutKeys(record),
    posts: under('offer'),
    reviews: under('review'),
    index: await indexSays(ctx, `profiles/${address}.json`, ['index', 'checks', 'rating']),
  }
}
