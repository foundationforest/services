// A message from one of the person's profiles to another profile: signed with the profile's access
// key, locked to the public encryption keys the recipient's profile entry gives for its inbox
// (inboxEntry), and left with each host it names. It carries the sender's first host, so the
// recipient's app finds the sender's folder. No host checks who signed the message inside, so this
// copy checks first that the sender's profile entry lists the key with message, and it has not
// ended, as the recipient's app will (senderCounts).
//
// The body is the two apps' shape, { text, listing? }: `listing` the full address of the listing the
// message is about, or `listing/<id>` of the sending profile's own, which this fills in, for a reply
// to a request with an offer of one's own.
//
// Each host takes its price, by its bytes, from the sending profile's balance there: the request
// carries a payment signed over the inbox entry's id by the same access key (the credits client's
// inboxPayment). A host out of credits is refused in plain words, with no link (act.ts, why).
//
// Then a copy of what was sent, as the Forest app keeps one: in the sending profile's own folder at
// sent/<id>, a random id, { to, time, body }, locked to the keys that read the folder (lockKeysOf),
// so every device that opens the profile shows the AI's side of the thread. A key listed without
// write sends, and the hosts refuse its copy: the answer says so.

import { randomBytes } from 'node:crypto'
import { type Body, FolderError, type InboxEntry, canDo, entry, hex, leave, lockKeysOf, nextTime, publicKeyFromAddress, write } from '@foundationforest/folders'
import { inboxEntry, lock } from '@foundationforest/folders/locked'
import { inboxPayment } from '../../../host/client/client.ts'
import { type Own, bodyAt, folderAt, how, ownFolder, ownProfile, profileEntryOf, why } from '../act.ts'
import { pathOf } from '../entries.ts'
import { refuse } from '../forest.ts'
import { appLinks } from '../links.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'send_message'
export const title = 'Send a message'
export const description =
  "Send a message to another profile, from one of the person's profiles. to is the other profile's address, from a search or a conversation. Ask the person before a first message to someone, and show them the text. With no label it goes from the person's profile on the other side of the recipient's market (the same role in a market with one role); if they have none, it is refused with the link to make one, which you give them. listing, when the message is about a listing: its full address, as a search gave it, or listing/<id> for one of the sending profile's own (a reply to a request with an offer). It is locked so only the recipient opens it, and the person's app shows it in the conversation. Photos, proofs and locations are not sent here: give the person the conversation link from read_messages. A profile out of credits: tell the person to add credits in the Forest app. Needs the person's login."
export const params: Param[] = [
  { name: 'to', type: 'string', required: true, description: 'The address of the profile it is to.' },
  { name: 'text', type: 'string', required: true, description: 'What it says.' },
  { name: 'listing', type: 'string', description: "The listing it is about: the recipient's, by its full address, or listing/<id> for one of the sending profile's own." },
  { name: 'label', type: 'string', description: "The person's profile it is from, by its label: <market>/<role>. Left out: the profile on the other side of the recipient's market." },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

/** The person's profile to send as, when no label is given: the other side of the recipient's market. */
async function senderFor(ctx: Ctx, to: string, theirs: Body): Promise<Own> {
  const market = typeof theirs.market === 'string' ? theirs.market : undefined
  const role = typeof theirs.role === 'string' ? theirs.role : undefined
  const file = market ? ctx.markets.market(market) : undefined
  if (!market || !role || !file) return refuse(`${to} is in no market this copy knows, so the profile to send as is not clear: give label`)
  const roles = file.roles.map((r) => r.role)
  // The other side of the market; in a market with one role, the same role.
  const sides = roles.length === 1 ? roles : roles.filter((r) => r !== role)
  const labels = sides.map((r) => `${market}/${r}`)
  const mine = (await ctx.connection()).profiles.filter((p) => labels.includes(p.label))
  if (mine.length === 0) {
    const link = appLinks(ctx.app).newProfile(market, sides[0]!)
    return refuse(`the person has no ${labels.join(' or ')} profile to send this from: they make one in the Forest app${link ? `: ${link}` : ''}`)
  }
  if (mine.length > 1) return refuse(`more than one profile could send this (${mine.map((p) => p.label).join(', ')}): give label`)
  return ownProfile(ctx, mine[0]!.label)
}

export async function run(args: Args, ctx: Ctx) {
  const to = args.to as string
  const text = args.text as string
  if (!publicKeyFromAddress(to)) refuse(`${to} is not a profile's address`)
  if (text.trim() === '') refuse('a message says something: text is empty')
  const theirs = (await folderAt(ctx, to)) ?? refuse(`no host this copy knows holds ${to}'s profile entry`)
  const theirProfile = profileEntryOf(theirs)!
  const me = args.label !== undefined ? await ownProfile(ctx, args.label as string) : await senderFor(ctx, to, theirProfile)
  const { view, profile } = await ownFolder(ctx, me)
  if (!canDo(profile, me.key.address, 'message')) refuse(`this login may not message as ${me.label}: its profile entry does not list its key with message, or the key has ended`)
  let listing: string | undefined
  if (args.listing !== undefined) {
    const given = args.listing as string
    const parts = given.split('/')
    if (parts[0] === 'listing' && parts.length === 2) {
      // One of the sending profile's own: it must hold it.
      if (bodyAt(view, pathOf(given)) === null) refuse(`${me.label} has no ${given}: list_my_profiles(label) lists its listings`)
      listing = `${me.address}/${given}`
    } else if (parts.length === 3 && parts[0] === to && parts[1] === 'listing' && parts[2]) listing = given
    else refuse("listing is the full address of one of the recipient's listings, <address>/listing/<id>, or listing/<id> for one of the sending profile's own")
  }
  const body: Body = { text, ...(listing && { listing }) }
  const time = Date.now()
  let left: InboxEntry
  try {
    left = await inboxEntry({ profile: me.address, key: me.key }, to, body, time, theirProfile, view.hosts[0])
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
  const link = appLinks(ctx.app).thread(me.label, to)
  return {
    sent: true,
    from: me.label,
    to,
    ...(link && { conversation: link }),
    ...(!kept.some((o) => o.results[0]?.ok) && { note: `it went, but its copy was not kept in the profile's folder, so the person's app will not show it there: ${why(kept)}` }),
  }
}
