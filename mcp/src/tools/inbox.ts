// The profile's inbox, pulled and opened with the read key.

import { type Context, pullAs } from '../forest.ts'
import { type Args, PROFILE, type Param, READ_KEY } from '../params.ts'
import { requestOf } from './ask.ts'

export const name = 'inbox'
export const description =
  "Read key. The messages to the profile, pulled from each of its hosts with the read key, each opened when it is sealed to it; one that is not shows who sent it and when, unopened. A copy of a message sent with send shows as sent, with whom it went to; a request the profile sent itself with ask is marked with its kind; any other is just a message. Give after, the cursors a pull returned, for newer messages only."
export const params: Param[] = [
  { name: 'after', type: 'object', description: 'The cursors a pull returned, by host: { "<host>": <cursor> }. Left out: every message.' },
  PROFILE,
  READ_KEY,
]

export async function run(args: Args, ctx: Context) {
  return pullAs(args, ctx, (args.after as { [host: string]: number } | undefined) ?? {}, requestOf)
}
