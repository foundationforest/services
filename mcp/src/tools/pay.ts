// A payment for a post, made by the person's signer from one of their profiles: the post read here
// first, from its hosts, so nothing is paid for a post that is not there.

import { folder, profileOf, refuse } from '../forest.ts'
import { checkPostAddress, checkRole, marketFile } from '../markets.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'pay'
export const description =
  "Pay for a post, in US dollars, from the person's profile with this role in the post's market. The person's signer pays within the limits the person set, and asks them for the rest. Asked again for the same post and amount within an hour, it pays nothing more; another payment for a post already paid needs the person's yes. Answers done, needs approval with a link for the person, or refused. A review of this post from the same profile then carries the payment as its evidence, which the signer fills in. Needs the person's login."
export const params: Param[] = [
  { name: 'offer', type: 'string', required: true, description: "The post's address: <profile address>/offer/<id>." },
  { name: 'role', type: 'string', required: true, description: "The role of the person's profile that pays, in the post's market, such as student." },
  { name: 'amount', type: 'string', required: true, description: 'How many US dollars, as decimal text with at most six places, such as "30" or "12.5".' },
]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  const offer = checkPostAddress(args.offer, 'offer')
  const amount = args.amount as string
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount) || !/[1-9]/.test(amount)) refuse('amount is more than 0, as decimal text with at most six places, such as "30" or "12.5"')
  const [address, , id] = offer.split('/')
  const view = await folder(ctx, address!)
  if (!view.current.get(`offer/${id}`)?.record.body) refuse(`there is no post at ${offer}`)
  const named = profileOf(view)?.market
  if (typeof named !== 'string') refuse(`${address} has no profile record naming its market`)
  const market = marketFile(named)
  checkRole(market, args.role as string)
  return ctx.ask(name, { market: market.name, role: args.role, offer, amount })
}
