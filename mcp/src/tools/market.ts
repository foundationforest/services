// One market: its file, as the markets manual defines it, and its posts as the index lists them.

import { type Context, indexSays } from '../forest.ts'
import { marketFile } from '../markets.ts'
import type { Args, Param } from '../params.ts'

export const name = 'market'
export const description =
  "No key. A market's file, from the markets directory this copy reads: its roles and what each posts, the fields of a post and of a review (each field's type, what it holds, the values of a choice, and the roles it is for), its payment schedules, and how deals go there. Also its posts, by role, as the index lists them, as its word."
export const params: Param[] = [{ name: 'market', type: 'string', required: true, positional: true, description: 'The market, as the first half of a label spells it, such as tutoring.' }]

export async function run(args: Args, ctx: Context) {
  const market = marketFile(args.market as string)
  return { market, index: await indexSays(ctx, `markets/${encodeURIComponent(market.name)}.json`, ['index', 'posts']) }
}
