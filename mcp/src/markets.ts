// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network, through its own
// package, @foundationforest/markets: the directory, each market file, and checkEntry, which
// tools/write.ts runs on a public entry's body before this copy signs it, the one check the index
// lists by.
//
// The kinds of entry are the markets manual's, the same in every market: post, review, vouch and
// report, each with the fields every market's hold (the package's SHARED: a post's contact, and what
// every review, vouch and report holds). An entry of a kind sits at `<kind>/<id>`. What each type
// holds is the checkout's build/types.json, beside the package.

import { readFileSync } from 'node:fs'
import { type Fields, type Market, SHARED, loadMarkets } from '@foundationforest/markets'
import { refuse } from './forest.ts'

/** The markets checkout beside this directory, read once. */
export const markets = loadMarkets()

/** build/types.json, from the same checkout: each type, with its description. */
const TYPES = JSON.parse(readFileSync(new URL('types.json', import.meta.resolve('@foundationforest/markets/package.json')), 'utf8')) as { $defs: { [type: string]: { description: string } } }

/** The kinds of entry every market defines: post, review, vouch and report. */
export const KINDS = Object.keys(SHARED)

/** A market's file, by a name the directory lists. */
export function marketFile(name: string): Market {
  return markets.market(name) ?? refuse(`${name} is not a market in the directory; markets lists them`)
}

/** The post fields that matter first: the file's `preview`, else description, price, then the place fields, of those it has. */
export function previewOf(market: Market): string[] {
  if (market.preview) return market.preview
  const post = market.post
  return [...['description', 'price'].filter((name) => name in post), ...Object.keys(post).filter((name) => post[name]!.type === 'place')]
}

/**
 * Each kind's fields in this market: a post's are the file's and contact; a review's, a vouch's and
 * a report's are the ones every market's hold, a review's with the file's own beside them. The file
 * names no shared field, so they are given here: an AI reads them before it writes one.
 */
export function kindsOf(market: Market): { [kind: string]: Fields } {
  return { post: { ...market.post, ...SHARED.post }, review: { ...SHARED.review, ...market.review }, vouch: SHARED.vouch, report: SHARED.report }
}

/** What each type the fields of `kinds` use holds, in build/types.json's words, a place's rule among them. */
export function typesOf(kinds: { [kind: string]: Fields }): { [type: string]: string } {
  const used = new Set(Object.values(kinds).flatMap((fields) => Object.values(fields).map((field) => field.type)))
  return Object.fromEntries([...used].map((type) => [type, TYPES.$defs[type]!.description]))
}
