// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network, through its own
// package, @foundationforest/markets: the directory, each market file, and checkEntry, which
// tools/write.ts runs on a public entry's body before this copy signs it, the one check the index
// lists by.
//
// The kinds of entry are the markets manual's, the same in every market: post, and review, vouch and
// report, whose fields every market's hold (the package's SHARED). An entry of a kind sits at
// `<kind>/<id>`.

import { type Fields, type Market, SHARED, loadMarkets } from '@foundationforest/markets'
import { refuse } from './forest.ts'

/** The markets checkout beside this directory, read once. */
export const markets = loadMarkets()

/** The kinds of entry every market defines: post, then review, vouch and report. */
export const KINDS = ['post', ...Object.keys(SHARED)]

/** A market's file, by a name the directory lists. */
export function marketFile(name: string): Market {
  return markets.market(name) ?? refuse(`${name} is not a market in the directory; markets lists them`)
}

/** The fields a post's preview shows first: the file's `preview`, else description, price, then the first place field, of those it has. */
export function previewOf(market: Market): string[] {
  if (market.preview) return market.preview
  const post = market.post
  const place = Object.keys(post).find((name) => post[name]!.type === 'place')
  return ['description', 'price', place].filter((name): name is string => name !== undefined && name in post)
}

/**
 * Each kind's fields in this market: a post's are the file's; a review's, a vouch's and a report's
 * are the ones every market's hold, a review's with the file's own beside them. The file names no
 * shared field, so they are given here: an AI reads them before it writes one.
 */
export function kindsOf(market: Market): { [kind: string]: Fields } {
  return { post: market.post, review: { ...SHARED.review, ...market.review }, vouch: SHARED.vouch, report: SHARED.report }
}
