// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network: the directory,
// each market file, the nine types fields are (build/types.json), and the market file's format
// (build/market.schema.json). A body is checked against its market before it goes to the person's
// signer, each field against a JSON Schema made from its type in types.json and the market file, so
// a mistake is refused naming the field, before the person's device sees it.
//
// The kinds of record a market defines are read from the format, not written here: a kind is a
// top-level property of a market file that is fields (`offer`) or holds fields beside shared names
// (`review`). A record of a kind sits at `<kind>/<id>`. So a market that adds a kind needs only
// MARKETS to move, and no kind is ever `profile`, `hosts` or `rule`.
//
// A field the market marks `required` is not asked for here: the markets manual says an app asks
// for it and nothing enforces it.

import { readFileSync } from 'node:fs'
import type { Body } from '@foundationforest/records'
import { PATH, publicKeyFromAddress } from '@foundationforest/records'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import { type Context, folder, isObject, profileOf, refuse } from './forest.ts'

const ROOT = new URL('../../markets/', import.meta.url)

export type Field = { type: string; description: string; values?: string[]; many?: true; required?: true; roles?: string[] }
type Fields = { [name: string]: Field }
export type Market = {
  name: string
  description: string
  roles: Array<{ role: string; posts: 'offers' | 'requests' | 'posts' }>
  preview?: string[]
  [key: string]: unknown
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

/** The fields a post's preview shows first: the file's `preview`, else description, price, then the first place field, of those it has. */
export function previewOf(market: Market): string[] {
  if (market.preview) return market.preview
  const offer = (market.offer ?? {}) as Fields
  const place = Object.keys(offer).find((name) => offer[name]!.type === 'place')
  return ['description', 'price', place].filter((name): name is string => name !== undefined && name in offer)
}

/** The market's role, or a refusal naming its roles. */
export function checkRole(market: Market, role: string): void {
  if (!market.roles.some((r) => r.role === role)) refuse(`${role} is not a role in ${market.name}: its roles are ${market.roles.map((r) => r.role).join(', ')}`)
}

// ---------------------------------------------------------------------------------------------
// Kinds, from the market file's format

/** A kind: a field map (its fields' roles are the writer's), or fields beside shared names (its fields' roles are the subject's). */
type Kind = { name: string; shared: boolean }

const FIELDS_REF = '#/$defs/fields'
let formatKinds: Kind[] | undefined
/** Every kind the market file's format defines: each top-level property that is fields, or holds them. */
export function kinds(): Kind[] {
  if (formatKinds) return formatKinds
  const format = read('build/market.schema.json') as { properties: { [key: string]: { $ref?: string; properties?: { fields?: { $ref?: string } } } } }
  formatKinds = Object.entries(format.properties).flatMap(([name, p]): Kind[] =>
    p.$ref === FIELDS_REF ? [{ name, shared: false }] : p.properties?.fields?.$ref === FIELDS_REF ? [{ name, shared: true }] : [],
  )
  return formatKinds
}

/** The kinds this market's file defines, by name. */
export function kindsOf(market: Market): string[] {
  return kinds().filter((k) => isObject(market[k.name])).map((k) => k.name)
}

/** One of the market's kinds, or a refusal naming them. */
export function checkKind(market: Market, kind: string): Kind {
  const found = kinds().find((k) => k.name === kind)
  if (!found || !kindsOf(market).includes(kind)) refuse(`${market.name} has no kind ${kind}: its kinds are ${kindsOf(market).join(', ')}`)
  return found
}

/** An id, the one segment after a kind in its path. */
export function checkId(kind: string, id: unknown): void {
  if (typeof id === 'string' && (id.includes('/') || !PATH.test(`${kind}/${id}`))) refuse('an id is lowercase letters, digits, dots, underscores and dashes, up to 64, starting with a letter or digit')
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
async function checkFields(body: Body, fields: Fields, where: string, forRoles: string, role: string | (() => Promise<string | undefined>)) {
  for (const [name, value] of Object.entries(body)) {
    const field = fields[name] ?? refuse(`${where} has no field ${name}`)
    if (field.roles) {
      const is = typeof role === 'string' ? role : await role()
      if (!is || !field.roles.includes(is)) refuse(`${name} is for ${forRoles} ${field.roles.join(' or ')}`)
    }
    if (!validator(field)(value)) refuse(`${name} takes ${takes(field)}`)
  }
}

/** A post's full address, `<profile address>/offer/<id>`, or a refusal naming `name`. */
export function checkPostAddress(text: unknown, name: string): string {
  const [address, ...rest] = typeof text === 'string' ? text.split('/') : []
  const path = rest.join('/')
  if (!publicKeyFromAddress(address) || rest.length !== 2 || rest[0] !== 'offer' || !PATH.test(path)) refuse(`${name} is a post's address: <profile address>/offer/<id>`)
  return text as string
}

/** The shared names, by name: each one's meaning, as the markets manual gives it. A shared name with no meaning here passes as given. */
const SHARED: { [name: string]: (value: unknown) => void } = {
  subject: (v) => publicKeyFromAddress(v) || refuse('subject is the address of the profile the review is about'),
  score: (v) => (typeof v === 'string' && /^(10(\.0)?|[1-9](\.[0-9])?)$/.test(v)) || refuse('score is "1" to "10" as decimal text, at most one decimal, such as "8.5"'),
  text: (v) => typeof v === 'string' || refuse('text takes text'),
  offer: (v) => checkPostAddress(v, 'offer'),
  // A review's evidence is the person's signer's: it names the payment the profile made for the review's offer.
  evidence: () => refuse("evidence is the person's signer's to fill, from the payment it made for the review's offer: leave evidence out"),
}

/**
 * A body of `kind`, checked against the market, written as `role`. A field-map kind (`offer`): each
 * field one the market names, for the writer's role. A kind with shared names (`review`): `subject`
 * named, each shared name by its meaning, then the fields the market adds, a field kept for some
 * roles checked against the subject's role, read from its hosts only when the body holds one.
 */
export async function checkBody(ctx: Context, market: Market, role: string, kind: string, body: unknown): Promise<Body> {
  if (!isObject(body)) refuse('the body is an object')
  const { shared } = checkKind(market, kind)
  const a = /^[aeiou]/.test(kind) ? 'an' : 'a'
  const where = `${a} ${kind} in ${market.name}`
  if (!shared) {
    await checkFields(body, market[kind] as Fields, where, `${kind}s by`, role)
    return body
  }
  const spec = market[kind] as { shared: string[]; fields?: Fields }
  if (spec.shared.includes('subject') && body.subject === undefined) refuse(`${a} ${kind} names its subject: the address of the profile it is about`)
  const rest: Body = {}
  for (const [name, value] of Object.entries(body)) {
    if (spec.shared.includes(name)) SHARED[name]?.(value)
    else rest[name] = value
  }
  const subjectRole = async () => {
    const is = profileOf(await folder(ctx, body.subject as string))?.role
    return typeof is === 'string' ? is : undefined
  }
  await checkFields(rest, spec.fields ?? {}, where, `${kind}s of`, subjectRole)
  return body
}
