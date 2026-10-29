// What this copy checks before it signs a public entry for one of the person's profiles: its body
// against the profile's market, from the checkout at MARKETS (../markets), never over the network,
// as the index checks what it lists (index/src/markets.ts). A refusal names the field.
//
// An entry of a kind sits at `<kind>/<id>`, and its body is checked against a JSON Schema made from
// each field's type in build/types.json: a field the market names for that kind, for the writer's
// role (an `offer` field's `roles`) or the subject's (a `review` field's, read from the subject's
// profile entry), of its type, a choice among its values, a `file` one of the body's `files`.
// `files` is the standard's, checked with the entry, and no market's field. Shared names are
// checked by their meaning in the markets manual: `subject` an address, `score` "1" to "10" with at
// most one decimal, `offer` a post's full address, `text` and `evidence` text; a kind with `subject`
// among its shared names needs one. A field marked `required` is not asked for: the manual says an
// app asks for it, and nothing enforces it.

import { type Body, PATH, filesOf, publicKeyFromAddress } from '@foundationforest/folders'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import { refuse } from './forest.ts'
import { type Field, type Fields, type Market, kinds, kindsOf, read } from './markets.ts'

/** The market's role, or a refusal naming its roles. */
export function checkRole(market: Market, role: string): void {
  if (!market.roles.some((r) => r.role === role)) refuse(`${role} is not a role in ${market.name}: its roles are ${market.roles.map((r) => r.role).join(', ')}`)
}

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
  file: 'the SHA-256 of one of the files the body lists in files, in lowercase hex',
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

/** Each field of `body` checked against `fields`: one the market names, for this role, of its type; a file one of `files`. */
async function checkFields(body: Body, fields: Fields, files: string[], where: string, forRoles: string, role: string | (() => Promise<string | undefined>)) {
  for (const [name, value] of Object.entries(body)) {
    if (name === 'files') continue
    const field = fields[name] ?? refuse(`${where} has no field ${name}`)
    if (field.roles) {
      const is = typeof role === 'string' ? role : await role()
      if (!is || !field.roles.includes(is)) refuse(`${name} is for ${forRoles} ${field.roles.join(' or ')}`)
    }
    if (!validator(field)(value)) refuse(`${name} takes ${takes(field)}`)
    if (field.type === 'file' && !(field.many ? (value as string[]) : [value as string]).every((sha256) => files.includes(sha256))) refuse(`${name} names a file the body's files do not list`)
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
  evidence: (v) => typeof v === 'string' || refuse("evidence is text: <chain>:<id>, the chain in CAIP-2 form, such as a payment's signature on Solana"),
}

/**
 * A public write of `body` at `path`, as `role` in `market`, checked: the path is `<kind>/<id>` of a
 * kind the market defines; a null body removes it and is not checked further. A field-map kind
 * (`offer`): each field one the market names, for the writer's role. A kind with shared names
 * (`review`): `subject` named, each shared name by its meaning, then the fields the market adds, a
 * field kept for some roles checked against the subject's role, which `subjectRole` reads from the
 * subject's hosts only when the body holds one.
 */
export async function checkWrite(market: Market, role: string, path: string, body: Body | null, subjectRole: (address: string) => Promise<string | undefined>): Promise<void> {
  checkRole(market, role)
  const [kind, ...rest] = path.split('/')
  const found = kinds().find((k) => k.name === kind)
  if (!found || !kindsOf(market).includes(kind!)) refuse(`${market.name} has no kind ${kind}: its kinds are ${kindsOf(market).join(', ')}`)
  if (rest.length !== 1) refuse(`an entry of a kind sits at ${kind}/<id>, one segment after the kind`)
  if (body === null) return
  const files = filesOf(body).map((f) => f.sha256)
  const a = /^[aeiou]/.test(kind!) ? 'an' : 'a'
  const where = `${a} ${kind} in ${market.name}`
  if (!found.shared) return checkFields(body, market[kind!] as Fields, files, where, `${kind}s by`, role)
  const spec = market[kind!] as { shared: string[]; fields?: Fields }
  if (spec.shared.includes('subject') && body.subject === undefined) refuse(`${a} ${kind} names its subject: the address of the profile it is about`)
  const own: Body = {}
  for (const [name, value] of Object.entries(body)) {
    if (spec.shared.includes(name)) SHARED[name]?.(value)
    else own[name] = value
  }
  await checkFields(own, spec.fields ?? {}, files, where, `${kind}s of`, () => subjectRole(body.subject as string))
}
