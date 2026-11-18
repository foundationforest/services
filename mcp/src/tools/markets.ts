// The markets: the directory this copy reads, each market with its status, or one market as the
// markets package's ask says it: its file but its fields, with its preview; each field's rules once,
// by kind, with how an answer is written; and each role's words, in the order a form asks them, for
// its listings and for a review about it. What the markets manual says a program hands an AI with a
// market, so that it writes an entry that fits without guessing. Which of them an index lists is the
// index's to say; search passes its answers on.

import { describe, marketFile } from '../markets.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'markets'
export const title = 'Markets'
export const description =
  "The markets in the markets directory this copy reads. With no name: every market, its summary (the one line that says what the dealing is), what an AI needs to know of it beyond that, its status (live, or beta: it works, at your own risk, and may change), its number and its icon, and its roles, each with what it lists (offers or requests); a profile is one market and one role. With a name: that market, its summary, status, number and icon, its roles and the fields a listing's preview shows first; fields, for each kind of entry (listing, review, vouch, report), each field's rules: its piece (text, choice, number, price, place, date, photo or link), whether it takes several answers, the roles it is for (on a review field, the role of the profile reviewed), when it applies, a choice's values with how each reads or the shared list it takes, a number's unit, a price's per, and takes, how an answer is written; roles, for each role, the fields its listings ask and those a review about it asks, in order, each with its label, its question, a hint and where its input opens; and vouch and report, the same for those. Any field may be left out. Read it before you write to a market. No login."
export const params: Param[] = [{ name: 'name', type: 'string', description: 'A market, such as tutoring. Left out: every market.' }]
export const login = false
export const annotations = { readOnlyHint: true, openWorldHint: false }

export async function run(args: Args, ctx: Ctx) {
  if (args.name === undefined) return { markets: ctx.markets.directory.markets }
  return describe(ctx.markets, marketFile(ctx.markets, args.name as string))
}
