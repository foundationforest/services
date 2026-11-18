// The markets, from the checkout of foundationforest/markets at the commit in MARKETS that
// standard.sh makes beside this directory (../markets), never over the network, through its own
// package, @foundationforest/markets: the directory, each market file, checkEntry, which
// tools/write.ts runs on a public entry's body before this copy signs it, the one check the index
// lists by, and ask, which says what a market asks each role. A copy reads them once, at start
// (server.ts); a test hands it a checkout of its own.
//
// The kinds of entry are the markets manual's, the same in every market: listing, review, vouch and
// report, each with the fields every market's hold (the package's SHARED: a listing's contact, and
// what every review, vouch and report holds). An entry of a kind sits at `<kind>/<id>`.

import { type Asked, type Market, type Markets, SHARED, previewOf } from '@foundationforest/markets'
import { refuse } from './forest.ts'

/** The kinds of entry every market defines: listing, review, vouch and report. */
export const KINDS = Object.keys(SHARED)

/** A market's file, by a name the directory lists. */
export function marketFile(markets: Markets, name: string): Market {
  return markets.market(name) ?? refuse(`${name} is not a market in the directory; markets lists them`)
}

/**
 * How the values of each shared list the markets name are written, in place of its every value: the
 * markets' build/lists.json holds languages by their ISO 639-1 codes and countries by their ISO
 * 3166-1 alpha-2 codes, which any AI knows, and checkEntry refuses a code the list lacks. A list
 * not named here comes with its values, as any choice's.
 */
const LISTS: { [list: string]: string } = {
  languages: 'a language as its ISO 639-1 code in lower case, such as "es"',
  countries: 'a country as its ISO 3166-1 alpha-2 code in upper case, such as "MX"',
}

/** A field's words for one role, as ask gives them: where it sits in the order, and how to ask it. */
type Words = Pick<Asked, 'name' | 'label' | 'question' | 'hint' | 'start'>
const wordsOf = ({ name, label, question, hint, start }: Asked): Words => ({ name, label, question, ...(hint !== undefined && { hint }), ...(start !== undefined && { start }) })

/**
 * A field's rules, the same for every role, as ask gives them, with how an answer is written
 * (`takes`): a choice's values with how each reads, or for a shared list named in LISTS, its name and
 * how its values are written. Its suggestions, `ask`, are left out: ask has already put them into
 * each role's words.
 */
function rulesOf(asked: Asked) {
  const { name: _, label: __, question: ___, hint: ____, start: _____, ask: ______, choices, values, takes, ...rules } = asked
  const list = typeof values === 'string' ? { list: values } : {}
  if (typeof values === 'string' && Object.hasOwn(LISTS, values)) return { ...rules, ...list, takes: takes.replace(`one of the values in the ${values} list`, LISTS[values]!) }
  return { ...rules, ...list, ...(choices && { choices: Object.fromEntries(choices.map((c) => [c.value, c.label])) }), takes }
}

/**
 * What a market asks, from the package's ask: its file but its fields, with its preview; each
 * field's rules once, by kind (`fields`); and each role's words, in the order a form asks them
 * (`roles`): for its listings, and for a review about a profile of that role, whose fields and words
 * the role reviewed picks. A vouch's and a report's are the same for every role.
 */
export function describe(markets: Markets, market: Market) {
  const { listing: _, review: __, ...file } = market
  const fields: { [kind: string]: { [name: string]: ReturnType<typeof rulesOf> } } = Object.fromEntries(KINDS.map((kind) => [kind, {}]))
  const keep = (kind: string, asked: Asked[]) => {
    for (const a of asked) fields[kind]![a.name] ??= rulesOf(a)
    return asked.map(wordsOf)
  }
  const roles = Object.fromEntries(
    market.roles.map(({ role }) => [role, { listing: keep('listing', markets.ask(market.name, role)), review: keep('review', markets.ask(market.name, role, 'review', role)) }]),
  )
  const first = market.roles[0]!.role
  const vouch = keep('vouch', markets.ask(market.name, first, 'vouch'))
  const report = keep('report', markets.ask(market.name, first, 'report'))
  return { market: { ...file, preview: previewOf(market) }, fields, roles, vouch, report }
}
