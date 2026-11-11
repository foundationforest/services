// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network, through its own
// package, @foundationforest/markets: the directory, each market file, and checkEntry, which
// tools/write.ts runs on a public entry's body before this copy signs it, the one check the index
// lists by. A copy reads them once, at start (server.ts); a test hands it a checkout of its own.
//
// The kinds of entry are the markets manual's, the same in every market: listing, review, vouch and
// report, each with the fields every market's hold (the package's SHARED: a listing's contact, and
// what every review, vouch and report holds). An entry of a kind sits at `<kind>/<id>`. What each
// type holds is the checkout's build/types.json, and what each key of a market's file means is its
// build/market.schema.json, both beside the package: the format, the same for any checkout.

import { readFileSync } from 'node:fs'
import { type Fields, type Market, type Markets, SHARED } from '@foundationforest/markets'
import { refuse } from './forest.ts'

/** A file beside the package, in build/. */
const beside = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.resolve('@foundationforest/markets/package.json')), 'utf8'))

/** build/types.json: each type's definition, as an entry holds its value, its description among it. */
const TYPES = beside('types.json') as { $defs: { [type: string]: { description: string } } }

/** build/market.schema.json: what each key of a market's file and of each of its fields means, in its descriptions. */
type Described = { [key: string]: { description?: string } }
const SCHEMA = beside('market.schema.json') as { properties: Described; $defs: { field: { properties: Described } } }

/** The kinds of entry every market defines: listing, review, vouch and report. */
export const KINDS = Object.keys(SHARED)

/** A market's file, by a name the directory lists. */
export function marketFile(markets: Markets, name: string): Market {
  return markets.market(name) ?? refuse(`${name} is not a market in the directory; markets lists them`)
}

/**
 * Each kind's fields in this market: a listing's are the file's and contact; a review's, a vouch's
 * and a report's are the ones every market's hold, a review's with the file's own beside them. The
 * file names no shared field, so they are given here: an AI reads them before it writes one.
 */
export function kindsOf(market: Market): { [kind: string]: Fields } {
  return { listing: { ...market.listing, ...SHARED.listing }, review: { ...SHARED.review, ...market.review }, vouch: SHARED.vouch, report: SHARED.report }
}

/** Each type the fields of `kinds` use, as build/types.json defines it: its shape, such as a place's lat, lon, radiusKm and area, with its description. */
export function typesOf(kinds: { [kind: string]: Fields }): { [type: string]: unknown } {
  const used = new Set(Object.values(kinds).flatMap((fields) => Object.values(fields).map((field) => field.type)))
  return Object.fromEntries([...used].map((type) => [type, TYPES.$defs[type]!]))
}

/**
 * What each key means, in market.schema.json's words: the market's own keys, `review` among them
 * since every kind holds one, and each key its fields use, in the schema's order. A market file
 * alone does not say that any field may be left out, that `many` makes a list, that `radiusKm` is
 * only where a new place starts, or that `roles` on a review field names the profile reviewed;
 * given only the file, an AI guesses each (the markets manual, From a program).
 */
export function keysOf(market: Market, kinds: { [kind: string]: Fields }): { market: { [key: string]: string }; field: { [key: string]: string } } {
  const said = (described: Described, keys: Set<string>) => Object.fromEntries(Object.entries(described).flatMap(([key, d]) => (keys.has(key) && d.description ? [[key, d.description]] : [])))
  const used = new Set(Object.values(kinds).flatMap((fields) => Object.values(fields).flatMap((field) => Object.keys(field))))
  return { market: said(SCHEMA.properties, new Set([...Object.keys(market), 'preview', 'review'])), field: said(SCHEMA.$defs.field.properties, used) }
}
