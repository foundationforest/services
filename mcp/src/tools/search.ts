// The index's search, the filters given passed to it as they are, or one profile's page there; its
// answer untouched. Which filters it takes and what its answers hold are the index's, in its guide,
// which comes with the server's instructions; none is named here.

import { publicKeyFromAddress } from '@foundationforest/folders'
import { type Context, fromIndex, refuse } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'search'
export const title = 'Search'
export const description =
  "The index's search: the filters given, passed to it as they are, and its answer, untouched, as its word. Or, given a profile's address instead, that profile's page at the index, its whole answer: what it posts, its reviews, its ratings, trust and checks. Which filters the search takes, what each means and what each answer holds are the index's: its guide comes with these instructions. Every filter may be left out. No login."
export const params: Param[] = [
  { name: 'filters', type: 'object', description: "The filters, by the names the index's guide gives them, each value as text. Left out, with no address: the index's search with none." },
  { name: 'address', type: 'string', description: "A profile's address, in place of filters: that profile's page at the index." },
]
export const login = false
export const annotations = { readOnlyHint: true, openWorldHint: true }

export async function run(args: Args, ctx: Context) {
  if (args.address !== undefined) {
    if (args.filters !== undefined) refuse('search takes filters, or an address, not both')
    const address = args.address as string
    // An address has one spelling, so no other path of the index's is ever asked for.
    if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
    return { index: await fromIndex(ctx, `profiles/${address}.json`) }
  }
  const filters = (args.filters ?? {}) as { [name: string]: unknown }
  for (const [name, value] of Object.entries(filters)) if (typeof value !== 'string') refuse(`each filter's value is text: ${name} is not`)
  return { index: await fromIndex(ctx, `search.json?${new URLSearchParams(filters as { [name: string]: string })}`) }
}
