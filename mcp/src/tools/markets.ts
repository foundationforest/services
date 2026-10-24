// The markets: the directory this copy reads, and which of its markets the index lists.

import { type Context, indexSays } from '../forest.ts'
import { directory } from '../markets.ts'
import type { Args, Param } from '../params.ts'

export const name = 'markets'
export const description =
  "Every market in the markets directory this copy reads: its name, what the dealing is, and its roles, each with what it posts (offers, requests, or just posts). A profile is one market and one role. Also the markets the index lists, as its word. No login."
export const params: Param[] = []
export const relayed = false

export async function run(_args: Args, ctx: Context) {
  const says = await indexSays(ctx, 'index.json', ['index', 'markets'])
  const names = Array.isArray(says.markets) ? says.markets.map((m) => (m as { name?: unknown })?.name).filter((n) => typeof n === 'string') : undefined
  return { markets: directory(), index: names ? { ...says, markets: names } : says }
}
