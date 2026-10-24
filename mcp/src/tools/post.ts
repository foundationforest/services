// A record of one of the market's kinds, such as an offer or a review, written by the person's
// signer as one of their profiles: its body checked against the market here, before it is relayed.

import { checkBody, checkId, checkKind, checkRole, marketFile } from '../markets.ts'
import { type Args, type Ctx, MARKET, type Param, ROLE } from '../params.ts'

export const name = 'post'
export const description =
  "Write a record as the person's profile in a market and role: a post (kind offer) or a review (kind review), or any kind the market defines. The body is checked against the market's fields for that kind before it goes to the person's signer, which writes it to the profile's hosts. With an id, it replaces the record at <kind>/<id>; without, the signer picks a fresh one. Answers done with the kind and id, needs approval with a link for the person, or refused. Needs the person's login."
export const params: Param[] = [
  MARKET,
  ROLE,
  { name: 'kind', type: 'string', required: true, description: 'The kind of record, one the market defines, such as offer or review.' },
  { name: 'body', type: 'object', required: true, description: "The record's fields, as the market defines them for this kind and role." },
  { name: 'id', type: 'string', description: 'The id in <kind>/<id>: lowercase letters, digits, dots, underscores and dashes, up to 64. Left out for a new one.' },
]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  const market = marketFile(args.market as string)
  const role = args.role as string
  checkRole(market, role)
  const kind = args.kind as string
  checkKind(market, kind)
  checkId(kind, args.id)
  const body = await checkBody(ctx, market, role, kind, args.body)
  return ctx.ask(name, { market: market.name, role, kind, body, ...(args.id !== undefined && { id: args.id }) })
}
