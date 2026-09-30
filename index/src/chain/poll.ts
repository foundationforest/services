// The chain reader, one program at a time, from an RPC (a local validator in tests).
//
// The registry: at start, every line from the program's own accounts (registry.ts); then only the
// transactions after the newest one it saw then, to pick up new lines. It never needs older history.
//
// Each escrow version: every transaction that named it since the last one read, oldest first. A
// transaction that failed is skipped. One that succeeded is archived whole (its log lines), then read
// through the escrow adapter, then the cursor moves past it, all in one database transaction, so a
// crash never half-reads one. RPC nodes are not an archive (adversarial review 1, rule 7): the logs
// are kept here.

import { Connection, PublicKey, type Commitment } from '@solana/web3.js'
import type pg from 'pg'

import { fetchLines } from '../../../forest/registry/client/src/lines.ts'

import { type Db, getCursor, setCursor } from '../db.ts'
import { type EscrowFact, decodeEscrowFacts } from './escrow.ts'
import { type LineRow, lineRow, linesIn } from './registry.ts'

export type Program = { id: string; kind: 'registry' | 'escrow' | 'escrowV2' }

export class ChainReader {
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<number> | null = null
  private readonly db: Db
  private readonly programs: Program[]
  private readonly onChange: () => void
  private readonly commitment: Commitment
  /** Registry programs whose lines were all read from their accounts since this reader started. */
  private readonly backfilled = new Set<string>()
  readonly connection: Connection
  readonly onError: (err: unknown) => void

  constructor(
    db: Db,
    rpcUrl: string,
    programs: Program[],
    onChange: () => void,
    commitment: Commitment = 'finalized',
    onError: (err: unknown) => void = (err) => console.error('chain read failed', err),
  ) {
    this.db = db
    this.programs = programs
    this.onChange = onChange
    this.commitment = commitment
    this.onError = onError
    this.connection = new Connection(rpcUrl, commitment)
  }

  /** Read everything new once. Returns how many lines and transactions were read. */
  pollOnce(): Promise<number> {
    if (!this.polling) {
      this.polling = (async () => {
        let n = 0
        try {
          for (const p of this.programs) {
            if (p.kind === 'registry' && !this.backfilled.has(p.id)) {
              n += await this.backfill(p)
              this.backfilled.add(p.id)
            }
            n += await this.readProgram(p)
          }
        } finally {
          this.polling = null
        }
        if (n > 0) this.onChange()
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

  /**
   * Every line, from the registry's own accounts. The newest transaction naming the program is taken
   * first, and reading goes on from there, so a line written during the backfill is read either way.
   */
  private async backfill(p: Program): Promise<number> {
    const address = new PublicKey(p.id)
    const [newest] = await this.connection.getSignaturesForAddress(address, { limit: 1 }, this.commitment as 'confirmed' | 'finalized')
    // The client's PublicKey comes from its own copy of web3.js; it reads only the bytes.
    const lines = await fetchLines(this.connection as never, { programId: address as never, commitment: this.commitment })
    const client = await this.db.connect()
    try {
      await client.query('begin')
      for (const { address: at, line } of lines) await storeLine(client, lineRow(at.toBase58(), line))
      if (newest) await setCursor(client, `chain:${p.id}`, newest.signature)
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
    return lines.length
  }

  private async readProgram(p: Program): Promise<number> {
    const source = `chain:${p.id}`
    const until = (await getCursor(this.db, source)) ?? undefined
    const address = new PublicKey(p.id)
    // Newest first, a page at a time, back to the cursor; then read oldest first.
    const found: { signature: string; failed: boolean }[] = []
    let before: string | undefined
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(address, { until, before, limit: 1000 }, this.commitment as 'confirmed' | 'finalized')
      found.push(...page.map((s) => ({ signature: s.signature, failed: s.err !== null })))
      if (page.length < 1000) break
      before = page[page.length - 1].signature
    }
    found.reverse()

    for (const { signature, failed } of found) {
      const tx = failed
        ? null
        : await this.connection.getTransaction(signature, {
            commitment: this.commitment as 'confirmed' | 'finalized',
            maxSupportedTransactionVersion: 0,
          })
      if (!failed && !tx) throw new Error(`transaction ${signature} not served yet`)
      // A new line is one of the transaction's accounts, owned by the registry: read them now.
      let lines: LineRow[] = []
      if (tx && !tx.meta?.err && p.kind === 'registry') {
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat()
        // The RPC answers at most 100 accounts a call.
        for (let at = 0; at < keys.length; at += 100) {
          const some = keys.slice(at, at + 100)
          lines.push(...linesIn(some, await this.connection.getMultipleAccountsInfo(some, this.commitment), p.id))
        }
      }
      const client = await this.db.connect()
      try {
        await client.query('begin')
        if (tx && !tx.meta?.err) {
          if (p.kind === 'registry') {
            for (const line of lines) await storeLine(client, line)
          } else {
            const logs = tx.meta?.logMessages ?? []
            await client.query(
              `insert into chain_transactions (signature, program_id, slot, block_time, logs)
               values ($1, $2, $3, to_timestamp($4), $5) on conflict (signature) do nothing`,
              [signature, p.id, tx.slot, tx.blockTime ?? null, JSON.stringify(logs)],
            )
            await storeEscrowFacts(client, signature, decodeEscrowFacts(logs, p.id, p.kind === 'escrowV2' ? 2 : 1), p.id)
          }
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

/** A line, once: it never changes after it is written. */
export async function storeLine(client: pg.PoolClient | pg.Pool, l: LineRow): Promise<void> {
  await client.query(
    `insert into lines (address, code, did, wallet, label, market, role, root, time, payer)
     values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10)
     on conflict do nothing`,
    [l.address, l.code, l.did, l.wallet, l.label, l.market, l.role, l.root, l.time, l.payer],
  )
}

/** A receipt, rebuilt from the facts in the order the chain wrote them. */
async function storeEscrowFacts(client: pg.PoolClient, signature: string, facts: EscrowFact[], programId: string): Promise<void> {
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
        // v2 says when the money was there even when nobody marked it: the ending's time.
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
