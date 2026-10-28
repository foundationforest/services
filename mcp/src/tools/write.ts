// The standard's write ask, to the person's app: a record at a path in one of their profiles'
// folders, a null body to remove it, or a message to another profile.

import { type Args, type Ctx, type Param, askOf } from '../params.ts'

export const name = 'write'
export const description =
  "Ask the person's Forest app to write as one of their profiles, named by its label. With a path and a body: the record at that path in the profile's folder, such as offer/<id> or review/<id>, its body as the market defines that kind (read the market first); a null body removes it. Evidence on a review is the person's app's to fill in, from a payment it made: leave it out. With to, another profile's address, instead of a path: a message, encrypted to that profile's inbox, such as { text }; a reply is a write to the address the message came from. A write of profile under a label the person has no profile under asks them to make one. Answers done, waiting (the person must approve it in their Forest app), or refused, saying why. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile it writes as, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', description: 'Where in that profile\'s folder: <kind>/<id>, such as offer/maths; the id is lowercase letters, digits, dots, underscores and dashes.' },
  { name: 'to', type: 'string', description: "For a message, in place of a path: the address of the profile it is to." },
  { name: 'body', type: 'object', nullable: true, required: true, description: 'What it says: the record\'s fields, as the market defines them for its kind; null to remove the record; for a message, such as { text }.' },
]
export const toApp = true

export async function run(args: Args, ctx: Ctx) {
  return ctx.ask(askOf(name, args))
}
