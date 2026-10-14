// What the two doors show, written once: how Forest works, and each action: what it does, the key
// it needs, its parameters, and the work it runs (forest.ts). The typed door prints this as its
// help and reads its arguments from it; the MCP door gives HOW to the AI first, as the server's
// instructions, and each action as a tool.

import type { Body } from '../../standard/records/src/index.ts'
import { type Context, Refusal, inbox, market, markets, postOffer, postReview, privateRecords, profile, refuse, removeOffer, request, send, updateOffer } from './forest.ts'

export const HOW = `Forest: people deal with each other directly, with nobody in the middle. A person's profiles are signed records on open hosts; an index reads them and publishes markets and scores, as its own word. This tool checks every signature itself, and keeps nothing.

- A person has one profile per market and role, such as tutoring/seller; markets lists the markets and their role words. Nothing public links one of a person's profiles to another: keep it so.
- Reading needs no key: markets, a market, any profile.
- To act for one profile, the person's app gives you its address (profile) and two keys, and keeps the main key. The writing key (writingKey) posts, updates and removes offers, and posts reviews. The inbox key (inboxKey) pulls and opens the profile's inbox, sends messages as the profile, and asks the person.
- Give the keys in each call that needs one (a copy started with keys needs none). This tool keeps no key.
- An offer from a buyer-side profile, such as tutoring/buyer, is a request: direction "request", for what the person is looking for.
- For anything else, ask the person. For money, or for what a key you don't hold would do, use ask, then tell the person to open their app and approve it with their face. A new profile or a removed key is not a request: tell the person to open their app and do it there.
- In an inbox, a message is a request only when it is marked as one; any other is just a message.`

export type Scope = 'write' | 'message' | 'read'

export type Param = {
  name: string
  /** integer: a whole number, from 1. */
  type: 'string' | 'object' | 'integer' | 'boolean'
  description: string
  required?: boolean
  /** The only values it takes. */
  values?: string[]
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
  /** false: a hosted copy leaves it out. */
  hosted?: false
  run: (args: Args, ctx: Context) => Promise<unknown>
}

type Args = { [name: string]: unknown }

const str = (args: Args, name: string) => args[name] as string
const obj = (args: Args, name: string) => args[name] as Body

const OFFER: Param = {
  name: 'offer',
  type: 'object',
  required: true,
  description: 'The offer, as records/schemas/offer.json shapes it: direction ("offer", or "request" for what the person is looking for), description, and if wanted price { amount, mint, per: hour | day | job }, terms { arbiter, timer { days, to } }, availability, remote, location, media, expires. Amounts and degrees are decimal text. createdAt is set if missing.',
}
const REVIEW: Param = {
  name: 'review',
  type: 'object',
  required: true,
  description: 'The review, as records/schemas/review.json shapes it: subject (the reviewed profile\'s address), and if wanted ratings { overall: "1" to "10", … }, text, media, dealId (the escrow receipt\'s address). createdAt is set if missing.',
}
const id = (prefix: string, required: boolean): Param =>
  required ? { name: 'id', type: 'string', required, description: `The id in ${prefix}/<id>.` } : { name: 'id', type: 'string', description: `The id in ${prefix}/<id>. A fresh one if omitted.` }

/**
 * What each request kind takes: the standard's kinds (records/README.md, Requests), which are the
 * actions here that need a key, by the standard's names, and pay. The offer and review tools check
 * their parameters against the same lists.
 */
export const REQUESTS = new Map<string, Param[]>([
  ['post-offer', [OFFER, id('offer', false)]],
  ['update-offer', [id('offer', true), OFFER]],
  ['remove-offer', [id('offer', true)]],
  ['post-review', [REVIEW, id('review', false)]],
  [
    'send',
    [
      { name: 'to', type: 'string', required: true, positional: true, description: "The recipient profile's address." },
      { name: 'text', type: 'string', description: 'The message, as text: sent as { "text": … }.' },
      { name: 'body', type: 'object', description: 'The message as an object, in place of text.' },
    ],
  ],
  ['inbox', [{ name: 'after', type: 'object', description: 'The cursors a pull returned, by host: { "<host>": <cursor> }. Omit for every message.' }]],
  ['private', [{ name: 'path', type: 'string', description: 'Only the records under this path, such as notes.' }]],
  [
    'pay',
    // Paying, which this tool never does: it is only ever asked for, naming the offer by its address.
    [
      { name: 'offer', type: 'string', required: true, description: "The offer's address: <profile address>/offer/<id>." },
      { name: 'units', type: 'integer', description: 'How many hours or days, for an offer priced per hour or per day: a whole number, from 1.' },
      { name: 'note', type: 'string', description: 'A note for the person.' },
    ],
  ],
])
const takes = (kind: string) => REQUESTS.get(kind)!

/** The action a message body asks for, when it is a request whose parameters fit that kind; else null. */
export function requestOf(body: Body): string | null {
  const { request: name, ...params } = body
  const fits = typeof name === 'string' ? REQUESTS.get(name) : undefined
  if (!fits) return null
  try {
    checkArgs({ name: name as string, params: fits }, params)
  } catch {
    return null
  }
  return name as string
}

const OFFER_ACTIONS = ['post', 'update', 'remove']

export const ACTIONS: Action[] = [
  {
    name: 'markets',
    does: "The markets an index uses, one line each, with each role's plain word, such as tutoring: teacher (seller), student (buyer). A profile's label is market/role. Needs an index set.",
    keys: [],
    params: [],
    run: (_args, ctx) => markets(ctx),
  },
  {
    name: 'market',
    does: "What an index says of a market, in that index's own format and by its own choice: its word, not signed records. Needs an index set.",
    keys: [],
    params: [{ name: 'market', type: 'string', required: true, positional: true, description: 'The market, as the first half of a label spells it, such as tutoring.' }],
    run: (args, ctx) => market(ctx, str(args, 'market')),
  },
  {
    name: 'profile',
    does: "A profile's card, its offers and the reviews it wrote, read from its hosts, every signature checked; and, if an index is set, that index's summary of it, such as its scores, without the offers and reviews the hosts already gave. The card's inbox key and its inbox's readers are left out unless publicKeys is true.",
    keys: [],
    params: [
      { name: 'address', type: 'string', required: true, positional: true, description: "The profile's address." },
      { name: 'publicKeys', type: 'boolean', description: "true for the card's inbox key and its inbox's readers too: public keys a message is sealed to, which send finds itself." },
    ],
    run: (args, ctx) => profile(ctx, str(args, 'address'), args.publicKeys === true),
  },
  {
    name: 'offer',
    does: "Post, update or remove an offer at offer/<id> in the profile's folder, on each of its hosts. An offer from a buyer-side profile is a request: direction \"request\". Only an offer an access key wrote can be updated or removed; one the owner wrote, only the owner's app can change.",
    keys: ['write'],
    params: [
      { name: 'action', type: 'string', required: true, positional: true, values: OFFER_ACTIONS, description: 'post, update or remove.' },
      { name: 'id', type: 'string', positional: true, description: 'The id in offer/<id>: needed to update or remove; a fresh one if omitted to post.' },
      { ...OFFER, required: false, description: `${OFFER.description} Needed to post or update.` },
    ],
    run: async (args, ctx) => {
      const { action, ...rest } = args as { action: string } & Args
      checkArgs({ name: `offer ${action}`, params: takes(`${action}-offer`) }, rest)
      if (action === 'post') return postOffer(ctx, rest.offer, rest.id as string | undefined)
      if (action === 'update') return updateOffer(ctx, str(rest, 'id'), rest.offer)
      return removeOffer(ctx, str(rest, 'id'))
    },
  },
  {
    name: 'review',
    does: "Write a review of another profile at review/<id> in the profile's folder, on each of its hosts.",
    keys: ['write'],
    params: takes('post-review'),
    run: (args, ctx) => postReview(ctx, args.review, args.id as string | undefined),
  },
  {
    name: 'inbox',
    does: "The messages to the profile, pulled from each of its hosts. Each is opened when the inbox key's read key is one of the inbox's readers; otherwise each shows who sent it and when, unopened. Give after, the cursors a pull returned, for newer messages only.",
    keys: ['message', 'read'],
    params: takes('inbox'),
    run: (args, ctx) => inbox(ctx, (args.after as { [host: string]: number } | undefined) ?? {}, requestOf),
  },
  {
    name: 'send',
    does: "Send a message to another profile's inbox, encrypted to its inbox key and the readers its inbox lists. Text also leaves a copy, { text, to }, in the profile's own inbox, where the person's app shows it.",
    keys: ['message'],
    params: takes('send'),
    run: async (args, ctx) => {
      if ((args.text === undefined) === (args.body === undefined)) refuse('give text or body, one of them')
      return send(ctx, str(args, 'to'), args.body !== undefined ? obj(args, 'body') : { text: str(args, 'text') })
    },
  },
  {
    name: 'ask',
    does: "Ask the person, through their own inbox, for what no key you hold does: a request, of one of the standard's kinds, with its parameters. Their app shows it, and does it with the main key, or not.",
    keys: ['message'],
    params: [
      {
        name: 'action',
        type: 'string',
        required: true,
        positional: true,
        values: [...REQUESTS.keys()],
        description: 'The kind: post-offer, update-offer and remove-offer (what offer does), post-review (what review does), send, inbox, private (the private records a read key opens), or pay.',
      },
      { name: 'params', type: 'object', description: 'Its parameters, as that kind takes them, such as { "offer": { … } } for post-offer, { "to": "<address>", "text": "…" } for send, or { "offer": "<profile address>/offer/<id>", "units": 2, "note": "…" } for pay, where units (how many hours or days) and note may be left out. Never a key.' },
    ],
    run: async (args, ctx) => {
      const name = str(args, 'action')
      const params = (args.params as Body | undefined) ?? {}
      checkArgs({ name, params: takes(name) }, params)
      return request(ctx, { ...params, request: name })
    },
  },
  {
    name: 'private',
    does: "The private records in the profile's folder that the read key opens.",
    keys: ['read'],
    params: takes('private'),
    // A hosted copy reads the inbox, not the folder's private records: those a read key opens
    // where forest runs on the person's own device (mcp/README.md, FAQ).
    hosted: false,
    run: (args, ctx) => privateRecords(ctx, args.path as string | undefined),
  },
]

/** The actions a hosted copy serves. */
export const HOSTED = ACTIONS.filter((a) => a.hosted !== false)

/** Which key an action needs, in the words the app gives the keys by. */
export function keyNeeded(action: Action): string {
  if (!action.keys.length) return 'No key'
  return action.keys[0] === 'write' ? 'Writing key' : 'Inbox key'
}

/** What an action says, at both doors: the key it needs, then what it does. */
export const described = (action: Action) => `${keyNeeded(action)}. ${action.does}`

const KINDS: { [type in Param['type']]: string } = { string: 'text', object: 'an object', integer: 'a whole number, from 1', boolean: 'true or false' }

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
      p.type === 'string'
        ? typeof value === 'string'
        : p.type === 'integer'
          ? Number.isSafeInteger(value) && (value as number) >= 1
          : p.type === 'boolean'
            ? typeof value === 'boolean'
            : value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!ok) refuse(`${p.name} is ${KINDS[p.type]}`)
    if (p.values && !p.values.includes(value as string)) refuse(`${p.name} is one of ${p.values.join(', ')}`)
  }
  return args
}

/** The typed door's help: HOW, then each action with its key, then the settings. */
export function help(): string {
  const lines = [HOW, '', 'Actions:']
  for (const a of ACTIONS) {
    const positional = a.params.filter((p) => p.positional).map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`))
    const flags = a.params.filter((p) => !p.positional).map((p) => (p.required ? `--${p.name} <${p.type === 'string' ? 'text' : 'json'}>` : `[--${p.name} <${p.type === 'string' ? 'text' : 'json'}>]`))
    lines.push('', `  forest ${[a.name, ...positional, ...flags].join(' ')}`, `    ${described(a)}`)
  }
  lines.push(
    '',
    'Settings, as a flag or in the environment:',
    '  --host <origin>, FOREST_HOSTS (comma separated)   the hosts to start from; the index\'s public list if none',
    '  --index <url>, FOREST_INDEX                       the index read for markets and scores',
    '  --profile <address>, FOREST_PROFILE               the profile acted for',
    'Keys, in the environment only, as the app gives them: FOREST_WRITING_KEY, FOREST_INBOX_KEY.',
    'Objects are given as JSON. Every answer is JSON; a refusal is one line, and exit status 1.',
    '',
    'forest mcp [--http [hostname:]port]   the same actions as MCP tools, over stdio, or over HTTP for a hosted copy',
  )
  return lines.join('\n')
}

export { Refusal }
