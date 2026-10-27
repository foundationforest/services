// One pass, every READ_SECONDS: read the hosts and the chain, then filter, judge the reviews,
// vouches and reports, check the reviews' evidence, rank each market, sign what changed, and build
// the tree. Everything after the reading is computed again on every pass, from what the store
// holds.

import { b64u, canonical, type Key, proofsOf } from '@foundationforest/records'
import { packSignature, signBytes } from '@foundationforest/keys'

import { ESCROW_CHAIN, readChain } from './chain.ts'
import { evidenceOf, type Evidence, type Reader, USED } from './evidence/index.ts'
import { type Filtered, filter } from './filter.ts'
import type { Lists } from './lists.ts'
import { type Markets, MANY } from './markets.ts'
import { type Pickiness, pickinessWord, rank, type Said } from './rank.ts'
import { allProfiles, comingDue, readHosts, viewAgain } from './read.ts'
import { judge, type Written } from './reviews.ts'
import type { Rpc } from './rpc.ts'
import { parse, type Store } from './store.ts'
import { leavesOf, reputationProofs, updateTree } from './tree.ts'

/** `chains`: each chain config/chains.json lists, by CAIP-2 id, with its reader and its RPC. */
export type Context = { store: Store; lists: Lists; markets: Markets; key: Key; chains: Map<string, { reader: Reader; rpc: Rpc }>; log: (line: string) => void }

/** A rating as the pages show it and the statement signs it: one decimal. */
export const tenth = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)

/** A trust or a uniqueness, from 0 to 1, as the pages show it and the statement signs it: a whole number from 0 to 100. */
export const hundredth = (v: number) => Math.round(v * 100)

/** What a counted profile shows, as its statement signs it. */
export type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number; pickiness: Pickiness }

/**
 * The statement a profile's ratings, trust, uniqueness and pickiness are signed as: canonical JSON,
 * by the standard's records' `canonical`, signed with the index's key over its UTF-8 bytes (the
 * standard's keys' `signBytes`). It begins with `{`, never with the 0xff every record, message,
 * pull, blob request and root begins with, so it is never one of those. The rating's value is text,
 * since canonical JSON's numbers are whole.
 */
export function statementOf(index: string, profile: string, shown: Shown, time: number): string {
  const { ratings, trust, uniqueness, pickiness } = shown
  return canonical({ index, profile, ratings: { value: ratings.value === null ? null : ratings.value.toFixed(1), count: ratings.count }, trust, uniqueness, pickiness, time })
}

export function signStatement(key: Key, statement: string): string {
  return b64u.encode(packSignature(signBytes(key.scalar, new TextEncoder().encode(statement))))
}

/** One pass. `before` is the previous pass's clock, or null for the first since start. */
export async function runPass(ctx: Context, before: number | null, now: number): Promise<void> {
  const { store, lists, markets, key, chains, log } = ctx
  const { db } = store

  const touched = await readHosts(store, lists.hosts, log)
  for (const p of before === null ? allProfiles(store) : comingDue(store, before, now)) touched.add(p)
  viewAgain(store, touched, now)
  const escrowChain = chains.get(ESCROW_CHAIN)
  try {
    if (escrowChain) await readChain(store, escrowChain.rpc)
  } catch (err) {
    log(`chain: ${(err as Error).message}`)
  }

  // Filter.
  const held = db.prepare('select address, body, market, role from profiles').all() as Array<{ address: string; body: string; market: string | null; role: string | null }>
  const filtered = new Map<string, Filtered & { market: string | null; role: string | null; body: { [key: string]: unknown } }>()
  for (const r of held) {
    const body = parse<{ [key: string]: unknown }>(r.body)
    filtered.set(r.address, { ...(await filter(store, { address: r.address, body, market: r.market, role: r.role }, lists.keys, markets, now)), market: r.market, role: r.role, body })
  }

  // Reviews, and the evidence of each that counts, between the two profiles' signed pay addresses. A
  // payment's day runs from when this index first saw the review name it (evidence/payment.ts), kept
  // by rebuild.
  const reviews = (db.prepare('select address, reviewer, body, time from reviews').all() as Array<{ address: string; reviewer: string; body: string; time: number }>).map(
    (r): Written => ({ address: r.address, writer: r.reviewer, body: parse(r.body), time: r.time }),
  )
  const saw = db.prepare('insert or ignore into seen_reviews (review, evidence, first) values (?, ?, ?)')
  store.tx(() => {
    for (const r of reviews) if (typeof r.body.evidence === 'string') saw.run(r.address, r.body.evidence, now)
  })
  const firstSeen = db.prepare('select first from seen_reviews where review = ? and evidence = ?')
  const judged = judge('review', reviews, filtered, markets)
  const evidence = new Map<string, Evidence>()
  for (const r of reviews) {
    if (!judged.get(r.address)!.counted) continue
    const seen = typeof r.body.evidence === 'string' ? (firstSeen.get(r.address, r.body.evidence) as { first: number }).first : now
    const subject = r.body.subject as string
    const sides = { a: { address: r.writer, body: filtered.get(r.writer)?.body }, b: { address: subject, body: filtered.get(subject)?.body }, seen }
    evidence.set(r.address, await evidenceOf(r.body.evidence, sides, { store, chains, mints: lists.currencies, now }))
  }
  // One payment or escrow backs one review: the earliest of the reviews it backs, by record time,
  // then address; each later one is invalid. Only reviews between its two pay addresses can be
  // backed by it, so a review by anyone else that names it, dated as early as its writer likes,
  // takes nothing from them.
  const used = new Set<string>()
  const backed = reviews.filter((r) => evidence.get(r.address)?.status === 'with').sort((a, b) => a.time - b.time || (a.address < b.address ? -1 : 1))
  for (const r of backed) {
    const value = r.body.evidence as string
    if (used.has(value)) evidence.set(r.address, { status: 'invalid', kind: evidence.get(r.address)!.kind, why: USED })
    used.add(value)
  }

  // Vouches and reports, judged as reviews are.
  const said = (['vouch', 'report'] as const).map((kind) => {
    const table = MANY[kind]
    const records = (db.prepare(`select address, writer, body, time from ${table}`).all() as Array<{ address: string; writer: string; body: string; time: number }>).map(
      (r): Written => ({ ...r, body: parse(r.body) }),
    )
    return { kind, table, records, judged: judge(kind, records, filtered, markets) }
  })

  // Rank, one market at a time: a review, a vouch or a report counts only between two profiles of
  // one market. Each counted review is a rating, and with each counted vouch and report, a record
  // its writer's word is drawn from.
  const counted = [...filtered].filter(([, f]) => f.counted)
  const countedReviews = reviews.filter((r) => judged.get(r.address)!.counted)
  const factorOf = (e: Evidence) => (e.status === 'with' ? lists.scoring.evidence[e.kind!]! : lists.scoring.evidence.none)
  const shown = new Map<string, Shown>()
  const sortBy = new Map<string, number | null>()
  const reviewWeight = new Map<string, number>()
  const words: Array<{ writer: string; subject: string; word: string; weight: number }> = []
  for (const market of new Set(counted.map(([, f]) => f.market!))) {
    const inMarket = (r: Written) => filtered.get(r.writer)!.market === market
    const marketReviews = countedReviews.filter(inMarket)
    const saidHere: Said[] = [
      ...marketReviews.map((r) => ({ writer: r.writer, subject: r.body.subject as string, kind: 'rating' as const, time: r.time, address: r.address })),
      ...said.flatMap((k) => k.records.filter((r) => k.judged.get(r.address)!.counted && inMarket(r)).map((r) => ({ writer: r.writer, subject: r.body.subject as string, kind: k.kind, time: r.time, address: r.address }))),
    ]
    const profiles = counted.filter(([, f]) => f.market === market).map(([address, f]) => ({ address, uniqueness: f.uniqueness }))
    const ranked = rank(
      profiles,
      marketReviews.map((r) => ({ writer: r.writer, subject: r.body.subject as string, score: Number(r.body.score), evidence: factorOf(evidence.get(r.address)!) })),
      saidHere,
      lists.scoring,
    )
    for (const p of profiles) {
      const r = ranked.ratings.get(p.address)!
      shown.set(p.address, {
        ratings: { value: tenth(r.value), count: r.count },
        trust: hundredth(ranked.trust.get(p.address)!),
        uniqueness: hundredth(p.uniqueness),
        pickiness: pickinessWord(ranked.pickiness.get(p.address)!, lists.scoring),
      })
      sortBy.set(p.address, r.order)
    }
    marketReviews.forEach((r, i) => reviewWeight.set(r.address, ranked.weights[i]!))
    words.push(...ranked.words)
  }

  // Write what this pass found, signing each profile's statement when what it shows moved.
  const heldRating = db.prepare('select value, count, trust, uniqueness, pickiness, statement, signature from ratings where profile = ?')
  store.tx(() => {
    const setProfile = db.prepare('update profiles set counted = ?, checks = ?, tags = ? where address = ?')
    for (const [address, f] of filtered) setProfile.run(f.counted ? 1 : 0, JSON.stringify(f.checks), JSON.stringify(f.tags), address)

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

    const setReview = db.prepare('update reviews set counted = ?, why = ?, evidence = ?, evidence_why = ?, weight = ? where address = ?')
    for (const r of reviews) {
      const j = judged.get(r.address)!
      const e = evidence.get(r.address)
      setReview.run(j.counted ? 1 : 0, j.why ?? null, e?.status ?? 'without', e?.why ?? null, reviewWeight.get(r.address) ?? 0, r.address)
    }
    for (const k of said) {
      const set = db.prepare(`update ${k.table} set counted = ?, why = ? where address = ?`)
      for (const r of k.records) {
        const j = k.judged.get(r.address)!
        set.run(j.counted ? 1 : 0, j.why ?? null, r.address)
      }
    }
    db.exec('delete from words')
    const putWord = db.prepare('insert into words (writer, subject, word, weight) values (?, ?, ?, ?)')
    for (const w of words) putWord.run(w.writer, w.subject, w.word, w.weight)

    const keep = new Set(counted.map(([a]) => a))
    for (const { profile } of db.prepare('select profile from ratings').all() as Array<{ profile: string }>) if (!keep.has(profile)) db.prepare('delete from ratings where profile = ?').run(profile)
    const putRating = db.prepare('insert or replace into ratings (profile, value, count, trust, uniqueness, pickiness, sort, statement, signature) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [address] of counted) {
      const shownNow = shown.get(address)!
      const kept = heldRating.get(address) as { value: number | null; count: number; trust: number; uniqueness: number; pickiness: string; statement: string; signature: string } | undefined
      const same =
        kept &&
        kept.value === shownNow.ratings.value &&
        kept.count === shownNow.ratings.count &&
        kept.trust === shownNow.trust &&
        kept.uniqueness === shownNow.uniqueness &&
        kept.pickiness === shownNow.pickiness
      const statement = same ? kept.statement : statementOf(key.address, address, shownNow, now)
      const signature = same ? kept.signature : signStatement(key, statement)
      putRating.run(address, shownNow.ratings.value, shownNow.ratings.count, shownNow.trust, shownNow.uniqueness, shownNow.pickiness, sortBy.get(address) ?? null, statement, signature)
    }
  })

  // The tree, then the proofs each profile record shows, against the roots as they are now.
  const signed = new Map((db.prepare('select profile, trust from ratings').all() as Array<{ profile: string; trust: number }>).map((r) => [r.profile, r.trust]))
  updateTree(store, key, leavesOf(counted.map(([address, f]) => ({ tags: f.tags, trust: signed.get(address)! }))), now)
  const setProofs = db.prepare('update profiles set proofs = ? where address = ?')
  for (const [address, f] of filtered) {
    const shown = await reputationProofs(store, address, f.body, lists.indexes, key.address, lists.maxAgeDays, now)
    // By each proof's place among proofsOf's, as filter.ts and tree.ts number them.
    const results = proofsOf(f.body as never).map((p, i) => f.stampProofs.get(i) ?? shown.get(i) ?? { circuit: p.circuit, result: 'this index does not read this kind of proof' })
    setProofs.run(JSON.stringify(results), address)
  }
}
