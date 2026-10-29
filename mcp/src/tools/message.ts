// A message from one of the person's profiles to another profile: signed with the profile's access
// key, locked to the open keys the recipient's profile entry gives for its inbox (inboxEntry), and
// left with each host it names. It carries the sender's first host, so the recipient's app finds
// the sender's folder. No host checks who signed a message, so this copy checks first that the
// sender's profile entry lists the key with message, as the recipient's app will (senderCounts).
//
// At a host that sells credits, it carries one: bought there from the sending profile's balance,
// paid with the same access key, and sent with the inbox entry (the credits client's
// inboxPayment). The credit says nothing about who paid for it. It keeps none.

import { type Body, FolderError, type InboxEntry, canDo, leave, publicKeyFromAddress } from '@foundationforest/folders'
import { inboxEntry } from '@foundationforest/folders/locked'
import { inboxPayment } from '../../../host/client/client.ts'
import { folderAt, how, ownFolder, ownProfile, profileEntryOf } from '../act.ts'
import { refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'message'
export const title = 'Send a message'
export const description =
  "Send a message as one of the person's profiles, named by its label, to another profile's address, such as one a search found or the address a message came from: signed with the access key this login holds for the profile, and locked so only the recipient opens it. At a host that sells credits it carries one of the profile's credits there, most of which goes to the recipient. Its body is what the two apps agree on; the main way is { text }. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it is from, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'to', type: 'string', required: true, description: 'The address of the profile it is to.' },
  { name: 'body', type: 'object', required: true, description: 'What it says, such as { text }.' },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }

export async function run(args: Args, ctx: Ctx) {
  const me = await ownProfile(ctx, args.label as string)
  const to = args.to as string
  if (!publicKeyFromAddress(to)) refuse(`${to} is not a profile's address`)
  const { view, profile } = await ownFolder(ctx, me)
  if (!canDo(profile, me.key.address, 'message')) refuse(`this login may not message as ${me.label}: its profile entry does not list its key with message`)
  const theirs = (await folderAt(ctx, to)) ?? refuse(`no host this copy knows holds ${to}'s profile entry`)
  let left: InboxEntry
  try {
    left = await inboxEntry({ profile: me.address, key: me.key }, to, args.body as Body, Date.now(), profileEntryOf(theirs), view.hosts[0])
  } catch (err) {
    refuse(err instanceof FolderError ? (err.code === 'no_inbox' ? `${to} takes no messages: its profile entry gives no open key` : `not a message: ${err.message}`) : String(err))
  }
  const outcomes = await leave(theirs.hosts, [left], { ...how(ctx), payment: inboxPayment({ profile: me.address, key: me.key }, ctx.hostFetch) })
  const took = outcomes.filter((o) => o.results[0]?.ok)
  if (!took.length) refuse(`no host took it: ${outcomes.map((o) => `${o.host} (${o.results[0] ? `${o.results[0].error}: ${o.results[0].message ?? ''}`.trim() : (o.error ?? `answered ${o.status}`)})`).join('; ')}`)
  return { sent: true, hosts: took.length }
}
