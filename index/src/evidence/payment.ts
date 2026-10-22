// Evidence of the kind `payment`: a transaction's signature, a direct payment. One getTransaction,
// at finalized, asked once: its answer is kept. It counts when the transaction succeeded and, in a
// mint config/currencies.json lists, one of the two profiles' `pay` addresses lost and the other
// gained, in either direction: a buyer reviewing the seller they paid, or the seller reviewing them.
// A signature the RPC holds no transaction for counts for nothing, and that answer is kept too.

import { base58 } from '@foundationforest/records'

import { type TokenBalance, transaction } from '../rpc.ts'
import type { Between, Context } from './index.ts'

export const name = 'payment'

export function recognizes(value: string): boolean {
  try {
    return base58.decode(value).length === 64
  } catch {
    return false
  }
}

export async function check(value: string, { a, b }: Between, { store, rpc, mints }: Context): Promise<boolean> {
  const [x, y] = [a, b].sort()
  const held = store.db.prepare('select ok from evidence where kind = ? and value = ? and a = ? and b = ?').get(name, value, x!, y!) as { ok: number } | undefined
  if (held) return held.ok === 1
  const tx = await transaction(rpc, value)
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
