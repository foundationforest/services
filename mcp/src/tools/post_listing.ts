// Posting a listing in one of the person's profiles: at listing/<id>, signed with the profile's
// access key, checked against its market before anything is signed (entries.ts). With an id that
// names a listing that exists, an update: the fields the AI gives replace the same fields, a field
// sent as null is removed, the rest stay; and its photos, the `files` list and each photo field,
// are always carried over from what is there, since no AI sends a photo: the person adds them in
// the Forest app, at the link the answer gives. An id left out, or not yet used, is a new listing.
// The answer names the market's key fields, its preview, that the listing leaves empty, so the AI
// can tell the person what a listing that is there to be found still lacks.

import { type Body } from '@foundationforest/folders'
import { type Market, previewOf } from '@foundationforest/markets'
import { bodyAt, ownFolder, ownProfile, publish } from '../act.ts'
import { checkPublic, marketOf, newId, pathOf } from '../entries.ts'
import { isObject, refuse } from '../forest.ts'
import { appLinks } from '../links.ts'
import type { Args, Ctx, Param } from '../params.ts'
import { indexOf } from './list_my_profiles.ts'

export const name = 'post_listing'
export const title = 'Post a listing'
export const description =
  "Post or update one of the person's listings, an offer or a request as the profile's role says, in the profile named by label. A listing is there to be found. Read the market with list_markets(name): each field's question and how an answer is written. Before posting, ask the person in one go for any of its key fields (its preview) they have not given, photos aside; post only what they said, never a value you guessed. If they choose to leave a key field out, post it and tell them what that costs: with no area, nobody searching nearby finds it. A field that does not fit is refused, naming it. Numbers, amounts and coordinates are decimal text, \"2.5\"; a number may be { from, to }, an end left out for no limit. Spots: one whole number, \"0\" when full; a time with its own holds them in its date answer, { \"on\": \"2026-11-28\", \"start\": \"10:00\", \"zone\": \"Europe/Lisbon\", \"spots\": \"3\" }. Price: a list of every price, each with its per and, for more than one of it, its count: [{ \"amount\": \"15\", \"currency\": \"EUR\", \"per\": \"hour\" }]; 25 for 45 minutes is count \"0.75\"; a minimum goes in the note. Place: a circle { lat, lon, radiusKm } centred on the neighbourhood or town the person names, never their address; radiusKm 0 only for coordinates they give; from memory 1 km, naming the spot in the text; not knowing where a place is, ask for the nearest town you know, never guess. Hours are clock times with a time zone by name, such as Europe/Madrid; \"mornings\": ask for the hours. Several answers in a field mean any of them; things that go together are another listing. Leave id out for a new listing. With the id of one that exists, it is updated: fields you leave out stay, null removes one. Photos are never sent: the person adds them in the Forest app, at the link in the answer. The answer names in empty the key fields still empty, and says when the market is beta (it works, at the person's own risk, and may change) and when the index does not count the profile, so the listing will not show in search. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it is posted as, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'id', type: 'string', description: 'The listing, to update it: lowercase letters, digits, dots, underscores and dashes. Left out: a new listing.' },
  { name: 'fields', type: 'object', required: true, description: "The listing's fields, as the market defines them; null removes one." },
]
export const login = true
export const annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

/**
 * The market's key fields, its preview, in its order, that `body` leaves empty: only those the
 * market asks the role, and only where each applies, every field its `when` names holding one of its
 * values, as checkEntry reads it, so a listing is never told it lacks a field it may not hold, such
 * as an area for lessons online. A photo field is among them: the person adds it in the app.
 */
function emptyOf(ctx: Ctx, market: Market, role: string, body: Body): string[] {
  const asked = new Map(ctx.markets.ask(market.name, role).map((a) => [a.name, a]))
  const applies = (name: string) => Object.entries(asked.get(name)!.when ?? {}).every(([other, values]) => [body[other]].flat().some((v) => values.includes(v as string)))
  return previewOf(market).filter((name) => asked.has(name) && body[name] === undefined && applies(name))
}

export async function run(args: Args, ctx: Ctx) {
  const me = await ownProfile(ctx, args.label as string)
  const fields = args.fields as Body
  const { view, profile } = await ownFolder(ctx, me)
  const market = marketOf(ctx, me, profile)
  const role = typeof profile.role === 'string' ? profile.role : ''
  const links = appLinks(ctx.app)
  const id = (args.id as string | undefined) ?? newId()
  const path = pathOf(`listing/${id}`)
  if (path.split('/').length !== 2) refuse('a listing sits at listing/<id>, one segment after the kind')
  // Photos: this copy's to carry over, never the AI's to send.
  const photos = ['files', ...ctx.markets.ask(market.name, role).filter((a) => a.piece === 'photo').map((a) => a.name)]
  const sent = photos.filter((name) => name in fields)
  if (sent.length) refuse(`${sent.join(', ')} is photos, which are never sent here: the person adds them in the Forest app${links.listing(me.label, id) ? `, at ${links.listing(me.label, id)}` : ''}`)
  const before = bodyAt(view, path)
  const body: Body = {}
  for (const [key, value] of Object.entries({ ...before, ...fields })) if (value !== null) body[key] = value as never
  for (const name of photos) {
    if (before && before[name] !== undefined) body[name] = before[name]!
    else delete body[name]
  }
  if (!isObject(body)) refuse('fields is an object')
  await checkPublic(ctx, market, role, 'listing', body)
  await publish(ctx, me, view, path, body)
  const index = await indexOf(ctx, me.address)
  const link = links.listing(me.label, id)
  const empty = emptyOf(ctx, market, role, body)
  return {
    posted: id,
    ...(before && { updated: true }),
    ...(link && { link }),
    ...(empty.length && { empty }),
    ...(market.status === 'beta' && { beta: 'This market is in beta: it works, at the person\'s own risk, and may change. Tell them.' }),
    ...(index.counts === false && { notInSearch: "The index does not count this profile yet, so this listing will not show in search." }),
  }
}
