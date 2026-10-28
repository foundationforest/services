// What the index says about itself: its skill.md, written for AI agents, and its home, each
// untouched, so the AI learns from the index what its answers hold and which filters its search
// takes, and nothing here needs to.

import { type Context, indexSays } from '../forest.ts'
import type { Args, Param } from '../params.ts'

export const name = 'index'
export const description =
  "What the index this copy reads says about itself, each untouched, as its word: its skill.md, its guide for AI agents to what its answers hold, which filters its search takes and what each means; and its home, as JSON. Call it before you read ratings or filter a search: another index may show other things. No login."
export const params: Param[] = []
export const toApp = false

export async function run(_args: Args, ctx: Context) {
  const [skill, home] = await Promise.all([indexSays(ctx, 'skill.md', 'text'), indexSays(ctx, 'index.json')])
  return { skill, home }
}
