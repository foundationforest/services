// The index's search, the filters given passed to it as they are, or one profile's page there; its
// answer untouched. Which filters it takes and what its answers hold are the index's, in its guide,
// which comes with the server's instructions. The description names one kind, the filters the
// foundation's index takes on a market's own fields, so an AI app that cuts the guide from long
// instructions still finds a listing by them; this copy passes them on as any other.
//
// Beside the answer, with the person's login, `mine`: each address of a profile this login acts in
// that the answer holds anywhere, with its label, so the AI never offers the person their own
// listing.
// The answer itself stays the index's, whole, the person's addresses in it where the index put
// them. Without a login, or with a connection gone or out of reach, `unmarked` says why.

import { publicKeyFromAddress } from '@foundationforest/folders'
import type { ConnectionProfile } from '../connection.ts'
import { type Said, fromIndex, refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'search'
export const title = 'Search'
export const description =
  "The index's search: the filters given, passed to it as they are, and its answer, untouched, as its word. Or, given a profile's address instead, that profile's page at the index, its whole answer: its listings, its reviews, its ratings, trust and checks. Which filters the search takes, what each means and what each answer holds are the index's: its guide comes with these instructions. The foundation's index takes, beside words, a market and a role, a filter on each field of that market's listings once market is given, by the field's name in the market's file: a choice as <field>=<value>, a listing whose field holds that value, such as { \"market\": \"language-exchange\", \"speaks\": \"es\", \"learns\": \"en\" }; a number as <field>.min and <field>.max, in the field's unit, either one alone for an open end, such as { \"minutes.min\": \"45\" }. Every filter may be left out. With the person's login, mine maps each address in the answer that is one of the person's own profiles to its label: what it names is the person's own, never to offer them; without it, unmarked says why. No login needed."
export const params: Param[] = [
  { name: 'filters', type: 'object', description: "The filters, by the names the index's guide gives them, each value as text. Left out, with no address: the index's search with none." },
  { name: 'address', type: 'string', description: "A profile's address, in place of filters: that profile's page at the index." },
]
export const login = false
export const annotations = { readOnlyHint: true, openWorldHint: true }

/** The index's answer, and which of its addresses are the person's own, by label; or why that is not known. */
async function marked(ctx: Ctx, index: Said) {
  let profiles: ConnectionProfile[]
  try {
    profiles = (await ctx.connection()).profiles
  } catch (err) {
    return { index, unmarked: (err as Error).message }
  }
  // An address is base58, which JSON never escapes, so its text holds each one the answer does.
  const text = JSON.stringify('answer' in index ? index.answer : null)
  return { index, mine: Object.fromEntries(profiles.filter((p) => text.includes(p.address)).map((p) => [p.address, p.label])) }
}

export async function run(args: Args, ctx: Ctx) {
  if (args.address !== undefined) {
    if (args.filters !== undefined) refuse('search takes filters, or an address, not both')
    const address = args.address as string
    // An address has one spelling, so no other path of the index's is ever asked for.
    if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
    return marked(ctx, await fromIndex(ctx, `profiles/${address}.json`))
  }
  const filters = (args.filters ?? {}) as { [name: string]: unknown }
  for (const [name, value] of Object.entries(filters)) if (typeof value !== 'string') refuse(`each filter's value is text: ${name} is not`)
  return marked(ctx, await fromIndex(ctx, `search.json?${new URLSearchParams(filters as { [name: string]: string })}`))
}
