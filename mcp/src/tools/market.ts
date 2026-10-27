// One market: its file, as the markets manual defines it, with its preview; and the index's whole
// answer for it, untouched.

import { type Context, indexSays } from '../forest.ts'
import { kindsOf, marketFile, previewOf } from '../markets.ts'
import type { Args, Param } from '../params.ts'

export const name = 'market'
export const description =
  "A market's file, from the markets directory this copy reads: its roles and what each posts, the kinds of record it defines (such as offer and review) and the fields of each (each field's type, what it holds, the values of a choice, and the roles it is for), the fields a post's preview shows first, its payment schedules, and how deals go there. Also the index's whole answer for the market, untouched, as its word: the index tool says what it holds. No login."
export const params: Param[] = [{ name: 'market', type: 'string', required: true, description: 'The market, such as tutoring.' }]
export const relayed = false

export async function run(args: Args, ctx: Context) {
  const market = marketFile(args.market as string)
  return {
    market: { ...market, preview: previewOf(market) },
    kinds: kindsOf(market),
    index: await indexSays(ctx, `markets/${encodeURIComponent(market.name)}.json`),
  }
}
