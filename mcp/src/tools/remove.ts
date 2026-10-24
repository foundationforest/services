// A record of one of the market's kinds removed by the person's signer: a delete is a write.

import { checkId, checkKind, checkRole, marketFile } from '../markets.ts'
import { type Args, type Ctx, MARKET, type Param, ROLE } from '../params.ts'

export const name = 'remove'
export const description =
  "Remove a record the person's profile in a market and role wrote, such as a post (kind offer) or a review (kind review), by its id. The person's signer writes the delete to the profile's hosts. Answers done, needs approval with a link for the person, or refused. Needs the person's login."
export const params: Param[] = [
  MARKET,
  ROLE,
  { name: 'kind', type: 'string', required: true, description: 'The kind of record, one the market defines, such as offer or review.' },
  { name: 'id', type: 'string', required: true, description: 'The id in <kind>/<id>.' },
]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  const market = marketFile(args.market as string)
  const role = args.role as string
  checkRole(market, role)
  const kind = args.kind as string
  checkKind(market, kind)
  checkId(kind, args.id)
  return ctx.ask(name, { market: market.name, role, kind, id: args.id })
}
