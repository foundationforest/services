// Recomputing: read everything the scores depend on, compute them all (compute.ts), and store
// them. A score whose value did not change keeps its statement, time and signatures, so a reader's
// cache and a signature someone already holds stay good; only changed values are signed again.
//
// Everything is recomputed each time. That is fine at this size; an incremental recompute is
// later work (docs/changes.md).

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Directory } from '../markets.ts'
import { type Inputs, type Scores, compute, toMicro } from './compute.ts'
import { type IndexKeys, type Kind, sign } from './sign.ts'

export async function loadInputs(db: Db): Promise<Inputs> {
  const [profiles, badges, receipts, reviews] = await Promise.all([
    db.query('select did, wallet, market, role from profiles'),
    db.query('select did, wallet, scope, list_owner from badges'),
    db.query(
      `select escrow, buyer, seller, creator, mint, funded_at is not null as funded, outcome, closed from escrow_receipts`,
    ),
    db.query('select uri, reviewer, subject, overall, deal_id, created_at from reviews'),
  ])
  return {
    profiles: profiles.rows.map((r) => ({ did: r.did, wallet: r.wallet, scope: r.market && r.role ? `${r.market}/${r.role}` : null })),
    badges: badges.rows.map((r) => ({ did: r.did, wallet: r.wallet, scope: r.scope, listOwner: r.list_owner })),
    receipts: receipts.rows.map((r) => ({
      escrow: r.escrow,
      buyer: r.buyer,
      seller: r.seller,
      creator: r.creator,
      mint: r.mint,
      funded: r.funded,
      outcome: r.outcome,
      closed: r.closed,
    })),
    reviews: reviews.rows.map((r) => ({
      uri: r.uri,
      reviewer: r.reviewer,
      subject: r.subject,
      overall: r.overall === null ? null : Number(r.overall),
      dealId: r.deal_id,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
  }
}

type Row = { did: string; kind: Kind; scope: string; value: bigint; details: unknown }

export async function recompute(
  db: Db,
  settings: { directory: Directory; config: Config; keys: IndexKeys },
  now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
): Promise<Scores> {
  const inputs = await loadInputs(db)
  const scores = compute(inputs, {
    directory: settings.directory,
    issuers: settings.config.issuers,
    scoring: settings.config.scoring,
  })

  const rows: Row[] = [
    ...scores.uniqueness.map((u) => ({
      did: u.did,
      kind: 'uniqueness' as const,
      scope: u.scope,
      value: toMicro(u.value),
      details: { market: u.market, role: u.role, issuers: u.issuers },
    })),
    ...scores.standing.map((t) => ({
      did: t.did,
      kind: 'standing' as const,
      scope: '',
      value: toMicro(t.value),
      details: { reviews: t.reviews, rounds: scores.rounds },
    })),
    // No counted review rates: no rating, rather than a rating of zero.
    ...scores.rating
      .filter((r) => r.value !== null)
      .map((r) => ({ did: r.did, kind: 'rating' as const, scope: '', value: toMicro(r.value!), details: { reviews: r.reviews } })),
  ]

  const client = await db.connect()
  try {
    await client.query('begin')
    const { rows: existing } = await client.query('select did, kind, scope, value_micro from scores for update')
    const old = new Map(existing.map((r) => [`${r.did}\u0000${r.kind}\u0000${r.scope}`, BigInt(r.value_micro)]))
    const keep = new Set<string>()
    for (const row of rows) {
      const key = `${row.did}\u0000${row.kind}\u0000${row.scope}`
      keep.add(key)
      if (old.get(key) === row.value) {
        await client.query('update scores set details = $4 where did = $1 and kind = $2 and scope = $3', [
          row.did,
          row.kind,
          row.scope,
          JSON.stringify(row.details),
        ])
        continue
      }
      const at = now()
      const signed = sign({ kind: row.kind, did: row.did, scope: row.scope, value: row.value, at }, settings.keys)
      await client.query(
        `insert into scores (did, kind, scope, value_micro, details, statement, message, sig_ed25519, sig_eddsa, computed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (did, kind, scope) do update set
           value_micro = excluded.value_micro, details = excluded.details, statement = excluded.statement,
           message = excluded.message, sig_ed25519 = excluded.sig_ed25519, sig_eddsa = excluded.sig_eddsa,
           computed_at = excluded.computed_at`,
        [
          row.did,
          row.kind,
          row.scope,
          row.value.toString(),
          JSON.stringify(row.details),
          signed.statement,
          signed.message,
          signed.ed25519,
          JSON.stringify(signed.eddsaPoseidon),
          at.toString(),
        ],
      )
    }
    for (const [key] of old) {
      if (keep.has(key)) continue
      const [did, kind, scope] = key.split('\u0000')
      await client.query('delete from scores where did = $1 and kind = $2 and scope = $3', [did, kind, scope])
    }

    await client.query('delete from review_weights')
    for (const v of scores.reviews) {
      await client.query(
        `insert into review_weights (uri, counted, skipped, evidence_kind, evidence_note, evidence_weight, reviewer_weight, contribution)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [v.uri, v.counted, v.skipped ?? null, v.evidence.kind, v.evidence.note ?? null, v.evidence.weight, v.reviewerWeight, v.contribution],
      )
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return scores
}

/**
 * Recompute after data arrives, at most one run at a time: a request during a run starts one more
 * run when it ends, and requests close together are folded into one by a short wait.
 */
export class Scorer {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  onError: (err: unknown) => void = (err) => console.error('recompute failed', err)
  private readonly run: () => Promise<unknown>
  private readonly waitMs: number

  constructor(run: () => Promise<unknown>, waitMs = 250) {
    this.run = run
    this.waitMs = waitMs
  }

  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.now()
    }, this.waitMs)
  }

  /** Run now (or right after the run in progress), and resolve when the scores are stored. */
  now(): Promise<void> {
    this.again = true
    if (this.running) return this.running
    this.running = (async () => {
      while (this.again) {
        this.again = false
        try {
          await this.run()
        } catch (err) {
          this.onError(err)
        }
      }
      this.running = null
    })()
    return this.running
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
