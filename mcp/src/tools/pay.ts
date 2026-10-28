// The standard's pay ask, to the person's app: an amount, in a currency, to a profile or a post.

import { type Args, type Ctx, type Param, askOf } from '../params.ts'

export const name = 'pay'
export const description =
  "Ask the person's Forest app to pay as one of their profiles, named by its label: an amount of a currency to a profile's address, or to a post's full address, <address>/<path>, such as the offer it pays for. The app pays within the limits the person set, and asks them about the rest; which of its pay addresses it pays from and to, and on which chain, is the app's. Answers done, waiting (the person must approve it in their Forest app), or refused, saying why. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile that pays, by its label: <market>/<role>, such as tutoring/student." },
  { name: 'to', type: 'string', required: true, description: "A profile's address, or a post's full address: <address>/offer/<id>." },
  { name: 'amount', type: 'string', required: true, description: 'How much, as decimal text with at most six places, such as "30" or "12.5".' },
  { name: 'currency', type: 'string', required: true, description: 'A currency code, such as USD.' },
]
export const toApp = true

export async function run(args: Args, ctx: Ctx) {
  return ctx.ask(askOf(name, args))
}
