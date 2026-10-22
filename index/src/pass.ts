// One pass, every READ_SECONDS: read the hosts and the chain, then filter, judge the reviews, check
// their evidence, rank, sign what changed, and build the tree. Everything after the reading is
// computed again on every pass, from what the store holds.

import { b64u, canonical, type Key, proofsOf } from '@foundationforest/records'
import { packSignature, signBytes } from '@foundationforest/keys'

import { readChain } from './chain.ts'
import { evidenceOf, type Evidence } from './evidence/index.ts'
import { type Filtered, filter } from './filter.ts'
import type { Lists } from './lists.ts'
import type { Markets } from './markets.ts'
import { rank } from './rank.ts'
import { allProfiles, comingDue, readHosts, viewAgain } from './read.ts'
import { judgeReviews, type Review } from './reviews.ts'
import type { Rpc } from './rpc.ts'
import { parse, type Store } from './store.ts'
import { leavesOf, reputationProofs, updateTree } from './tree.ts'

export type Context = { store: Store; lists: Lists; markets: Markets; key: Key; rpc: Rpc; log: (line: string) => void }

/** A rating as the pages show it and the statement signs it: one decimal. */
export const tenth = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)

/**
 * The statement a rating is signed as: canonical JSON, by the standard's records' `canonical`,
 * signed with the index's key over its UTF-8 bytes (the standard's keys' `signBytes`). It begins
 * with `{`, never with the 0xff every record, message, pull, blob request and root begins with, so
 * it is never one of those.
 */
export function statementOf(index: string, profile: string, value: number | null, reviews: number, withPayment: number, time: number): string {
  return canonical({ index, profile, rating: value === null ? null : value.toFixed(1), reviews, withPayment, time })
}

export function signStatement(key: Key, statement: string): string {
  return b64u.encode(packSignature(signBytes(key.scalar, new TextEncoder().encode(statement))))
}

/** One pass. `before` is the previous pass's clock, or null for the first since start. */
export async function runPass(ctx: Context, before: number | null, now: number): Promise<void> {
  const { store, lists, markets, key, rpc, log } = ctx
  const { db } = store

  const touched = await readHosts(store, lists.hosts, log)
  for (const p of before === null ? allProfiles(store) : comingDue(store, before, now)) touched.add(p)
  viewAgain(store, touched, now)
  try {
    await readChain(store, rpc)
  } catch (err) {
    log(`chain: ${(err as Error).message}`)
  }

  // Filter.
  const held = db.prepare('select address, body, market, role, pay from profiles').all() as Array<{ address: string; body: string; market: string | null; role: string | null; pay: string | null }>
  const filtered = new Map<string, Filtered & { market: string | null; role: string | null; pay: string | null; body: { [key: string]: unknown } }>()
  for (const r of held) {
    const body = parse<{ [key: string]: unknown }>(r.body)
    filtered.set(r.address, { ...(await filter(store, { address: r.address, body, market: r.market, role: r.role }, lists.keys, markets, now)), market: r.market, role: r.role, pay: r.pay, body })
  }

  // Reviews, and the evidence of each that counts.
  const reviews = (db.prepare('select address, reviewer, body, time from reviews').all() as Array<{ address: string; reviewer: string; body: string; time: number }>).map(
    (r): Review => ({ ...r, body: parse(r.body) }),
  )
  const judged = judgeReviews(reviews, filtered, markets)
  const evidence = new Map<string, Evidence>()
  for (const r of reviews) {
    if (!judged.get(r.address)!.counted) continue
    const a = filtered.get(r.reviewer)?.pay
    const b = filtered.get(r.body.subject as string)?.pay
    evidence.set(r.address, await evidenceOf(r.body.evidence, a && b ? { a, b } : null, { store, rpc, mints: lists.currencies }))
  }

  // Rank.
  const counted = [...filtered].filter(([, f]) => f.counted)
  const countedReviews = reviews.filter((r) => judged.get(r.address)!.counted)
  const weightOf = (e: Evidence) => (e.status === 'with' ? lists.scoring.evidence[e.kind!]! : lists.scoring.evidence.none)
  const ranked = rank(
    counted.map(([address, f]) => ({ address, market: f.market!, points: f.points })),
    countedReviews.map((r) => ({ writer: r.reviewer, subject: r.body.subject as string, score: Number(r.body.score), evidence: weightOf(evidence.get(r.address)!) })),
    lists.scoring,
  )
  const reviewWeight = new Map(countedReviews.map((r, i) => [r.address, ranked.weights[i]!]))
  const withPayment = new Map<string, number>()
  for (const r of countedReviews) if (evidence.get(r.address)!.status === 'with') withPayment.set(r.body.subject as string, (withPayment.get(r.body.subject as string) ?? 0) + 1)

  // Write what this pass found, signing each rating whose value moved.
  const heldRating = db.prepare('select value, reviews, with_payment, statement, signature from ratings where profile = ?')
  store.tx(() => {
    const setProfile = db.prepare('update profiles set counted = ?, points = ?, checks = ?, stamps = ? where address = ?')
    for (const [address, f] of filtered) setProfile.run(f.counted ? 1 : 0, ranked.points.get(address) ?? 0, JSON.stringify(f.checks), JSON.stringify(f.stamps), address)

    const posts = db.prepare('select address, profile, body, deleted from posts').all() as Array<{ address: string; profile: string; body: string; deleted: number }>
    const setPost = db.prepare('update posts set listed = ?, why = ? where address = ?')
    for (const p of posts) {
      const author = filtered.get(p.profile)
      const why = p.deleted
        ? 'deleted'
        : !author
          ? 'its profile has no profile record here'
          : !author.counted
            ? 'its profile does not count here'
            : markets.checkPost(author.market!, author.role!, parse(p.body))
      setPost.run(why ? 0 : 1, why, p.address)
    }

    const setReview = db.prepare('update reviews set counted = ?, why = ?, evidence = ?, weight = ? where address = ?')
    for (const r of reviews) {
      const j = judged.get(r.address)!
      setReview.run(j.counted ? 1 : 0, j.why ?? null, evidence.get(r.address)?.status ?? 'without', reviewWeight.get(r.address) ?? 0, r.address)
    }

    const keep = new Set(counted.map(([a]) => a))
    for (const { profile } of db.prepare('select profile from ratings').all() as Array<{ profile: string }>) if (!keep.has(profile)) db.prepare('delete from ratings where profile = ?').run(profile)
    const putRating = db.prepare(`insert or replace into ratings (profile, value, reviews, with_payment, weight, shrunk, statement, signature) values (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [address] of counted) {
      const r = ranked.ratings.get(address)!
      const value = tenth(r.value)
      const paid = withPayment.get(address) ?? 0
      const kept = heldRating.get(address) as { value: number | null; reviews: number; with_payment: number; statement: string; signature: string } | undefined
      const same = kept && kept.value === value && kept.reviews === r.reviews && kept.with_payment === paid
      const statement = same ? kept.statement : statementOf(key.address, address, value, r.reviews, paid, now)
      const signature = same ? kept.signature : signStatement(key, statement)
      putRating.run(address, value, r.reviews, paid, r.weight, r.shrunk, statement, signature)
    }
  })

  // The tree, then the proofs each profile record shows, against the roots as they are now.
  const ratings = new Map((db.prepare('select profile, value, reviews from ratings').all() as Array<{ profile: string; value: number | null; reviews: number }>).map((r) => [r.profile, r]))
  updateTree(store, key, leavesOf(counted.map(([address, f]) => ({ stamps: f.stamps, value: ratings.get(address)?.value ?? null, reviews: ratings.get(address)?.reviews ?? 0 }))), now)
  const setProofs = db.prepare('update profiles set proofs = ? where address = ?')
  for (const [address, f] of filtered) {
    const shown = await reputationProofs(store, address, f.body, lists.indexes, key.address, lists.roots)
    // By each proof's place among proofsOf's, as filter.ts and tree.ts number them.
    const results = proofsOf(f.body as never).map((p, i) => f.notes.get(i) ?? shown.get(i) ?? { circuit: p.circuit, result: 'this index does not read this kind of proof' })
    setProofs.run(JSON.stringify(results), address)
  }
}
