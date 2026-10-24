// What backs a review: its `evidence`, written `<chain>:<id>`, the chain in CAIP-2 form. The chain
// holds a colon itself, so the text splits at its last colon (the markets manual, Shared names).
// config/chains.json names each chain this index reads, and its reader. A reader reads one type of
// chain, matches the two profiles' pay addresses of that type, and has its kinds of evidence: each
// kind is one file here, exporting its name, how it recognizes an id, and check().
// config/scoring.json holds one weight per kind, and `none`. A new kind is one file, one line in
// its reader, and one weight.

import type { PayType } from '@foundationforest/keys'

import { CHAIN, type Currency } from '../lists.ts'
import type { Rpc } from '../rpc.ts'
import type { Store } from '../store.ts'
import * as escrow from './escrow.ts'
import * as payment from './payment.ts'

/** The two profiles' pay addresses of the reader's type, the reviewer's first, and when the review's record was written (ms). */
export type Between = { a: string; b: string; written: number }
/** What a check reads: the chain the evidence names, and that chain's RPC. */
export type Context = { store: Store; chain: string; rpc: Rpc; mints: Map<string, Currency>; now: number }

export type Kind = {
  name: string
  recognizes(id: string): boolean
  /** Whether the id backs a deal between the two; it throws when it cannot tell yet (the RPC failed, or the chain has no answer yet). */
  check(id: string, between: Between, ctx: Context): Promise<boolean>
}

/** A reader: the pay address type it matches, and its kinds. */
export type Reader = { pay: PayType; kinds: Kind[] }

/** The readers this index has, by the name config/chains.json gives a chain's. */
export const READERS: { [name: string]: Reader } = {
  solana: { pay: 'solana', kinds: [escrow, payment] },
}

export const KINDS: Kind[] = Object.values(READERS).flatMap((r) => r.kinds)

/**
 * with: it counts, under `kind`; without: the review carries none; unchecked: it names a chain this
 * index does not read; invalid: it carries one that does not count, or one that names no chain.
 */
export type Evidence = { status: 'with' | 'without' | 'unchecked' | 'invalid'; kind: string | null }

/** An evidence value's chain and id, split at its last colon; null when the text before it is no CAIP-2 chain. */
export function split(value: unknown): { chain: string; id: string } | null {
  if (typeof value !== 'string') return null
  const at = value.lastIndexOf(':')
  const chain = value.slice(0, Math.max(at, 0))
  return CHAIN.test(chain) ? { chain, id: value.slice(at + 1) } : null
}

/** Why a review's evidence is unchecked, from the value it carries. */
export const uncheckedWhy = (value: unknown) => `this index reads no evidence on ${split(value)?.chain}`

/** A pay address of one type, from a profile record's `pay`; a type it does not hold is null. */
const payOf = (pay: unknown, type: PayType): string | null => {
  const address = pay && typeof pay === 'object' ? (pay as { [type: string]: unknown })[type] : undefined
  return typeof address === 'string' ? address : null
}

/**
 * A review's evidence, between the two profiles' `pay` (each as its profile record holds it), on
 * the chains this index reads. When a check cannot tell yet, the review counts as without, and the
 * check runs again on the next pass.
 */
export async function evidenceOf(
  value: unknown,
  pays: { a: unknown; b: unknown; written: number },
  ctx: { store: Store; chains: Map<string, { reader: Reader; rpc: Rpc }>; mints: Map<string, Currency>; now: number },
): Promise<Evidence> {
  if (value === undefined) return { status: 'without', kind: null }
  const at = split(value)
  if (!at) return { status: 'invalid', kind: null }
  const chain = ctx.chains.get(at.chain)
  if (!chain) return { status: 'unchecked', kind: null }
  const kind = chain.reader.kinds.find((k) => k.recognizes(at.id))
  const a = payOf(pays.a, chain.reader.pay)
  const b = payOf(pays.b, chain.reader.pay)
  if (!kind || !a || !b) return { status: 'invalid', kind: kind?.name ?? null }
  try {
    const ok = await kind.check(at.id, { a, b, written: pays.written }, { store: ctx.store, chain: at.chain, rpc: chain.rpc, mints: ctx.mints, now: ctx.now })
    return { status: ok ? 'with' : 'invalid', kind: kind.name }
  } catch {
    return { status: 'without', kind: null }
  }
}
