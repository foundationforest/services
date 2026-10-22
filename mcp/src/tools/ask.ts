// A request to the person, in their own inbox, for their app to show and act on, or not. The kinds
// are this tool's own, not the standard's: the standard lets the two apps agree on a message's body.

import type { Body } from '@foundationforest/records'
import { type Context, deliverAs, pathFor } from '../forest.ts'
import { checkPost, checkPostAddress, checkReview } from '../markets.ts'
import { type Args, PROFILE, type Param, WRITE_KEY, checkArgs } from '../params.ts'

const BODY = (what: string): Param => ({ name: 'body', type: 'object', required: true, description: `The ${what}'s fields, by the names its market gives them.` })
const ID = (prefix: string, required: boolean): Param => ({ name: 'id', type: 'string', required, description: `The id in ${prefix}/<id>.` })

/** Each kind and what it takes. */
export const KINDS: { [kind: string]: Param[] } = {
  'post-offer': [BODY('post'), ID('offer', false)],
  'update-offer': [ID('offer', true), BODY('post')],
  'remove-offer': [ID('offer', true)],
  'post-review': [BODY('review'), ID('review', false)],
  pay: [
    { name: 'offer', type: 'string', required: true, description: "The post's address: <profile address>/offer/<id>." },
    { name: 'units', type: 'integer', minimum: 1, description: 'How many hours, sessions or other units the price is per, when it is per one.' },
    { name: 'note', type: 'string', description: 'A note for the person.' },
  ],
}

/** The kind a message body asks for, when it is a request whose fields fit that kind; else null. */
export function requestOf(body: Body): string | null {
  const { request: kind, ...rest } = body
  const takes = typeof kind === 'string' ? KINDS[kind] : undefined
  if (!takes) return null
  try {
    checkArgs({ name: kind as string, params: takes }, rest)
  } catch {
    return null
  }
  return kind as string
}

export const name = 'ask'
export const description =
  "Write key. Ask the person, through their own inbox, for what no key you hold does: their app shows the request, and they do it with their main key, or not. Kinds: post-offer { body, id? } and update-offer { id, body } (a post), remove-offer { id }, post-review { body, id? }, and pay { offer, units?, note? }, offer being the post's address. Bodies are checked against the market as post and review check them."
export const params: Param[] = [
  { name: 'kind', type: 'string', required: true, positional: true, values: Object.keys(KINDS), description: 'post-offer, update-offer, remove-offer, post-review or pay.' },
  { name: 'params', type: 'object', description: 'What the kind takes, such as { "body": { … } } for post-offer, or { "offer": "<profile address>/offer/<id>", "units": 2 } for pay. Never a key.' },
  PROFILE,
  WRITE_KEY,
]

export async function run(args: Args, ctx: Context) {
  const kind = args.kind as string
  const fields = checkArgs({ name: `ask ${kind}`, params: KINDS[kind]! }, (args.params as Body | undefined) ?? {}) as Body
  return deliverAs(args, ctx, null, async (mine) => {
    if (kind === 'post-offer' || kind === 'update-offer') await checkPost(mine, fields.body)
    if (kind === 'post-review') await checkReview(ctx, mine, fields.body)
    if (kind === 'pay') checkPostAddress(fields.offer, 'offer')
    if (fields.id !== undefined) pathFor(kind === 'post-review' ? 'review' : 'offer', fields.id as string)
    return { request: kind, ...fields }
  })
}
