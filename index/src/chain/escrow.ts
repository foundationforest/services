// THE ESCROW ADAPTER. The one file in the index that knows the escrow program's events.
//
// One sealed program (standard/escrow/README.md). If the receipt itself gains or loses a fact, change
// it here and in the table and its store in poll.ts: everything past this file reads `EscrowFact`,
// the index's own shape for what happened to one escrow, and stores it in `escrow_receipts`.
//
// The program emits seven events: `Created`, `Funded`, `Ended`, `Closed`, `RecoveredLate`,
// `RentSwept` and `Objected`. Its `Ended` also carries when the money was there (the mark's time, or
// the ending's when nobody marked it). There is no accept step: who said yes is read from who created
// the escrow (`creator`), and every way out pays the whole balance, which must hold the amount, so an
// ending is proof the deal was paid.
//
// It reads only events the program itself wrote: the client's `decodeEvents` follows the runtime's
// own invoke and success lines, so a `Program data:` line another program wrote with the same bytes
// is never read.

import { PublicKey } from '@solana/web3.js'

import { decodeEvents } from '../../../standard/escrow/client/src/index.ts'

export type Side = 'buyer' | 'seller'

/** Unix seconds. Amounts are base units as decimal text: no rounding through a JavaScript number. */
export type EscrowFact =
  | {
      kind: 'created'
      escrow: string
      buyer: string
      seller: string
      /** Who opened it: the seller, for an invoice. */
      creator: Side
      /** null: no arbiter. */
      arbiter: string | null
      mint: string
      amount: string
      /** null: no timer. */
      timer: { days: number; to: Side } | null
      createdAt: number
    }
  /** Someone marked the funding: the balance covered the amount then. Only the timer reads it. */
  | { kind: 'funded'; escrow: string; fundedAt: number }
  /**
   * Paid out, by one of the five ways out. `outcome` keeps the client's own names:
   * releasedToSeller, releasedToBuyer, split, arbitrated, timerReleased. `fundedAt`: the mark's
   * time, or the ending's when nobody marked it.
   */
  | { kind: 'ended'; escrow: string; outcome: string; toSeller: string; toBuyer: string; endedAt: number; fundedAt: number }
  /** Never funded, and gone: nothing was dealt, so there is no receipt. */
  | { kind: 'closed'; escrow: string }
  /** A party objected. It moves no money; from then on the timer never runs. */
  | { kind: 'objected'; escrow: string; by: Side; objectedAt: number }

/** What happened to which escrow, in one successful transaction's log lines, in order. */
export function decodeEscrowFacts(logs: string[], programId: string): EscrowFact[] {
  // The client's `PublicKey` comes from its own copy of web3.js; the decoder only reads its base58.
  const events = decodeEvents(logs, new PublicKey(programId) as never)
  const out: EscrowFact[] = []
  for (const e of events) {
    const escrow = e.escrow.toBase58()
    switch (e.kind) {
      case 'created':
        out.push({
          kind: 'created',
          escrow,
          buyer: e.buyer.toBase58(),
          seller: e.seller.toBase58(),
          creator: e.creator,
          arbiter: e.arbiter ? e.arbiter.toBase58() : null,
          mint: e.mint.toBase58(),
          amount: e.amount.toString(),
          timer: e.timer ? { days: e.timer.days, to: e.timer.to } : null,
          createdAt: Number(e.createdAt),
        })
        break
      case 'funded':
        out.push({ kind: 'funded', escrow, fundedAt: Number(e.fundedAt) })
        break
      case 'ended':
        out.push({
          kind: 'ended',
          escrow,
          outcome: e.outcome,
          toSeller: e.toSeller.toString(),
          toBuyer: e.toBuyer.toString(),
          endedAt: Number(e.endedAt),
          fundedAt: Number(e.fundedAt),
        })
        break
      case 'closed':
        out.push({ kind: 'closed', escrow })
        break
      case 'objected':
        out.push({ kind: 'objected', escrow, by: e.by, objectedAt: Number(e.objectedAt) })
        break
      // Money sent after the end, forwarded to the buyer, and rent swept back change no receipt.
      case 'recoveredLate':
      case 'rentSwept':
        break
    }
  }
  return out
}
