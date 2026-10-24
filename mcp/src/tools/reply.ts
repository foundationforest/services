// A reply to a message the inbox numbered, sent by the person's signer from the profile it came to.

import { refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'reply'
export const description =
  "Reply to a message by the number inbox gave it. The person's signer sends the reply from the profile the message came to. Answers done, needs approval with a link for the person, or refused. Needs the person's login."
export const params: Param[] = [
  { name: 'number', type: 'integer', minimum: 1, required: true, description: "The message's number, as inbox gave it." },
  { name: 'text', type: 'string', required: true, description: 'What the reply says.' },
]
export const relayed = true

export async function run(args: Args, ctx: Ctx) {
  if (!(args.text as string).trim()) refuse('the text says something')
  return ctx.ask(name, { number: args.number, text: args.text })
}
