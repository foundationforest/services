// The person's profiles this connection may act for, by market and role, from their signer.

import type { Args, Ctx, Param } from '../params.ts'

export const name = 'profiles'
export const description =
  "The market and role of each of the person's profiles you may act for, as their signer says; never an address. Start here. Needs the person's login."
export const params: Param[] = []
export const relayed = true

export async function run(_args: Args, ctx: Ctx) {
  return ctx.ask(name, {})
}
