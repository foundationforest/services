// The markets, from the markets checkout standard.sh fetches at the commit in MARKETS (../markets
// from this directory): directory.json, each market's file, and build/types.json. Nothing is read
// over the network at run time.
//
// A market's check, for a post and for a review, a vouch or a report, reads its file as the markets
// manual says (build/README.md there), and as the mcp checks a body before it signs one: each field
// is one the market names, for the role, of its type in types.json; a choice takes only its values;
// `many` holds a list of the type, each different; a `file` names one of the body's `files`.
// `files` itself is the standard's, checked with the entry, and no market's field. `required` is for
// apps to ask for, and nothing enforces it, so neither does this.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Body, PATH, filesOf, publicKeyFromAddress } from '@foundationforest/folders'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'

export type Field = { type: string; description?: string; values?: string[]; many?: true; required?: true; roles?: string[] }
export type Role = { role: string; posts: 'offers' | 'requests' | 'posts' }
/** The kinds of entry about a profile, each naming it as its subject: review/<id>, vouch/<id>, report/<id>. */
export type About = 'review' | 'vouch' | 'report'
/** Each kind's plural, as its words say it and its table is named. */
export const MANY: { [kind in About]: string } = { review: 'reviews', vouch: 'vouches', report: 'reports' }
export type Market = {
  name: string
  description: string
  roles: Role[]
  offer: { [name: string]: Field }
  /** The offer fields a post's preview shows first, in order; served as the file holds it. */
  preview?: string[]
  review: { shared: string[]; fields?: { [name: string]: Field } }
  vouch: { shared: string[]; fields?: { [name: string]: Field } }
  report: { shared: string[]; fields?: { [name: string]: Field } }
  payment: { [name: string]: unknown }
  howDealsGo: string
}

export type Markets = {
  /** Every market, in the directory's order. */
  list: Market[]
  get(name: string): Market | undefined
  /** The market's file, as the checkout holds it. */
  file(name: string): unknown
  /** Why a post by `role` in `market` does not fit its market, or null when it does. */
  checkPost(market: string, role: string, body: unknown): string | null
  /** Why a review, vouch or report in `market` does not fit, or null when it does; `subjectRole`, when known, is the role a field's `roles` is read against. */
  checkAbout(kind: About, market: string, subjectRole: string | null, body: unknown): string | null
}

/** A post's full address, `<profile address>/offer/<id>`: its profile and its path, or null. */
export function postAddress(text: unknown): { profile: string; path: string } | null {
  if (typeof text !== 'string') return null
  const [profile, ...rest] = text.split('/')
  const path = rest.join('/')
  if (!publicKeyFromAddress(profile) || rest.length !== 2 || rest[0] !== 'offer' || !PATH.test(path)) return null
  return { profile: profile!, path }
}

const isObject = (v: unknown): v is { [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The hashes of the files a body lists in `files`, the standard's field, which the entry's own check took. */
const namedFiles = (body: unknown): string[] => (isObject(body) ? filesOf(body as Body).map((f) => f.sha256) : [])

/** The fields every market shares on a review, a vouch and a report, each by its meaning (build/README.md, Shared names). */
const SHARED: { [name: string]: (value: unknown) => string | null } = {
  subject: (v) => (publicKeyFromAddress(v) ? null : 'its subject is not an address'),
  score: (v) => (typeof v === 'string' && /^(10(\.0)?|[1-9](\.[0-9])?)$/.test(v) ? null : 'its score is not "1" to "10" with at most one decimal'),
  text: (v) => (typeof v === 'string' ? null : 'its text is not text'),
  offer: (v) => (postAddress(v) ? null : "its offer is not a post's address, <profile address>/offer/<id>"),
  evidence: (v) => (typeof v === 'string' ? null : 'its evidence is not text'),
}

/** The markets in the checkout at `dir`. */
export function loadMarkets(dir: string): Markets {
  const json = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))
  const directory = json('directory.json') as { markets: Array<{ name: string }> }
  const types = json('build/types.json') as { $id: string }
  const files = new Map<string, unknown>()
  for (const { name } of directory.markets) files.set(name, json(`markets/${name}.json`))
  const markets = new Map([...files].map(([name, file]) => [name, file as Market]))

  const ajv = new Ajv2020({ strict: false })
  formats.default(ajv)
  ajv.addSchema(types)
  const compiled = new Map<string, ValidateFunction>()
  const validator = (field: Field) => {
    const key = JSON.stringify([field.type, field.values, field.many])
    let v = compiled.get(key)
    if (!v) {
      const one = field.type === 'choice' ? { type: 'string', enum: field.values } : { $ref: `${types.$id}#/$defs/${field.type}` }
      compiled.set(key, (v = ajv.compile(field.many ? { type: 'array', uniqueItems: true, items: one } : one)))
    }
    return v
  }

  /** Why `body` does not fit `fields` for `role` (null: any role), or null. */
  const fit = (body: unknown, fields: { [name: string]: Field }, role: string | null, market: string, files: string[]): string | null => {
    if (!isObject(body)) return 'it is not an object'
    for (const [name, value] of Object.entries(body)) {
      if (name === 'files') continue
      const field = fields[name]
      if (!field) return `it has a field the ${market} market does not name: ${name}`
      if (field.roles && role !== null && !field.roles.includes(role)) return `${name} is a field for ${field.roles.join(' or ')} in the ${market} market`
      if (!validator(field)(value)) return `its ${name} is not a ${field.many ? `list of ${field.type}` : field.type} as the ${market} market takes it`
      if (field.type === 'file' && !(field.many ? (value as string[]) : [value as string]).every((sha256) => files.includes(sha256))) return `its ${name} names a file its files do not list`
    }
    return null
  }

  return {
    list: [...markets.values()],
    get: (name) => markets.get(name),
    file: (name) => files.get(name),
    checkPost(name, role, body) {
      const market = markets.get(name)
      if (!market) return `${name} is not a market in the directory`
      if (!market.roles.some((r) => r.role === role)) return `${role} is not a role in the ${name} market`
      return fit(body, market.offer, role, name, namedFiles(body))
    },
    checkAbout(kind, name, subjectRole, body) {
      const market = markets.get(name)
      if (!market) return `${name} is not a market in the directory`
      if (!isObject(body)) return 'it is not an object'
      const { subject: _, score: __, text: ___, offer: ____, evidence: _____, ...added } = body
      for (const shared of Object.keys(SHARED)) {
        if (!(shared in body)) continue
        if (!market[kind].shared.includes(shared)) return `the ${name} market's ${MANY[kind]} hold no ${shared}`
        const wrong = SHARED[shared]!(body[shared])
        if (wrong) return wrong
      }
      if (!('subject' in body)) return 'it names no subject'
      return fit(added, market[kind].fields ?? {}, subjectRole, name, namedFiles(body))
    },
  }
}
