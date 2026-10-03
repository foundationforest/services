// The chain reader, from an RPC (a local validator in tests). Two programs.
//
// The registry: every poll, every row of each issuer this index trusts, from the program's own
// accounts (registry.ts). A row never changes, so only new ones are stored.
//
// The escrow: every transaction that named it since the last one read, oldest first. A transaction
// that failed is skipped. One that succeeded is archived whole (its log lines), then read through
// the escrow adapter, then the cursor moves past it, all in one database transaction, so a crash
// never half-reads one. RPC nodes are not an archive: the logs are kept here.

import { Connection, PublicKey, type Commitment } from '@solana/web3.js'
import type pg from 'pg'

import { type Db, getCursor, setCursor } from '../db.ts'
import { type EscrowFact, decodeEscrowFacts } from './escrow.ts'
import { readRows, storeRow } from './registry.ts'

export class ChainReader {
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<number> | null = null
  private readonly db: Db
  private readonly registry: string
  private readonly escrow: string
  private readonly issuers: string[]
  /** Called with the profiles of new rows, after anything new was read. */
  private readonly onChange: (profiles: string[]) => void
  private readonly commitment: Commitment
  readonly connection: Connection
  readonly onError: (err: unknown) => void

  constructor(args: {
    db: Db
    rpcUrl: string
    registry: string
    escrow: string
    issuers: string[]
    onChange: (profiles: string[]) => void
    commitment?: Commitment
    onError?: (err: unknown) => void
  }) {
    this.db = args.db
    this.registry = args.registry
    this.escrow = args.escrow
    this.issuers = args.issuers
    this.onChange = args.onChange
    this.commitment = args.commitment ?? 'finalized'
    this.onError = args.onError ?? ((err) => console.error('chain read failed', err))
    this.connection = new Connection(args.rpcUrl, this.commitment)
  }

  /** Read everything new once. Returns how many new rows and transactions were read. */
  pollOnce(): Promise<number> {
    if (!this.polling) {
      this.polling = (async () => {
        let n = 0
        const profiles: string[] = []
        try {
          for (const row of await readRows(this.connection, this.registry, this.issuers, this.commitment)) {
            if (await storeRow(this.db, row)) {
              n++
              profiles.push(row.profile)
            }
          }
          n += await this.readEscrow()
        } finally {
          this.polling = null
        }
        if (n > 0) this.onChange(profiles)
        return n
      })()
    }
    return this.polling
  }

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.pollOnce()
      } catch (err) {
        this.onError(err)
      }
      this.timer = setTimeout(tick, intervalMs)
    }
    void tick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async readEscrow(): Promise<number> {
    const source = `chain:${this.escrow}`
    const until = (await getCursor(this.db, source)) ?? undefined
    const address = new PublicKey(this.escrow)
    const finality = this.commitment as 'confirmed' | 'finalized'
    // Newest first, a page at a time, back to the cursor; then read oldest first.
    const found: { signature: string; failed: boolean }[] = []
    let before: string | undefined
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(address, { until, before, limit: 1000 }, finality)
      found.push(...page.map((s) => ({ signature: s.signature, failed: s.err !== null })))
      if (page.length < 1000) break
      before = page[page.length - 1]!.signature
    }
    found.reverse()

    for (const { signature, failed } of found) {
      const tx = failed ? null : await this.connection.getTransaction(signature, { commitment: finality, maxSupportedTransactionVersion: 0 })
      if (!failed && !tx) throw new Error(`transaction ${signature} not served yet`)
      const client = await this.db.connect()
      try {
        await client.query('begin')
        if (tx && !tx.meta?.err) {
          const logs = tx.meta?.logMessages ?? []
          await client.query(
            `insert into chain_transactions (signature, program_id, slot, block_time, logs)
             values ($1, $2, $3, to_timestamp($4), $5) on conflict (signature) do nothing`,
            [signature, this.escrow, tx.slot, tx.blockTime ?? null, JSON.stringify(logs)],
          )
          await storeEscrowFacts(client, signature, decodeEscrowFacts(logs, this.escrow), this.escrow)
        }
        await setCursor(client, source, signature)
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    }
    return found.length
  }
}

/** A receipt, rebuilt from the facts in the order the chain wrote them. */
export async function storeEscrowFacts(client: pg.PoolClient | pg.Pool, signature: string, facts: EscrowFact[], programId: string): Promise<void> {
  for (const f of facts) {
    switch (f.kind) {
      case 'created':
        // A new deal at this address (only possible after a never-funded one closed): start afresh.
        await client.query(
          `insert into escrow_receipts (escrow, program_id, buyer, seller, creator, arbiter, mint, amount, timer_days, timer_to,
                                        created_at, signature)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11), $12)
           on conflict (escrow) do update set program_id = excluded.program_id, buyer = excluded.buyer,
             seller = excluded.seller, creator = excluded.creator, arbiter = excluded.arbiter, mint = excluded.mint,
             amount = excluded.amount, timer_days = excluded.timer_days, timer_to = excluded.timer_to,
             created_at = excluded.created_at, funded_at = null, ended_at = null, outcome = null, to_seller = null,
             to_buyer = null, closed = false, objected_by = null, objected_at = null, signature = excluded.signature,
             updated_at = now()`,
          [f.escrow, programId, f.buyer, f.seller, f.creator, f.arbiter, f.mint, f.amount, f.timer?.days ?? null, f.timer?.to ?? null, f.createdAt, signature],
        )
        break
      case 'funded':
        await client.query(
          'update escrow_receipts set funded_at = coalesce(funded_at, to_timestamp($2)), signature = $3, updated_at = now() where escrow = $1',
          [f.escrow, f.fundedAt, signature],
        )
        break
      case 'ended':
        // The money was there when the mark says, or when it ended if nobody marked it.
        await client.query(
          `update escrow_receipts set outcome = $2, to_seller = $3, to_buyer = $4, ended_at = to_timestamp($5),
             funded_at = coalesce(funded_at, to_timestamp($6)), signature = $7, updated_at = now()
           where escrow = $1`,
          [f.escrow, f.outcome, f.toSeller, f.toBuyer, f.endedAt, f.fundedAt, signature],
        )
        break
      case 'closed':
        await client.query('update escrow_receipts set closed = true, signature = $2, updated_at = now() where escrow = $1', [f.escrow, signature])
        break
      case 'objected':
        await client.query(
          'update escrow_receipts set objected_by = $2, objected_at = to_timestamp($3), signature = $4, updated_at = now() where escrow = $1',
          [f.escrow, f.by, f.objectedAt, signature],
        )
        break
    }
  }
}
