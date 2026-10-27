// The index's search: the filters given, passed to it as they are, and its answer, untouched. Which
// filters it takes are the index's, so none is named here.

import { type Context, fromIndex, refuse } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'search'
export const description =
  "The index's search: the filters given, passed to it as they are, and its answer, untouched, as its word. Which filters it takes, what each means and what its answer holds are the index's: read them with the index tool first. Every filter may be left out. No login."
export const params: Param[] = [
  { name: 'filters', type: 'object', description: "The filters, by the names the index gives them, each value as text. Left out, the index's search with none." },
]
export const relayed = false

export async function run(args: Args, ctx: Context) {
  const filters = (args.filters ?? {}) as { [name: string]: unknown }
  for (const [name, value] of Object.entries(filters)) if (typeof value !== 'string') refuse(`each filter's value is text: ${name} is not`)
  return { index: await fromIndex(ctx, `search.json?${new URLSearchParams(filters as { [name: string]: string })}`) }
}
