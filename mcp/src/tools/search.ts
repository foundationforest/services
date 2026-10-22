// The index's search, with its filters, passed on as its word.

import { type Context, fromIndex } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'search'
export const description =
  "No key. The index's search: posts matching the words and filters given, each with its profile's address, market, role, the post's address and body, and the profile's rating and checks, as the index's word. Every filter may be left out."
export const params: Param[] = [
  { name: 'q', type: 'string', description: 'Words to look for.' },
  { name: 'market', type: 'string', description: 'Only this market, such as tutoring.' },
  { name: 'role', type: 'string', description: 'Only posts by this role, such as tutor.' },
  { name: 'near', type: 'string', description: 'Near this point, as lat,lon in degrees, such as 40.42,-3.70.' },
  { name: 'km', type: 'number', description: 'How far from near, in kilometres.' },
  { name: 'minRating', type: 'number', description: 'Only profiles rated at least this, from 1 to 10.' },
  { name: 'minReviews', type: 'integer', description: 'Only profiles with at least this many reviews.' },
  { name: 'limit', type: 'integer', minimum: 1, description: 'How many results at most.' },
  { name: 'offset', type: 'integer', description: 'How many results to skip, for the next page.' },
]

export async function run(args: Args, ctx: Context) {
  const query = new URLSearchParams(params.filter((p) => args[p.name] !== undefined).map((p) => [p.name, String(args[p.name])]))
  return fromIndex(ctx, `search.json?${query}`)
}
