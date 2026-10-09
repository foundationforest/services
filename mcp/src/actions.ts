// What the two doors show, written once: how Forest works, and each action: what it does, the key
// it needs, its parameters, and the work it runs (forest.ts). The typed door prints this as its
// help and reads its arguments from it; the MCP door gives HOW to the AI first, as the server's
// instructions, and each action as a tool.

import type { Body } from '../../standard/records/src/index.ts'
import { type Context, Refusal, inbox, market, postOffer, postReview, privateRecords, profile, refuse, removeOffer, request, send, updateOffer } from './forest.ts'

export const HOW = `Forest: people deal with each other directly, with nobody in the middle to trust.

- A person holds a seed on their own device. From it come profiles, one per label such as tutoring/seller. A profile's name is its address.
- What a profile says is signed records in its folder: its card (profile), its offers (offer/<id>) and the reviews it wrote of others (review/<id>). Folders are kept on open hosts that anyone can read. This tool checks every signature itself.
- An index reads folders and publishes markets and scores, by its own policy. What it says is its word, not a signed record.
- A person never hands out their main key. They hand out access keys, each with one scope: a write key writes records where the profile's permissions record allows; a message key sends messages for the profile and pulls its inbox; a read key opens what is encrypted to it.
- Messages go to a profile's inbox, encrypted so that only its keys open them.
- Money moves only through the person's own app, with the main key.

This tool does Forest actions with the keys it is given, and keeps nothing. When there is no key for something, use request: it asks the person, through their own inbox, to do that action, or to pay for an offer, and their app shows it and does it with the main key, or not. With only a message key you can ask for anything and do nothing alone. In an inbox, a message is a request only when it is marked as one; any other is just a message.`

export type Scope = 'write' | 'message' | 'read'

export type Param = {
  name: string
  /** integer: a whole number, from 1. */
  type: 'string' | 'object' | 'integer'
  description: string
  required?: boolean
  /** Given first, without its flag, at the typed door. */
  positional?: boolean
}

export type Action = {
  name: string
  /** What it does, in plain words. */
  does: string
  /** The keys it takes: the first is the one it needs. */
  keys: Scope[]
  params: Param[]
  run: (args: Args, ctx: Context) => Promise<unknown>
}

type Args = { [name: string]: unknown }

const str = (args: Args, name: string) => args[name] as string
const obj = (args: Args, name: string) => args[name] as Body

const OFFER = 'The offer, as records/schemas/offer.json shapes it: direction ("offer" or "request"), description, and if wanted price { amount, mint, per: hour | day | job }, terms { arbiter, timer { days, to } }, availability, remote, location, media, expires. Amounts and degrees are decimal text. createdAt is set if missing.'

/** Every action but request. */
const DOING: Action[] = [
  {
    name: 'market',
    does: "What an index says of a market, in that index's own format and by its own policy: its word, not signed records. Needs an index set.",
    keys: [],
    params: [{ name: 'market', type: 'string', required: true, positional: true, description: 'The market, as the first half of a label spells it, such as tutoring.' }],
    run: (args, ctx) => market(ctx, str(args, 'market')),
  },
  {
    name: 'profile',
    does: "A profile's card, its offers and the reviews it wrote, read from its hosts, every signature checked; and, if an index is set, that index's summary of it, such as its scores.",
    keys: [],
    params: [{ name: 'address', type: 'string', required: true, positional: true, description: "The profile's address." }],
    run: (args, ctx) => profile(ctx, str(args, 'address')),
  },
  {
    name: 'private',
    does: 'The private records in the profile\'s folder that the read key opens.',
    keys: ['read'],
    params: [{ name: 'path', type: 'string', description: 'Only the records under this path, such as notes.' }],
    run: (args, ctx) => privateRecords(ctx, args.path as string | undefined),
  },
  {
    name: 'inbox',
    does: "The messages to the profile, pulled from each of its hosts. With a read key the inbox lists as a reader, each message is opened; without one, each shows who sent it and when, unopened. Give after, the cursors a pull returned, for newer messages only.",
    keys: ['message', 'read'],
    params: [{ name: 'after', type: 'object', description: 'The cursors a pull returned, by host: { "<host>": <cursor> }. Omit for every message.' }],
    run: (args, ctx) => inbox(ctx, (args.after as { [host: string]: number } | undefined) ?? {}, requestOf),
  },
  {
    name: 'post-offer',
    does: 'Write a new offer or request at offer/<id> in the profile\'s folder, on each of its hosts.',
    keys: ['write'],
    params: [
      { name: 'offer', type: 'object', required: true, description: OFFER },
      { name: 'id', type: 'string', description: 'The id in offer/<id>. A fresh one if omitted.' },
    ],
    run: (args, ctx) => postOffer(ctx, args.offer, args.id as string | undefined),
  },
  {
    name: 'update-offer',
    does: "Replace an offer at offer/<id> that an access key wrote with a new body. One the owner wrote, only the owner's app can change.",
    keys: ['write'],
    params: [
      { name: 'id', type: 'string', required: true, positional: true, description: 'The id in offer/<id>.' },
      { name: 'offer', type: 'object', required: true, description: OFFER },
    ],
    run: (args, ctx) => updateOffer(ctx, str(args, 'id'), args.offer),
  },
  {
    name: 'remove-offer',
    does: "Remove an offer at offer/<id> that an access key wrote. One the owner wrote, only the owner's app can remove.",
    keys: ['write'],
    params: [{ name: 'id', type: 'string', required: true, positional: true, description: 'The id in offer/<id>.' }],
    run: (args, ctx) => removeOffer(ctx, str(args, 'id')),
  },
  {
    name: 'post-review',
    does: "Write a review of another profile at review/<id> in the profile's folder, on each of its hosts.",
    keys: ['write'],
    params: [
      {
        name: 'review',
        type: 'object',
        required: true,
        description: 'The review, as records/schemas/review.json shapes it: subject (the reviewed profile\'s address), and if wanted ratings { overall: "1" to "10", … }, text, media, dealId (the escrow receipt\'s address). createdAt is set if missing.',
      },
      { name: 'id', type: 'string', description: 'The id in review/<id>. A fresh one if omitted.' },
    ],
    run: (args, ctx) => postReview(ctx, args.review, args.id as string | undefined),
  },
  {
    name: 'send',
    does: "Send a message to another profile's inbox, encrypted to its inbox key and the readers its inbox lists.",
    keys: ['message'],
    params: [
      { name: 'to', type: 'string', required: true, positional: true, description: "The recipient profile's address." },
      { name: 'text', type: 'string', description: 'The message, as text: sent as { "text": … }.' },
      { name: 'body', type: 'object', description: 'The message as an object, in place of text.' },
    ],
    run: async (args, ctx) => {
      if ((args.text === undefined) === (args.body === undefined)) refuse('give text or body, one of them')
      return send(ctx, str(args, 'to'), args.body !== undefined ? obj(args, 'body') : { text: str(args, 'text') })
    },
  },
]

/** Paying, which this tool never does: it is only ever asked for, with the offer's pay link (forest's escrow/README.md). */
const PAY: Param[] = [
  { name: 'offer', type: 'string', required: true, description: "The offer's pay link." },
  { name: 'units', type: 'integer', description: 'How many hours or days, for an offer priced per hour or per day: a whole number, from 1.' },
  { name: 'note', type: 'string', description: 'A note for the person.' },
]

/** What a request may name: each action that needs a key, and pay, with the parameters each takes. */
export const REQUESTS = new Map<string, Param[]>([...DOING.filter((a) => a.keys.length).map((a) => [a.name, a.params] as const), ['pay', PAY]])

/** The action a message body asks for, when it is a request whose parameters fit that action; else null. */
export function requestOf(body: Body): string | null {
  const { request: name, ...params } = body
  const takes = typeof name === 'string' ? REQUESTS.get(name) : undefined
  if (!takes) return null
  try {
    checkArgs({ name: name as string, params: takes }, params)
  } catch {
    return null
  }
  return name as string
}

export const ACTIONS: Action[] = [
  ...DOING,
  {
    name: 'request',
    does: 'Ask the person, through their own inbox, to do one of the actions above for you, or to pay for an offer: name it, and give its parameters. Their app shows it, and does it with the main key, or not.',
    keys: ['message'],
    params: [
      { name: 'action', type: 'string', required: true, positional: true, description: `The action asked for: ${[...REQUESTS.keys()].join(', ')}.` },
      { name: 'params', type: 'object', description: 'Its parameters, as that action takes them, such as { "offer": { … } } for post-offer, { "to": "<address>", "text": "…" } for send, or { "offer": "<pay link>", "units": 2, "note": "…" } for pay, where units (how many hours or days) and note may be left out. Never a key.' },
    ],
    run: async (args, ctx) => {
      const name = str(args, 'action')
      const takes = REQUESTS.get(name) ?? refuse(`a request names one of ${[...REQUESTS.keys()].join(', ')}; not ${name}`)
      const params = (args.params as Body | undefined) ?? {}
      checkArgs({ name, params: takes }, params)
      return request(ctx, { ...params, request: name })
    },
  },
]

const KEY_WORDS: { [scope in Scope]: string } = { write: 'a write key', message: 'a message key', read: 'a read key' }

/** Which key an action needs, in words. */
export function keyNeeded(action: Action): string {
  if (action.name === 'inbox') return 'a message key; a read key the inbox lists as a reader opens the messages'
  return action.keys.length ? KEY_WORDS[action.keys[0]!] : 'none'
}

/** The name a key goes by in a call: writeKey, messageKey, readKey. */
export const keyParam = (scope: Scope) => `${scope}Key`

const KINDS: { [type in Param['type']]: string } = { string: 'text', object: 'an object', integer: 'a whole number, from 1' }

/** An action's parameters, checked: every required one there, each of its type, and nothing else. */
export function checkArgs(action: Pick<Action, 'name' | 'params'>, args: Args): Args {
  for (const name of Object.keys(args)) if (!action.params.some((p) => p.name === name)) refuse(`${action.name} takes no ${name}`)
  for (const p of action.params) {
    const value = args[p.name]
    if (value === undefined) {
      if (p.required) refuse(`${action.name} needs ${p.name}`)
      continue
    }
    const ok =
      p.type === 'string' ? typeof value === 'string' : p.type === 'integer' ? Number.isSafeInteger(value) && (value as number) >= 1 : value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!ok) refuse(`${p.name} is ${KINDS[p.type]}`)
  }
  return args
}

/** The typed door's help: HOW, then each action with its key, then the settings. */
export function help(): string {
  const lines = [HOW, '', 'Actions:']
  for (const a of ACTIONS) {
    const positional = a.params.filter((p) => p.positional).map((p) => `<${p.name}>`)
    const flags = a.params.filter((p) => !p.positional).map((p) => (p.required ? `--${p.name} <${p.type === "string" ? "text" : "json"}>` : `[--${p.name} <${p.type === "string" ? "text" : "json"}>]`))
    lines.push('', `  forest ${[a.name, ...positional, ...flags].join(' ')}`, `    ${a.does}`, `    Key: ${keyNeeded(a)}.`)
  }
  lines.push(
    '',
    'Settings, as a flag or in the environment:',
    '  --host <origin>, FOREST_HOSTS (comma separated)   the hosts to start from; the index\'s public list if none',
    '  --index <url>, FOREST_INDEX                       the index read for markets and scores',
    '  --profile <address>, FOREST_PROFILE               the profile acted for',
    'Keys, in the environment only: FOREST_WRITE_KEY, FOREST_MESSAGE_KEY, FOREST_READ_KEY.',
    'Objects are given as JSON. Every answer is JSON; a refusal is one line, and exit status 1.',
    '',
    'forest mcp [--http [hostname:]port]   the same actions as MCP tools, over stdio, or over HTTP for a hosted copy',
  )
  return lines.join('\n')
}

export { Refusal }
