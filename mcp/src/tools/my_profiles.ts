// The person's profiles this login acts in, from its connection: each by its label, with what its
// access key can do there as its profile entry, read from its hosts, lists it now. Never an address.

import { folderOf, ownProfile } from '../act.ts'
import type { Ctx, Param } from '../params.ts'

export const name = 'my_profiles'
export const title = 'My profiles'
export const description =
  "The person's profiles this login acts in, each by its label, such as tutoring/tutor, with what this login may do there, as its profile entry lists it now: read (open the profile's locked entries), read-inbox (open its messages), write (write entries in its folder), message (send messages as it). Start here. Name a profile by its label, never an address: you never get the person's own addresses. A profile whose key the person removed shows nothing it may do. Needs the person's login."
export const params: Param[] = []
export const login = true
export const annotations = { readOnlyHint: true, openWorldHint: true }

export async function run(_args: unknown, ctx: Ctx) {
  const { profiles } = await ctx.connection()
  const listed = await Promise.all(
    profiles.map(async ({ label }) => {
      const me = await ownProfile(ctx, label)
      const view = await folderOf(ctx, me.address, me.hosts)
      return { label, can: view.keys.find((k) => k.key === me.key.address)?.can ?? [] }
    }),
  )
  return { profiles: listed }
}
