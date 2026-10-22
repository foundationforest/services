// A message to another profile's inbox, sealed to its inbox key, signed with the write key.

import type { Body } from '@foundationforest/records'
import { type Context, deliverAs } from '../forest.ts'
import { type Args, PROFILE, type Param, WRITE_KEY } from '../params.ts'

export const name = 'send'
export const description =
  "Write key. Send a message to another profile's inbox, on each of its hosts: the body sealed to its inbox key and the readers its inbox names, so only they open it, and signed with the write key for the profile. The body is any JSON object the two apps agree on, such as { \"text\": \"Is Tuesday at six free?\" }."
export const params: Param[] = [
  { name: 'to', type: 'string', required: true, positional: true, description: "The address of the profile it is to." },
  { name: 'body', type: 'object', required: true, description: 'The message: any JSON object, such as { "text": "…" }.' },
  PROFILE,
  WRITE_KEY,
]

export async function run(args: Args, ctx: Context) {
  return deliverAs(args, ctx, args.to as string, async () => args.body as Body)
}
