// The person's profiles this login acts in, from its connection, by label, never an address.
//
// With no label: each profile whose market the directory still lists (a profile whose market has
// left it is left out, as the Forest app forgets it), with what its access key can do there as its
// profile entry, read from its hosts, lists it now (nothing once the key has ended), its listings
// as its folder holds them (id, title, and the app's link to it), and its rating, trust and review
// count as the index shows them, with whether the index counts it, which is what search shows.
//
// With a label: that profile in full: its listings and their fields, and the reviews, vouches and
// reports it received (strangers' words) and wrote (the person's), as the index shows them, each
// written one with its path, so delete_entry names it.

import { type Body, isLocked } from '@foundationforest/folders'
import { folderOf, leavePayOut, ownProfile, profileEntryOf } from '../act.ts'
import { type Context, type Said, indexSays, isObject, refuse } from '../forest.ts'
import { appLinks } from '../links.ts'
import type { Args, Ctx, Param } from '../params.ts'
import { forAi, titleOf } from '../shape.ts'

export const name = 'list_my_profiles'
export const title = 'List my profiles'
export const description =
  "The person's profiles this login acts in, each by its label, such as tutoring/tutor, never an address. With no label: for each, what this login may do there (read, read-inbox, write, message: nothing once the person ended its key), its listings (id, title, link to it in the Forest app), and its rating, trust and review count as the index shows them; inSearch false means the index does not count the profile yet, so its listings do not show in search. With a label: that profile in full: its listings with their fields, the reviews, vouches and reports it received (what strangers wrote sits under strangersWrote) and wrote, as the index shows them; each one it wrote has a path for delete_entry. Needs the person's login."
export const params: Param[] = [{ name: 'label', type: 'string', description: "One profile, by its label: <market>/<role>, such as tutoring/tutor. Left out: every profile." }]
export const login = true
export const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

/** What the index shows of a profile: its page's answer, or why it gave none; `counts` is whether the index counts the profile, which its signed statement says. */
export async function indexOf(ctx: Context, address: string): Promise<{ page: { [field: string]: unknown } | null; counts: boolean | null; unread?: string }> {
  const said: Said = await indexSays(ctx, `profiles/${address}.json`)
  if ('answer' in said) return isObject(said.answer) ? { page: said.answer, counts: typeof said.answer.statement === 'string' } : { page: null, counts: null }
  // An index that has no page for the address does not count the profile; one that does not answer says nothing of it.
  return { page: null, counts: said.unread.includes('answered 404') ? false : null, unread: said.unread }
}

/** The listings in a folder's current entries, the person's own words: id, title and body. */
function listingsOf(view: { current: Map<string, { entry: { body: Body | null } }> }): Array<{ id: string; title: string; body: Body }> {
  return [...view.current]
    .filter(([path, c]) => path.startsWith('listing/') && c.entry.body !== null && !isLocked(c.entry.body))
    .map(([path, c]) => ({ id: path.slice('listing/'.length), title: titleOf(c.entry.body!), body: c.entry.body! }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** The index's page given to the AI for the person's own profile: each written entry with its path. */
function withPaths(page: { [field: string]: unknown }): unknown {
  const shown = forAi(page, true) as { [field: string]: unknown }
  // Its listings are the person's own words, read from its folder above.
  delete shown.listings
  for (const kind of ['reviews', 'vouches', 'reports']) {
    const of = shown[kind]
    if (!isObject(of) || !Array.isArray(of.given)) continue
    ;(of as { given: unknown }).given = of.given.map((e: unknown) => {
      const path = isObject(e) && typeof e.address === 'string' ? /((?:review|vouch|report)\/[^/]+)$/.exec(e.address)?.[1] : undefined
      return isObject(e) && path ? { path, ...e } : e
    })
  }
  return shown
}

/** What the index shows of one profile in short: its rating, trust and review count. */
const shownOf = (page: { [field: string]: unknown } | null) => ({
  ...(page && isObject(page.ratings) && { rating: page.ratings.value ?? null, reviews: page.ratings.count }),
  ...(page && typeof page.trust === 'number' && { trust: page.trust }),
})

export async function run(args: Args, ctx: Ctx) {
  const { profiles } = await ctx.connection()
  const links = appLinks(ctx.app)
  const listed = ctx.markets.directory.markets.map((m) => m.name)
  if (args.label !== undefined) {
    const me = await ownProfile(ctx, args.label as string)
    const view = await folderOf(ctx, me.address, me.hosts)
    const profile = profileEntryOf(view) ?? refuse(`${me.label}'s hosts hold no profile entry for it`)
    leavePayOut(ctx, me, profile)
    const index = await indexOf(ctx, me.address)
    return {
      label: me.label,
      can: view.keys.find((k) => k.key === me.key.address && k.until === undefined)?.can ?? [],
      inSearch: index.counts,
      listings: listingsOf(view).map((l) => ({ id: l.id, title: l.title, ...(links.listing(me.label, l.id) && { link: links.listing(me.label, l.id) }), fields: l.body })),
      index: index.page ? withPaths(index.page) : { unread: index.unread },
    }
  }
  const out = await Promise.all(
    profiles.map(async ({ label }) => {
      const me = await ownProfile(ctx, label)
      const view = await folderOf(ctx, me.address, me.hosts)
      const profile = profileEntryOf(view)
      if (!profile || typeof profile.market !== 'string' || !listed.includes(profile.market)) return null
      leavePayOut(ctx, me, profile)
      const index = await indexOf(ctx, me.address)
      return {
        label,
        can: view.keys.find((k) => k.key === me.key.address && k.until === undefined)?.can ?? [],
        inSearch: index.counts,
        ...shownOf(index.page),
        listings: listingsOf(view).map((l) => ({ id: l.id, title: l.title, ...(links.listing(label, l.id) && { link: links.listing(label, l.id) }) })),
      }
    }),
  )
  return { profiles: out.filter((p) => p !== null) }
}
