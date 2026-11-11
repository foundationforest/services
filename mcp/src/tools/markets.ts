// The markets: the directory this copy reads, each market with its status, or one market, from its
// file as the markets manual defines it, with its preview, the kinds of entry it defines, each with
// its fields, what each key of the file and of its fields means, and each of their types as
// types.json defines it: what the markets manual says a program hands an AI with a market, so that it
// writes an entry that fits without guessing. Which of them an index lists is the index's to say;
// search passes its answers on.
//
// Each field goes out once, in kinds: an AI writes one kind of entry at a time, and kinds gives each
// kind every field it takes, the file's and those every market's hold, in one place. So market is
// the file but its listing and review. keys still says what the file's listing and review keys mean,
// since their words carry what a field list alone does not: that a listing may leave out any field,
// and a review any but subject. Each field is as the file gives it, a choice's values beside its
// labels: the manual's format, which an AI reads with keys.

import { previewOf } from '@foundationforest/markets'

import { keysOf, kindsOf, marketFile, typesOf } from '../markets.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'markets'
export const title = 'Markets'
export const description =
  "The markets in the markets directory this copy reads. With no name: every market, its summary (the one line that says what the dealing is), what an AI needs to know of it beyond that, its status (live, or beta: it works, at your own risk, and may change), its number and its icon, and its roles, each with what it lists (offers or requests); a profile is one market and one role. With a name: that market, its summary, status, number and icon, its roles and the fields a listing's preview shows first; the kinds of entry it defines (such as listing and review) with the fields of each (each field's type, what it holds, the values of a choice and their labels, the unit of a number and whether it takes a range, the roles it is for, and when it applies); keys, what each key of the file and of its fields means, such as that any field may be left out and that a listing's price is always a list; and types, the shape of each of those types, such as how a place, a range or a price's count is given. Read it before you write to a market. No login."
export const params: Param[] = [{ name: 'name', type: 'string', description: 'A market, such as tutoring. Left out: every market.' }]
export const login = false
export const annotations = { readOnlyHint: true, openWorldHint: false }

export async function run(args: Args, ctx: Ctx) {
  if (args.name === undefined) return { markets: ctx.markets.directory.markets }
  const market = marketFile(ctx.markets, args.name as string)
  const kinds = kindsOf(market)
  const { listing, review, ...file } = market
  return { market: { ...file, preview: previewOf(market) }, kinds, keys: keysOf(market, kinds), types: typesOf(kinds) }
}
