// The messages to one of the person's profiles, opened by their signer, each with a number to
// reply by.

import { checkRole, marketFile } from '../markets.ts'
import { type Args, type Ctx, MARKET, type Param, ROLE } from '../params.ts'

export const name = 'inbox'
export const description =
  "The messages to the person's profile in a market and role, as their signer opens them: each with a number to reply by, who it is from (another profile's address), when, and what it says. Answers done, needs approval with a link for the person, or refused. Needs the person's login."
export const params: Param[] = [MARKET, ROLE]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  const market = marketFile(args.market as string)
  checkRole(market, args.role as string)
  return ctx.ask(name, { market: market.name, role: args.role })
}
