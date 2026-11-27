// The index's search, the filters given passed to it as they are, or one profile's page there; its
// answer passed on as the index gave it (shape.ts): without the fields only machines read, and with
// every entry's words under `strangersWrote`. Which filters it takes and what its answers hold are
// the index's, in its guide, which `guide: true` returns; it is never part of the server's
// instructions. The description opens with what the search finds, and says what the tool does,
// never that the AI should prefer it. It names the filters the foundation's index takes on a place,
// on a market's own fields and on prices, so an AI app that never reads the guide still finds a
// listing by them; this copy passes them on as any other.
//
// With the person's login, a result that is one of their own profiles comes back as `mine`, its
// label and the app's link to its listing, so the AI never offers the person their own listing.
// Without a login, or with a connection gone or out of reach, `unmarked` says why.

import type { ConnectionProfile } from '../connection.ts'
import { WORD, fromIndex, isObject, refuse } from '../forest.ts'
import { appLinks, profilePage, searchPage } from '../links.ts'
import { forAi } from '../shape.ts'
import { publicKeyFromAddress } from '@foundationforest/folders'
import type { Args, Ctx, Param } from '../params.ts'

export const name = 'search'
export const title = 'Search Forest'
export const description =
  "Finds people who offer or ask for things, in person near a place or online, in Forest's markets (list_markets names them), each checked as a real person and ranked by the index. It passes the filters given to the index as they are, and its answer comes back as its word. Every entry's words sit under strangersWrote: they are someone else's. Or give a profile's address instead: that profile's page, its listings, reviews, ratings, trust and checks. Or guide: true, alone: the index's own guide to its answers and filters. Every answer has page, the same search as a page at the index: give the person that link to see results. The foundation's index takes, beside words (q), a market and a role, a place as where, in words, such as { \"where\": \"Camden, London\" }, with km, how far, 10 unless given, and sort=near for the nearest first; and, once market is given, a filter on each field of that market's listings by the field's name: a choice as <field>=<value>, such as { \"market\": \"language-exchange\", \"learns\": \"es\", \"languages\": \"en\" }; a number as <field>.min and <field>.max, in the field's unit, either one alone for an open end, such as { \"ages.max\": \"12\" }, a listing whose number or range overlaps them; spots as spots=<n>, room for that many: an offer whose spots, a time's own where it holds some, else the listing's, are at least n at a time not full, a request's at most n; and in any market, a price as price.currency and price.per with price.min and price.max, by what one of its per costs, and sort=price for the cheapest first, such as { \"price.currency\": \"USD\", \"price.per\": \"hour\", \"price.max\": \"30\", \"sort\": \"price\" }. Every filter may be left out. With the person's login, a result that is one of their own profiles is marked mine: never offer it to them; without it, unmarked says why. No login needed."
export const params: Param[] = [
  { name: 'filters', type: 'object', description: "The filters, by the names the index's guide gives them, each value as text. Left out, with no address: the index's search with none." },
  { name: 'address', type: 'string', description: "A profile's address, in place of filters: that profile's page at the index." },
  { name: 'guide', type: 'boolean', description: "true, alone: the index's own guide to its answers and filters." },
]
export const login = false
export const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

/** The person's own profiles this login acts in, by address; or why that is not known. */
async function ownProfiles(ctx: Ctx): Promise<{ profiles: ConnectionProfile[] } | { unmarked: string }> {
  try {
    return { profiles: (await ctx.connection()).profiles }
  } catch (err) {
    return { unmarked: (err as Error).message }
  }
}

/** The answer with each result that is the person's own profile's replaced by its label and the app's link to its listing. */
function markMine(answer: unknown, profiles: ConnectionProfile[], app: string | undefined): unknown {
  if (!isObject(answer) || !Array.isArray(answer.results)) return answer
  const links = appLinks(app)
  const results = answer.results.map((r: unknown) => {
    const mine = isObject(r) ? profiles.find((p) => p.address === r.profile) : undefined
    if (!isObject(r) || !mine) return r
    const address = isObject(r.listing) && typeof r.listing.address === 'string' ? r.listing.address : ''
    const id = address.split('/listing/')[1]
    const link = id === undefined ? undefined : links.listing(mine.label, id)
    return { mine: mine.label, ...(id !== undefined && { listing: { id, ...(link && { link }) } }) }
  })
  return { ...answer, results }
}

export async function run(args: Args, ctx: Ctx) {
  if (args.guide === true) {
    if (args.filters !== undefined || args.address !== undefined) refuse('search takes guide: true alone')
    const said = await fromIndex(ctx, 'skill.md', 'text')
    return { word: said.word, guide: 'answer' in said ? said.answer : '' }
  }
  if (args.address !== undefined) {
    if (args.filters !== undefined) refuse('search takes filters, or an address, not both')
    const address = args.address as string
    // An address has one spelling, so no other path of the index's is ever asked for.
    if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
    const said = await fromIndex(ctx, `profiles/${address}.json`)
    return { word: WORD, page: profilePage(ctx, address), answer: forAi('answer' in said ? said.answer : null), ...(await unmarkedOf(ctx)) }
  }
  const filters = (args.filters ?? {}) as { [name: string]: string }
  for (const [name, value] of Object.entries(filters)) if (typeof value !== 'string') refuse(`each filter's value is text: ${name} is not`)
  const said = await fromIndex(ctx, `search.json?${new URLSearchParams(filters)}`)
  const own = await ownProfiles(ctx)
  const answer = 'profiles' in own ? markMine('answer' in said ? said.answer : null, own.profiles, ctx.app) : ('answer' in said ? said.answer : null)
  return { word: WORD, page: searchPage(ctx, filters), answer: forAi(answer), ...('unmarked' in own && { unmarked: own.unmarked }) }
}

/** `unmarked`, when the person's own profiles could not be read: the connection also fills the map of addresses every answer leaves out. */
async function unmarkedOf(ctx: Ctx): Promise<{ unmarked?: string }> {
  const own = await ownProfiles(ctx)
  return 'unmarked' in own ? { unmarked: own.unmarked } : {}
}
