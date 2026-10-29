// The markets: the directory this copy reads, or one market's file, as the markets manual defines
// it, with its preview and the kinds of entry it defines. Which of them an index lists is the
// index's to say; search passes its answers on.

import { directory, kindsOf, marketFile, previewOf } from '../markets.ts'
import type { Args, Param } from '../params.ts'

export const name = 'markets'
export const title = 'Markets'
export const description =
  "The markets in the markets directory this copy reads. With no name: every market, what the dealing is, and its roles, each with what it posts (offers, requests, or just posts); a profile is one market and one role. With a name: that market's file: its roles, the kinds of entry it defines (such as offer and review) and the fields of each (each field's type, what it holds, the values of a choice, and the roles it is for), the fields a post's preview shows first, its payment schedules, and how deals go there. Read it before you write to a market. No login."
export const params: Param[] = [{ name: 'name', type: 'string', description: 'A market, such as tutoring. Left out: every market.' }]
export const login = false
export const annotations = { readOnlyHint: true, openWorldHint: false }

export async function run(args: Args) {
  if (args.name === undefined) return { markets: directory() }
  const market = marketFile(args.name as string)
  return { market: { ...market, preview: previewOf(market) }, kinds: kindsOf(market) }
}
