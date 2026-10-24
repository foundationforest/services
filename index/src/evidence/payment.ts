// Evidence of the kind `payment`: a transaction's signature, a direct payment. One getTransaction,
// at finalized, through the RPC of the chain the evidence names, and its answer kept once there is
// one, by the whole evidence value, chain and all. It counts when the transaction succeeded and, in
// a mint config/currencies.json lists, one of the two profiles' solana pay addresses lost and the
// other gained, in either direction: a buyer reviewing the seller they paid, or the seller
// reviewing them.
//
// An app writes the review seconds after paying, before the chain holds the payment as final, so a
// signature the RPC holds no transaction for is asked again on each pass until the review's record
// is WAIT_MS old; only then does it count for nothing, and that answer is kept.

import { base58 } from '@foundationforest/records'

import { type TokenBalance, transaction } from '../rpc.ts'
import type { Between, Context } from './index.ts'

export const name = 'payment'

/** How long after its review is written a payment the RPC does not find is asked for again: a day. */
export const WAIT_MS = 24 * 60 * 60 * 1000

export function recognizes(id: string): boolean {
  try {
    return base58.decode(id).length === 64
  } catch {
    return false
  }
}

export async function check(id: string, { a, b, written }: Between, { store, chain, rpc, mints, now }: Context): Promise<boolean> {
  const [x, y] = [a, b].sort()
  const value = `${chain}:${id}`
  const held = store.db.prepare('select ok from evidence where kind = ? and value = ? and a = ? and b = ?').get(name, value, x!, y!) as { ok: number } | undefined
  if (held) return held.ok === 1
  const tx = await transaction(rpc, id)
  if (!tx && now - written < WAIT_MS) throw new Error('the payment is not on chain yet, or not final')
  let ok = false
  if (tx?.meta && !tx.meta.err) {
    const moved = new Map<string, bigint>()
    const add = (list: TokenBalance[] | null | undefined, sign: bigint) => {
      for (const t of list ?? []) {
        if (!t.owner || !mints.has(t.mint)) continue
        const k = `${t.owner} ${t.mint}`
        moved.set(k, (moved.get(k) ?? 0n) + sign * BigInt(t.uiTokenAmount.amount))
      }
    }
    add(tx.meta.preTokenBalances, -1n)
    add(tx.meta.postTokenBalances, 1n)
    ok = [...mints.keys()].some((mint) => {
      const ga = moved.get(`${a} ${mint}`) ?? 0n
      const gb = moved.get(`${b} ${mint}`) ?? 0n
      return (ga < 0n && gb > 0n) || (gb < 0n && ga > 0n)
    })
  }
  store.db.prepare('insert or replace into evidence (kind, value, a, b, ok) values (?, ?, ?, ?, ?)').run(name, value, x!, y!, ok ? 1 : 0)
  return ok
}
