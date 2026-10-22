// What backs a review: its `evidence`, checked once against the two profiles' `pay` addresses.
// Each kind is one file here, exporting its name, how it recognizes an evidence value, and check();
// config/scoring.json holds one weight per kind, and `none`. A new kind is one file, one line in
// KINDS, and one weight.

import type { Currency } from '../lists.ts'
import type { Rpc } from '../rpc.ts'
import type { Store } from '../store.ts'
import * as escrow from './escrow.ts'
import * as payment from './payment.ts'

/** The two profiles' `pay` addresses, the reviewer's first, and when the review's record was written (ms). */
export type Between = { a: string; b: string; written: number }
export type Context = { store: Store; rpc: Rpc; mints: Map<string, Currency>; now: number }

export type Kind = {
  name: string
  recognizes(value: string): boolean
  /** Whether the value backs a deal between the two; it throws when it cannot tell yet (the RPC failed, or the chain has no answer yet). */
  check(value: string, between: Between, ctx: Context): Promise<boolean>
}

export const KINDS: Kind[] = [escrow, payment]

/** with: it counts, under `kind`; without: the review carries none; invalid: it carries one that does not count. */
export type Evidence = { status: 'with' | 'without' | 'invalid'; kind: string | null }

/**
 * A review's evidence. When a check cannot tell yet, the review counts as without, and the check
 * runs again on the next pass.
 */
export async function evidenceOf(value: unknown, between: Between | null, ctx: Context): Promise<Evidence> {
  if (value === undefined) return { status: 'without', kind: null }
  const kind = typeof value === 'string' ? KINDS.find((k) => k.recognizes(value)) : undefined
  if (!kind || !between) return { status: 'invalid', kind: kind?.name ?? null }
  try {
    return { status: (await kind.check(value as string, between, ctx)) ? 'with' : 'invalid', kind: kind.name }
  } catch {
    return { status: 'without', kind: null }
  }
}
