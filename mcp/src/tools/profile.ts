// A profile, as the index shows it: the index's whole answer, untouched. Which of its records the
// index shows, and how, is the index's; the index tool says what its answers hold.

import { publicKeyFromAddress } from '@foundationforest/records'
import { type Context, fromIndex, refuse } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'profile'
export const description =
  "Any profile, by its address, as the index this copy reads shows it: the index's whole answer, untouched, as its word. The index tool says what it holds. No login."
export const params: Param[] = [{ name: 'address', type: 'string', required: true, description: "The profile's address." }]
export const toApp = false

export async function run(args: Args, ctx: Context) {
  const address = args.address as string
  // An address has one spelling, so no other path of the index's is ever asked for.
  if (!publicKeyFromAddress(address)) refuse(`${address} is not a profile's address`)
  return { index: await fromIndex(ctx, `profiles/${address}.json`) }
}
