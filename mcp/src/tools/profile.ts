// A profile: its profile record and its other records from its hosts, by kind, every signature
// checked; and the index's whole answer for it, untouched.

import { type Body, type Checked, isPrivate, liveContent } from '@foundationforest/records'
import { type Context, folder, indexSays } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'profile'
export const description =
  "Any profile, read from its hosts, every signature checked: its profile record (its market, role, pay addresses, inbox and proofs; its inbox key, a long public key, is left out), and its other records by kind, such as its posts (offer) and the reviews it wrote (review), each with its full address. Also the index's whole answer for it, untouched, as the index's word: the index tool says what it holds. No login."
export const params: Param[] = [{ name: 'address', type: 'string', required: true, description: "The profile's address." }]
export const relayed = false

/** A profile record without its inbox key: about 2 KB, and only a sender's app needs it. */
function withoutKey(body: Body): Body {
  const { inboxKey: _, ...rest } = body
  return rest
}

export async function run(args: Args, ctx: Context) {
  const address = args.address as string
  const view = await folder(ctx, address)
  const live = liveContent(view)
  const shown = ({ record: { path, body } }: Checked) => ({ address: `${address}/${path}`, ...(isPrivate(body) ? { private: true } : { body }) })
  const records: { [kind: string]: ReturnType<typeof shown>[] } = {}
  for (const c of live.values()) {
    if (c.record.path === 'profile') continue
    const kind = c.record.path.split('/')[0]!
    ;(records[kind] ??= []).push(shown(c))
  }
  const record = live.get('profile')?.record.body
  return {
    address,
    hosts: view.hosts,
    profile: !record ? null : isPrivate(record) ? { private: true } : withoutKey(record),
    records,
    index: await indexSays(ctx, `profiles/${address}.json`),
  }
}
