// Evidence of the kind `escrow`: an escrow's address, whose receipt chain.ts reads. It counts when
// the receipt's payer and recipient are the two profiles' `pay` addresses, in either order; its mint
// is one config/currencies.json lists; and it ended with money to the recipient.

import { base58 } from '@foundationforest/records'

import type { Receipt } from '../chain.ts'
import type { Between, Context } from './index.ts'

export const name = 'escrow'

export function recognizes(value: string): boolean {
  try {
    return base58.decode(value).length === 32
  } catch {
    return false
  }
}

export async function check(value: string, { a, b }: Between, { store, mints }: Context): Promise<boolean> {
  const held = store.db.prepare('select receipt from receipts where escrow = ?').get(value) as { receipt: string } | undefined
  if (!held) return false
  const r = JSON.parse(held.receipt) as Receipt
  const parties = (r.payer === a && r.recipient === b) || (r.payer === b && r.recipient === a)
  return parties && mints.has(r.mint) && r.outcome !== null && BigInt(r.toRecipient ?? '0') > 0n
}
