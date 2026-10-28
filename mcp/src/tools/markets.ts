// The markets: the directory this copy reads. Which of them an index lists is the index's to say,
// in its home, which the index tool passes on whole; picking it out here would name its fields.

import { directory } from '../markets.ts'
import type { Param } from '../params.ts'

export const name = 'markets'
export const description =
  "Every market in the markets directory this copy reads: its name, what the dealing is, and its roles, each with what it posts (offers, requests, or just posts). A profile is one market and one role. No login."
export const params: Param[] = []
export const toApp = false

export async function run() {
  return { markets: directory() }
}
