// The escrow's reader: the standard's escrow, its program at ESCROW_PROGRAM on ESCROW_CHAIN, as the
// standard at the pin records the program it deployed (a test checks they match), read through the
// RPC config/chains.json names for that chain, when it lists it.
// Every transaction that named the program, oldest first, from a cursor (the newest signature read):
// a failed one is skipped, and only events the program itself wrote are read (the escrow client's
// `decodeEvents`). Each escrow's receipt is made from them, and each move is kept with who made it
// and when. Nothing else is read from any chain, but the payments reviews name (evidence/payment.ts).

import { decodeEvents, type EscrowEvent, type Outcome } from '@foundationforest/escrow-client'
import { PublicKey } from '@solana/web3.js'

import { type Rpc, transaction } from './rpc.ts'
import type { Store } from './store.ts'

export const ESCROW_PROGRAM = 'FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8'
/** The chain the standard deployed it to, in CAIP-2 form: Solana's devnet. */
export const ESCROW_CHAIN = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const PROGRAM = new PublicKey(ESCROW_PROGRAM)
const PAGE = 1000

/** An escrow's receipt as this index keeps it: amounts in base units as decimal text, times in ISO 8601. */
export type Receipt = {
  escrow: string
  payer: string
  recipient: string
  creator: 'payer' | 'recipient'
  arbiter: string | null
  mint: string
  amount: string
  schedule: { windows: Array<{ until: string; payerShare: number }>; end: 'pay' | 'refund' } | null
  createdAt: string
  fundedAt: string | null
  stop: 'payer' | 'recipient' | null
  stoppedAt: string | null
  outcome: Outcome | null
  endedAt: string | null
  toPayer: string | null
  toRecipient: string | null
  closed: boolean
}

/** One move: what happened, who made it (a side, a key, or anyone) and when. */
export type Move = { move: EscrowEvent['kind']; by: string; at: string | null; signature: string }

const iso = (seconds: bigint | number | null | undefined) => (seconds === null || seconds === undefined ? null : new Date(Number(seconds) * 1000).toISOString())
/** Who makes each ending (the escrow's state table). */
const ENDED_BY: { [o in Outcome]: string } = { pay: 'payer', refund: 'recipient', takeBack: 'payer', agree: 'payer and recipient', decide: 'arbiter', end: 'anyone' }

/** Every new transaction of the escrow program, read into receipts and moves. Throws when the RPC fails; what was read stays. */
export async function readChain(store: Store, rpc: Rpc): Promise<number> {
  const { db } = store
  const cursor = (db.prepare('select cursor from chain').get() as { cursor?: string } | undefined)?.cursor
  const found: Array<{ signature: string; err: unknown }> = []
  for (let before: string | undefined; ; ) {
    const page = (await rpc('getSignaturesForAddress', [ESCROW_PROGRAM, { limit: PAGE, commitment: 'finalized', ...(before && { before }), ...(cursor && { until: cursor }) }])) as Array<{ signature: string; err: unknown }>
    found.push(...page)
    if (page.length < PAGE) break
    before = page[page.length - 1]!.signature
  }
  const getReceipt = db.prepare('select receipt from receipts where escrow = ?')
  const putReceipt = db.prepare('insert or replace into receipts (escrow, receipt) values (?, ?)')
  const putMove = db.prepare('insert or ignore into moves (signature, n, escrow, move) values (?, ?, ?, ?)')
  const setCursor = db.prepare('insert into chain (one, cursor) values (1, ?) on conflict (one) do update set cursor = excluded.cursor')
  let read = 0
  for (const { signature, err } of found.reverse()) {
    const tx = err ? null : await transaction(rpc, signature)
    if (!err && !tx) break // not served yet: read again from here next time
    let events: EscrowEvent[] = []
    try {
      if (tx && !tx.meta?.err) events = decodeEvents(tx.meta?.logMessages ?? [], PROGRAM as never)
    } catch {
      // An event this client cannot read was written by an earlier version of the program, whose
      // escrows this version refuses (the standard's record calls them beforeSchedules): no receipt here.
      events = []
    }
    store.tx(() => {
      events.forEach((e, n) => {
        const escrow = e.escrow.toBase58()
        const held = getReceipt.get(escrow) as { receipt: string } | undefined
        const receipt = apply(held ? (JSON.parse(held.receipt) as Receipt) : null, e)
        if (receipt) putReceipt.run(escrow, JSON.stringify(receipt))
        putMove.run(signature, n, escrow, JSON.stringify(moveOf(e, signature, tx?.blockTime ?? null)))
      })
      setCursor.run(signature)
    })
    read++
  }
  return read
}

function moveOf(e: EscrowEvent, signature: string, blockTime: number | null): Move {
  const at = (t: bigint | null) => iso(t ?? blockTime)
  switch (e.kind) {
    case 'created':
      return { move: e.kind, by: e.creator, at: at(e.createdAt), signature }
    case 'funded':
      return { move: e.kind, by: 'anyone', at: at(e.fundedAt), signature }
    case 'stopped':
      return { move: e.kind, by: e.by, at: at(e.stoppedAt), signature }
    case 'ended':
      return { move: e.kind, by: ENDED_BY[e.outcome], at: at(e.endedAt), signature }
    case 'closed':
      return { move: e.kind, by: e.closedBy.toBase58(), at: at(null), signature }
    default:
      return { move: e.kind, by: 'anyone', at: at(null), signature }
  }
}

/** The receipt after one event. */
function apply(r: Receipt | null, e: EscrowEvent): Receipt | null {
  if (e.kind === 'created') {
    return {
      escrow: e.escrow.toBase58(),
      payer: e.payer.toBase58(),
      recipient: e.recipient.toBase58(),
      creator: e.creator,
      arbiter: e.arbiter?.toBase58() ?? null,
      mint: e.mint.toBase58(),
      amount: e.amount.toString(),
      schedule: e.schedule && { windows: e.schedule.windows.map((w) => ({ until: iso(w.until)!, payerShare: w.payerShare })), end: e.schedule.end },
      createdAt: iso(e.createdAt)!,
      fundedAt: null,
      stop: null,
      stoppedAt: null,
      outcome: null,
      endedAt: null,
      toPayer: null,
      toRecipient: null,
      closed: false,
    }
  }
  if (!r) return null
  switch (e.kind) {
    case 'funded':
      return { ...r, fundedAt: iso(e.fundedAt) }
    case 'stopped':
      return { ...r, stop: e.by, stoppedAt: iso(e.stoppedAt) }
    case 'ended':
      return { ...r, outcome: e.outcome, endedAt: iso(e.endedAt), fundedAt: iso(e.fundedAt), toPayer: e.toPayer.toString(), toRecipient: e.toRecipient.toString() }
    case 'closed':
      return { ...r, closed: true, toPayer: e.toPayer.toString() }
    default:
      return r
  }
}
