// What backs a review: its `evidence`, written `<chain>:<id>`, the chain in CAIP-2 form. The chain
// holds a colon itself, so the text splits at its last colon (the markets manual, Shared names).
// config/chains.json names each chain this index reads, and its reader. A reader reads one type of
// chain, matches the two profiles' pay addresses of that type, each only when its pay key signed its
// profile's address (the standard's checkPay), and has its kinds of evidence: each kind is one file
// here, exporting its name, how it recognizes an id, and check().
// config/scoring.json holds one factor per kind, and `none`. A new kind is one file, one line in
// its reader, and one factor.

import type { PayType } from '@foundationforest/keys'
import { type Body, checkPay } from '@foundationforest/records'

import { CHAIN, type Currency } from '../lists.ts'
import type { Rpc } from '../rpc.ts'
import type { Store } from '../store.ts'
import * as escrow from './escrow.ts'
import * as payment from './payment.ts'

/** The two profiles' pay addresses of the reader's type, the reviewer's first, and when this index first saw the review name this evidence (ms). */
export type Between = { a: string; b: string; seen: number }
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
 * with: it counts, under `kind`; without: the review carries none, or a pay address it is between is
 * unsigned; unchecked: it names a chain this index does not read; invalid: it carries one that does
 * not count, or one that names no chain. `why` says which chain, for unchecked; that another review
 * used it, for invalid (pass.ts); and that a pay address is unsigned, for without.
 */
export type Evidence = { status: 'with' | 'without' | 'unchecked' | 'invalid'; kind: string | null; why?: string }

/** Why evidence that backs an earlier review counts for nothing on a later one (pass.ts). */
export const USED = 'already used'
/** Why a review counts as without when a profile it is between lists a pay address its pay key did not sign for it. */
export const UNSIGNED = 'pay address unsigned'

/** One profile a review is between: its address, and its profile record's body. */
export type Side = { address: string; body: { [key: string]: unknown } | undefined }

/** An evidence value's chain and id, split at its last colon; null when the text before it is no CAIP-2 chain. */
export function split(value: unknown): { chain: string; id: string } | null {
  if (typeof value !== 'string') return null
  const at = value.lastIndexOf(':')
  const chain = value.slice(0, Math.max(at, 0))
  return CHAIN.test(chain) ? { chain, id: value.slice(at + 1) } : null
}

/** Why a review's evidence is unchecked, from the value it carries. */
const uncheckedWhy = (value: unknown) => `this index reads no evidence on ${split(value)?.chain}`

/**
 * A profile's pay address of one type, from its profile record's `pay`, and whether its pay key
 * signed the profile's address in `paySig` (checkPay); a type it does not hold is null.
 */
const payOf = (side: Side, type: PayType): { address: string; signed: boolean } | null => {
  const pay = side.body?.pay
  const address = pay && typeof pay === 'object' ? (pay as { [type: string]: unknown })[type] : undefined
  return typeof address === 'string' ? { address, signed: checkPay(side.body as Body, side.address).includes(type) } : null
}

/**
 * A review's evidence, between the two profiles' pay addresses (each as its profile record holds
 * it, and signed), on the chains this index reads. When a check cannot tell yet, the review counts
 * as without, and the check runs again on the next pass.
 */
export async function evidenceOf(
  value: unknown,
  sides: { a: Side; b: Side; seen: number },
  ctx: { store: Store; chains: Map<string, { reader: Reader; rpc: Rpc }>; mints: Map<string, Currency>; now: number },
): Promise<Evidence> {
  if (value === undefined) return { status: 'without', kind: null }
  const at = split(value)
  if (!at) return { status: 'invalid', kind: null }
  const chain = ctx.chains.get(at.chain)
  if (!chain) return { status: 'unchecked', kind: null, why: uncheckedWhy(value) }
  const kind = chain.reader.kinds.find((k) => k.recognizes(at.id))
  const a = payOf(sides.a, chain.reader.pay)
  const b = payOf(sides.b, chain.reader.pay)
  if (!kind || !a || !b) return { status: 'invalid', kind: kind?.name ?? null }
  if (!a.signed || !b.signed) return { status: 'without', kind: null, why: UNSIGNED }
  try {
    const ok = await kind.check(at.id, { a: a.address, b: b.address, seen: sides.seen }, { store: ctx.store, chain: at.chain, rpc: chain.rpc, mints: ctx.mints, now: ctx.now })
    return { status: ok ? 'with' : 'invalid', kind: kind.name }
  } catch {
    return { status: 'without', kind: null }
  }
}
