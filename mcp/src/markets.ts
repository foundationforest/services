// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network: the directory,
// each market file, and the market file's format (build/market.schema.json). This copy checks no
// body against a market: the person's app does, before it writes.
//
// The kinds of record a market defines are read from the format, not written here: a kind is a
// top-level property of a market file that is fields (`offer`) or holds fields beside shared names
// (`review`). A record of a kind sits at `<kind>/<id>`. So a market that adds a kind needs only
// MARKETS to move.

import { readFileSync } from 'node:fs'
import { isObject, refuse } from './forest.ts'

const ROOT = new URL('../../markets/', import.meta.url)

export type Field = { type: string; description: string; values?: string[]; many?: true; required?: true; roles?: string[] }
export type Fields = { [name: string]: Field }
export type Market = {
  name: string
  description: string
  roles: Array<{ role: string; posts: 'offers' | 'requests' | 'posts' }>
  preview?: string[]
  [key: string]: unknown
}
type Listed = Pick<Market, 'name' | 'description' | 'roles'>

/** A file from the markets checkout, as JSON. */
export function read(path: string): unknown {
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

/** A kind: a field map (its fields' roles are the writer's), or fields beside shared names (its fields' roles are the subject's). */
export type Kind = { name: string; shared: boolean }

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
