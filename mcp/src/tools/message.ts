// A message to another profile's inbox, sent by the person's signer as one of their profiles.

import { publicKeyFromAddress } from '@foundationforest/records'
import { refuse } from '../forest.ts'
import { checkRole, marketFile } from '../markets.ts'
import { type Args, type Ctx, MARKET, type Param, ROLE } from '../params.ts'

export const name = 'message'
export const description =
  "Send a message to another profile, by its address, as the person's profile in a market and role. The person's signer encrypts it to that profile's inbox and delivers it to its hosts. Answers done, needs approval with a link for the person, or refused. Needs the person's login."
export const params: Param[] = [
  MARKET,
  ROLE,
  { name: 'to', type: 'string', required: true, description: "The address of the profile it is to, such as a post's profile from search." },
  { name: 'text', type: 'string', required: true, description: 'What the message says.' },
]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  const market = marketFile(args.market as string)
  checkRole(market, args.role as string)
  if (!publicKeyFromAddress(args.to)) refuse(`${String(args.to)} is not a profile's address`)
  if (!(args.text as string).trim()) refuse('the text says something')
  return ctx.ask(name, { market: market.name, role: args.role, to: args.to, text: args.text })
}
