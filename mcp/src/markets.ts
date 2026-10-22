// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network: the directory,
// each market file, and the nine types fields are (build/types.json). A post's or a review's body
// is checked against its market's fields before anything is signed, each field against a JSON
// Schema made from its type in types.json and the market file, so a mistake is refused naming the
// field, before a host sees it.
//
// A field the market marks `required` is not asked for here: the markets manual says an app asks
// for it and nothing enforces it.

import { readFileSync } from 'node:fs'
import type { Body, View } from '@foundationforest/records'
import { PATH, publicKeyFromAddress } from '@foundationforest/records'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import { type Context, folder, profileOf, refuse } from './forest.ts'

const ROOT = new URL('../../markets/', import.meta.url)

export type Field = { type: string; description: string; values?: string[]; many?: true; required?: true; roles?: string[] }
export type Market = {
  name: string
  description: string
  roles: Array<{ role: string; posts: 'offers' | 'requests' | 'posts' }>
  offer: { [name: string]: Field }
  review: { shared: string[]; fields?: { [name: string]: Field } }
  payment: Body
  howDealsGo: string
}
type Listed = Pick<Market, 'name' | 'description' | 'roles'>

function read(path: string): unknown {
  try {
    return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
  } catch (err) {
    return refuse(`no markets checkout to read ${path} from (${(err as Error).message}); ./standard.sh makes it`)
  }
}

let listed: Listed[] | undefined
/** The directory: every market, its description and its roles, as directory.json lists them. */
export function directory(): Listed[] {
  return (listed ??= (read('directory.json') as { markets: Listed[] }).markets)
}

/** A market's file, by a name the directory lists. */
export function marketFile(name: string): Market {
  if (!directory().some((m) => m.name === name)) refuse(`${name} is not a market in the directory; markets lists them`)
  return read(`markets/${name}.json`) as Market
}

// ---------------------------------------------------------------------------------------------
// Checking a body

const types = read('build/types.json') as { $id: string }
const ajv = new Ajv2020({ strict: true, allErrors: true })
formats.default(ajv)
ajv.addSchema(types)

/** What each type takes, in words, for a refusal. */
const TAKES: { [type: string]: string } = {
  text: 'text',
  number: 'a number as decimal text, such as "2.5"',
  words: 'a list of short words',
  place: '{ lat, lon, precisionKm, area }, lat and lon as decimal text, with online: true and reachKm if wanted; or { online: true }',
  money: '{ amount, currency, per }: amount as decimal text, currency a code such as USD, per if wanted',
  moment: 'a time in RFC 3339 with its zone, such as 2026-11-02T18:00:00+01:00, or { from, to }',
  blob: '{ sha256, mimeType, size }: a blob on the folder\'s hosts',
  hours: '{ zone, slots: [{ days, from, to }] }: days as monday to sunday, times as HH:MM',
}

const compiled = new Map<string, ValidateFunction>()
/** A field's schema: its type from types.json, a choice's values, a list of either when `many`. */
function validator(field: Field): ValidateFunction {
  const key = JSON.stringify([field.type, field.values, field.many])
  let validate = compiled.get(key)
  if (!validate) {
    const one = field.type === 'choice' ? { type: 'string', enum: field.values } : { $ref: `${types.$id}#/$defs/${field.type}` }
    validate = ajv.compile(field.many ? { type: 'array', uniqueItems: true, items: one } : one)
    compiled.set(key, validate)
  }
  return validate
}

const takes = (field: Field) => {
  const one = field.type === 'choice' ? `one of ${field.values!.join(', ')}` : TAKES[field.type]!
  return field.many ? `a list, each different, each ${one}` : one
}

/** Each field of `body` checked against `fields`: one the market names, for this role, of its type. */
async function checkFields(body: Body, fields: { [name: string]: Field }, where: string, forRoles: string, role: string | (() => Promise<string | undefined>)) {
  for (const [name, value] of Object.entries(body)) {
    const field = fields[name] ?? refuse(`${where} has no field ${name}`)
    if (field.roles) {
      const is = typeof role === 'string' ? role : await role()
      if (!is || !field.roles.includes(is)) refuse(`${name} is for ${forRoles} ${field.roles.join(' or ')}`)
    }
    if (!validator(field)(value)) refuse(`${name} takes ${takes(field)}`)
  }
}

/** The market and role the profile's own profile record names. */
function marketOf(view: View): { market: Market; role: string } {
  const body = profileOf(view)
  if (typeof body?.market !== 'string' || typeof body.role !== 'string') refuse(`${view.profile} has no profile record naming its market and role, so its posts and reviews cannot be checked`)
  return { market: marketFile(body.market), role: body.role }
}

const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A post's body, checked against the fields of the profile's market, for its role. */
export async function checkPost(view: View, body: unknown): Promise<Body> {
  if (!isObject(body)) refuse('the body is an object')
  const { market, role } = marketOf(view)
  if (!market.roles.some((r) => r.role === role)) refuse(`${role} is not a role in ${market.name}: its roles are ${market.roles.map((r) => r.role).join(', ')}`)
  await checkFields(body, market.offer, `a post in ${market.name}`, 'posts by', role)
  return body
}

/** A post's full address, `<profile address>/offer/<id>`, or a refusal naming `name`. */
export function checkPostAddress(text: unknown, name: string): string {
  const [address, ...rest] = typeof text === 'string' ? text.split('/') : []
  const path = rest.join('/')
  if (!publicKeyFromAddress(address) || rest.length !== 2 || rest[0] !== 'offer' || !PATH.test(path)) refuse(`${name} is a post's address: <profile address>/offer/<id>`)
  return text as string
}

/** The shared review fields, by name: each one's meaning, as the markets manual gives it. */
const SHARED: { [name: string]: (value: unknown) => void } = {
  subject: (v) => publicKeyFromAddress(v) || refuse("subject is the address of the profile the review is about"),
  score: (v) => (typeof v === 'string' && /^(10(\.0)?|[1-9](\.[0-9])?)$/.test(v)) || refuse('score is "1" to "10" as decimal text, at most one decimal, such as "8.5"'),
  text: (v) => typeof v === 'string' || refuse('text takes text'),
  offer: (v) => checkPostAddress(v, 'offer'),
  evidence: (v) => typeof v === 'string' || refuse('evidence takes text: a receipt address or a payment signature'),
}

/**
 * A review's body, checked against the profile's market: the shared fields it lists, by their
 * meaning, then the fields it adds. A field for reviews of some roles reads the subject's profile
 * record for its role, only when the body holds one.
 */
export async function checkReview(ctx: Context, view: View, body: unknown): Promise<Body> {
  if (!isObject(body)) refuse('the body is an object')
  const { market } = marketOf(view)
  const where = `a review in ${market.name}`
  if (body.subject === undefined) refuse('a review names its subject: the address of the profile it is about')
  const rest: Body = {}
  for (const [name, value] of Object.entries(body)) {
    if (market.review.shared.includes(name)) SHARED[name]!(value)
    else rest[name] = value
  }
  const subjectRole = async () => {
    const role = profileOf(await folder(ctx, body.subject as string))?.role
    return typeof role === 'string' ? role : undefined
  }
  await checkFields(rest, market.review.fields ?? {}, where, 'reviews of', subjectRole)
  return body
}
