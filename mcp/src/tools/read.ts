// The standard's read ask, to the person's app: their profiles by label, a record in one profile's
// folder, or the messages to one profile.

import { type Args, type Ctx, type Param, askOf } from '../params.ts'

export const name = 'read'
export const description =
  "Ask the person's Forest app to read. With nothing named: the person's profiles this AI app may see, each by its label, with what you may do there without asking them (can, and a limit and an until if any). Start here. With a label and a path: the record at that path in that profile's folder, its body and time, opened if it is private and the person allows it. With a label and inbox: the messages to that profile, each with who it is from (an address, or the label of another of the person's own profiles), when, and its body. Answers done, waiting (the person must approve it in their Forest app), or refused, saying why. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', description: "The person's profile, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', description: 'A path in that profile\'s folder, such as offer/maths.' },
  { name: 'inbox', type: 'boolean', description: 'true: the messages to that profile.' },
]
export const toApp = true

export async function run(args: Args, ctx: Ctx) {
  return ctx.ask(askOf(name, args))
}
