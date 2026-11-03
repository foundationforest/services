// A message from one of the person's profiles to another profile: signed with the profile's access
// key, locked to the open keys the recipient's profile entry gives for its inbox (inboxEntry), and
// left with each host it names. It carries the sender's first host, so the recipient's app finds
// the sender's folder. No host checks who signed the message inside, so this copy checks first that
// the sender's profile entry lists the key with message, and it has not ended, as the recipient's
// app will (senderCounts).
//
// Each host takes its price, by its bytes, from the sending profile's balance there: the request
// carries a payment signed over the inbox entry's id by the same access key (the credits client's
// inboxPayment).
//
// Then a copy of what was sent, as the Forest app keeps one (its src/flows/inbox.ts): in the sending
// profile's own folder at sent/<id>, a random id, { to, time, body }, locked to the keys that read
// the folder (lockKeysOf), written as any entry, so every device that opens the profile shows the
// AI's side of the thread. A key listed without write sends, and the hosts refuse its copy: the
// answer says so.

import { randomBytes } from 'node:crypto'
import { type Body, FolderError, type InboxEntry, type PublishOutcome, canDo, entry, hex, leave, lockKeysOf, nextTime, publicKeyFromAddress, write } from '@foundationforest/folders'
import { inboxEntry, lock } from '@foundationforest/folders/locked'
import { inboxPayment } from '../../../host/client/client.ts'
import { folderAt, how, ownFolder, ownProfile, profileEntryOf } from '../act.ts'
import { refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'message'
export const title = 'Send a message'
export const description =
  "Send a message as one of the person's profiles, named by its label, to another profile's address, such as one a search found or the address a message came from: signed with the access key this login holds for the profile, and locked so only the recipient opens it. Each host that charges takes its price, by its bytes, from the profile's balance there. Then a copy, kept in the profile's own folder at sent/<id> as the Forest app keeps one, so the person's app shows it: copy is its path, or null with why when no host took it. Its body is what the two apps agree on; the main way is { text }. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it is from, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'to', type: 'string', required: true, description: 'The address of the profile it is to.' },
  { name: 'body', type: 'object', required: true, description: 'What it says, such as { text }.' },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }

/** Each host's refusal, in words. */
const why = (outcomes: PublishOutcome[]) => outcomes.map((o) => `${o.host} (${o.results[0] ? `${o.results[0].error}: ${o.results[0].message ?? ''}`.trim() : (o.error ?? `answered ${o.status}`)})`).join('; ')

export async function run(args: Args, ctx: Ctx) {
  const me = await ownProfile(ctx, args.label as string)
  const to = args.to as string
  if (!publicKeyFromAddress(to)) refuse(`${to} is not a profile's address`)
  const { view, profile } = await ownFolder(ctx, me)
  if (!canDo(profile, me.key.address, 'message')) refuse(`this login may not message as ${me.label}: its profile entry does not list its key with message, or the key has ended`)
  const theirs = (await folderAt(ctx, to)) ?? refuse(`no host this copy knows holds ${to}'s profile entry`)
  const body = args.body as Body
  const time = Date.now()
  let left: InboxEntry
  try {
    left = await inboxEntry({ profile: me.address, key: me.key }, to, body, time, profileEntryOf(theirs), view.hosts[0])
  } catch (err) {
    refuse(err instanceof FolderError ? (err.code === 'no_inbox' ? `${to} takes no messages: its profile entry gives no open key` : `not a message: ${err.message}`) : String(err))
  }
  const outcomes = await leave(theirs.hosts, [left], { ...how(ctx), payment: inboxPayment({ profile: me.address, key: me.key }) })
  const took = outcomes.filter((o) => o.results[0]?.ok)
  if (!took.length) refuse(`no host took it: ${why(outcomes)}`)
  // The id is the app's shape, 16 random bytes in hex: the path says nothing of whom it is to.
  const path = `sent/${hex.encode(randomBytes(16))}`
  const copy = await lock({ to, time, body }, lockKeysOf(profile))
  const kept = await write(view.hosts, [entry({ profile: me.address, key: me.key }, path, copy, nextTime(time, view, path))], how(ctx))
  if (!kept.some((o) => o.results[0]?.ok)) return { sent: true, hosts: took.length, copy: null, why: `no host took the copy: ${why(kept)}` }
  return { sent: true, hosts: took.length, copy: path }
}
