// The public entries the tools write in a profile's folder: a listing, a review, a vouch or a report,
// each at `<kind>/<id>`, checked against the profile's market with the markets package's checkEntry,
// the index's own check, before anything is signed, so a body refused here would not be listed. The
// subject of a review, vouch or report, and the profile a review's listing names, are checked to be
// addresses, which the markets manual leaves to the standard; a subject among the connection's own
// profiles is refused, as the Forest app refuses it, since nothing public links two profiles of one
// person for the index to catch.

import { randomBytes } from 'node:crypto'
import { type Body, FolderError, checkPath, hex, publicKeyFromAddress } from '@foundationforest/folders'
import type { Market } from '@foundationforest/markets'
import { folderAt, profileEntryOf, type Own } from './act.ts'
import { refuse } from './forest.ts'
import { marketFile } from './markets.ts'
import type { Ctx } from './params.ts'

/** A new id: 8 random bytes in hex, which says nothing of what it names. */
export const newId = () => hex.encode(randomBytes(8))

/** `path` as a path in a folder, or a refusal saying why it is none. */
export function pathOf(path: string): string {
  try {
    checkPath(path)
  } catch (err) {
    refuse(err instanceof FolderError ? `${path} is no path: ${err.message}` : String(err))
  }
  return path
}

/** The market the profile entry names, as the directory holds it. */
export function marketOf(ctx: Ctx, me: Own, profile: Body): Market {
  return typeof profile.market === 'string' ? marketFile(ctx.markets, profile.market) : refuse(`${me.label}'s profile entry names no market, so an entry has no kind to fit`)
}

/**
 * The role of the profile a review is about, read from its profile entry, when the body holds a field
 * the market keeps for some roles and that profile is in this market; else none, and checkEntry
 * leaves such a field unchecked.
 */
async function aboutRole(ctx: Ctx, market: Market, body: Body): Promise<string | undefined> {
  const fields = market.review ?? {}
  if (!Object.keys(body).some((name) => fields[name]?.roles) || !publicKeyFromAddress(body.subject)) return undefined
  const theirs = await folderAt(ctx, body.subject as string)
  const profile = theirs && profileEntryOf(theirs)
  return profile?.market === market.name && market.roles.some((r) => r.role === profile.role) ? (profile.role as string) : undefined
}

/** Why `body` does not fit as a `kind` entry by a `role` profile in `market`, or nothing: refused with the first reason. */
export async function checkPublic(ctx: Ctx, market: Market, role: string, kind: string, body: Body): Promise<void> {
  const why =
    ctx.markets.checkEntry(market.name, role, kind, body, kind === 'review' ? await aboutRole(ctx, market, body) : undefined) ??
    (kind === 'listing' || publicKeyFromAddress(body.subject) ? null : `subject is the address of the profile the ${kind} is about`) ??
    (kind === 'listing' || !(await ctx.connection()).profiles.some((p) => p.address === body.subject) ? null : `subject is one of the person's own profiles: a ${kind} is about someone else`) ??
    (kind !== 'review' || body.listing === undefined || publicKeyFromAddress((body.listing as string).split('/')[0]) ? null : "listing is a listing's address: <profile address>/listing/<id>")
  if (why) refuse(why)
}
