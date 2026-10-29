// The person's profiles this login acts in, from the pack: each by its label, with what its access
// key can do. Never an address.

import type { Ctx, Param } from '../params.ts'

export const name = 'my_profiles'
export const title = 'My profiles'
export const description =
  "The person's profiles this login acts in, each by its label, such as tutoring/tutor, with what this login may do there, as the person's app listed it: read (open the profile's locked entries), read-inbox (open its messages), write (write entries in its folder), message (send messages as it). Start here. Name a profile by its label, never an address: you never get the person's own addresses. What the person removed since is refused by the hosts. Needs the person's login."
export const params: Param[] = []
export const login = true
export const annotations = { readOnlyHint: true, openWorldHint: false }

export async function run(_args: unknown, ctx: Ctx) {
  return { profiles: (await ctx.pack()).profiles.map(({ label, can }) => ({ label, can })) }
}
