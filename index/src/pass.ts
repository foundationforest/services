// One pass, every READ_SECONDS: read the hosts, then filter, judge the reviews, vouches and reports,
// rank each market, sign what changed, and build the tree. Everything after the reading is computed
// again on every pass, from what the store holds.

import { b64u, canonical, type Key, proofsOf } from '@foundationforest/folders'
import { packSignature, signBytes } from '@foundationforest/keys'

import { type Filtered, filter } from './filter.ts'
import type { Lists } from './lists.ts'
import { type Markets, MANY } from './markets.ts'
import { rank, type Said } from './rank.ts'
import { allProfiles, comingDue, readHosts, viewAgain } from './read.ts'
import { judge, type Written } from './reviews.ts'
import { parse, type Store } from './store.ts'
import { leavesOf, reputationProofs, updateTree } from './tree.ts'

export type Context = { store: Store; lists: Lists; markets: Markets; key: Key; log: (line: string) => void }

/** A rating as the pages show it and the statement signs it: one decimal. */
export const tenth = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)

/** A trust or a uniqueness, from 0 to 1, as the pages show it and the statement signs it: a whole number from 0 to 100. */
export const hundredth = (v: number) => Math.round(v * 100)

/** What a counted profile shows, as its statement signs it. */
export type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number }

/**
 * The statement a profile's ratings, trust and uniqueness are signed as: canonical JSON,
 * by the standard's folders' `canonical`, signed with the index's key over its UTF-8 bytes (the
 * standard's keys' `signBytes`). It begins with `{`, never with the 0xff every entry, message,
 * inbox delete and root begins with, so it is never one of those. The rating's value is text,
 * since canonical JSON's numbers are whole.
 */
export function statementOf(index: string, profile: string, shown: Shown, time: number): string {
  const { ratings, trust, uniqueness } = shown
  return canonical({ index, profile, ratings: { value: ratings.value === null ? null : ratings.value.toFixed(1), count: ratings.count }, trust, uniqueness, time })
}

export function signStatement(key: Key, statement: string): string {
  return b64u.encode(packSignature(signBytes(key.scalar, new TextEncoder().encode(statement))))
}

/** One pass. `before` is the previous pass's clock, or null for the first since start. */
export async function runPass(ctx: Context, before: number | null, now: number): Promise<void> {
  const { store, lists, markets, key, log } = ctx
  const { db } = store

  const touched = await readHosts(store, lists.hosts, log)
  for (const p of before === null ? allProfiles(store) : comingDue(store, before, now)) touched.add(p)
  viewAgain(store, touched, now)

  // Filter.
  const held = db.prepare('select address, body, market, role from profiles').all() as Array<{ address: string; body: string; market: string | null; role: string | null }>
  const filtered = new Map<string, Filtered & { market: string | null; role: string | null; body: { [key: string]: unknown } }>()
  for (const r of held) {
    const body = parse<{ [key: string]: unknown }>(r.body)
    filtered.set(r.address, { ...(await filter(store, { address: r.address, body, market: r.market, role: r.role }, lists.keys, markets, now)), market: r.market, role: r.role, body })
  }

  // Reviews.
  const reviews = (db.prepare('select address, reviewer, body, time from reviews').all() as Array<{ address: string; reviewer: string; body: string; time: number }>).map(
    (r): Written => ({ address: r.address, writer: r.reviewer, body: parse(r.body), time: r.time }),
  )
  const judged = judge('review', reviews, filtered, markets)

  // Vouches and reports, judged as reviews are.
  const said = (['vouch', 'report'] as const).map((kind) => {
    const table = MANY[kind]
    const written = (db.prepare(`select address, writer, body, time from ${table}`).all() as Array<{ address: string; writer: string; body: string; time: number }>).map(
      (r): Written => ({ ...r, body: parse(r.body) }),
    )
    return { kind, table, written, judged: judge(kind, written, filtered, markets) }
  })

  // Rank, one market at a time: a review, a vouch or a report counts only between two profiles of
  // one market. Each counted review is a rating, and with each counted vouch and report, an entry
  // its writer's word is drawn from.
  const counted = [...filtered].filter(([, f]) => f.counted)
  const countedReviews = reviews.filter((r) => judged.get(r.address)!.counted)
  const shown = new Map<string, Shown>()
  const sortBy = new Map<string, number | null>()
  const reviewWeight = new Map<string, number>()
  const words: Array<{ writer: string; subject: string; word: string; weight: number }> = []
  for (const market of new Set(counted.map(([, f]) => f.market!))) {
    const inMarket = (r: Written) => filtered.get(r.writer)!.market === market
    const marketReviews = countedReviews.filter(inMarket)
    const saidHere: Said[] = [
      ...marketReviews.map((r) => ({ writer: r.writer, subject: r.body.subject as string, kind: 'rating' as const, time: r.time, address: r.address })),
      ...said.flatMap((k) => k.written.filter((r) => k.judged.get(r.address)!.counted && inMarket(r)).map((r) => ({ writer: r.writer, subject: r.body.subject as string, kind: k.kind, time: r.time, address: r.address }))),
    ]
    const profiles = counted.filter(([, f]) => f.market === market).map(([address, f]) => ({ address, uniqueness: f.uniqueness }))
    const ranked = rank(
      profiles,
      marketReviews.map((r) => ({ writer: r.writer, subject: r.body.subject as string, score: Number(r.body.score) })),
      saidHere,
      lists.scoring,
    )
    for (const p of profiles) {
      const r = ranked.ratings.get(p.address)!
      shown.set(p.address, {
        ratings: { value: tenth(r.value), count: r.count },
        trust: hundredth(ranked.trust.get(p.address)!),
        uniqueness: hundredth(p.uniqueness),
      })
      sortBy.set(p.address, r.order)
    }
    marketReviews.forEach((r, i) => reviewWeight.set(r.address, ranked.weights[i]!))
    words.push(...ranked.words)
  }

  // Write what this pass found, signing each profile's statement when what it shows moved.
  const heldRating = db.prepare('select value, count, trust, uniqueness, statement, signature from ratings where profile = ?')
  store.tx(() => {
    const setProfile = db.prepare('update profiles set counted = ?, checks = ? where address = ?')
    for (const [address, f] of filtered) setProfile.run(f.counted ? 1 : 0, JSON.stringify(f.checks), address)

    const posts = db.prepare('select address, profile, body, deleted from posts').all() as Array<{ address: string; profile: string; body: string; deleted: number }>
    const setPost = db.prepare('update posts set listed = ?, why = ? where address = ?')
    for (const p of posts) {
      const author = filtered.get(p.profile)
      const why = p.deleted
        ? 'deleted'
        : !author
          ? 'its profile has no profile entry here'
          : !author.counted
            ? 'its profile does not count here'
            : markets.checkPost(author.market!, author.role!, parse(p.body))
      setPost.run(why ? 0 : 1, why, p.address)
    }

    const setReview = db.prepare('update reviews set counted = ?, why = ?, weight = ? where address = ?')
    for (const r of reviews) {
      const j = judged.get(r.address)!
      setReview.run(j.counted ? 1 : 0, j.why ?? null, reviewWeight.get(r.address) ?? 0, r.address)
    }
    for (const k of said) {
      const set = db.prepare(`update ${k.table} set counted = ?, why = ? where address = ?`)
      for (const r of k.written) {
        const j = k.judged.get(r.address)!
        set.run(j.counted ? 1 : 0, j.why ?? null, r.address)
      }
    }
    db.exec('delete from words')
    const putWord = db.prepare('insert into words (writer, subject, word, weight) values (?, ?, ?, ?)')
    for (const w of words) putWord.run(w.writer, w.subject, w.word, w.weight)

    const keep = new Set(counted.map(([a]) => a))
    for (const { profile } of db.prepare('select profile from ratings').all() as Array<{ profile: string }>) if (!keep.has(profile)) db.prepare('delete from ratings where profile = ?').run(profile)
    const putRating = db.prepare('insert or replace into ratings (profile, value, count, trust, uniqueness, sort, statement, signature) values (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [address] of counted) {
      const shownNow = shown.get(address)!
      const kept = heldRating.get(address) as { value: number | null; count: number; trust: number; uniqueness: number; statement: string; signature: string } | undefined
      const same =
        kept &&
        kept.value === shownNow.ratings.value &&
        kept.count === shownNow.ratings.count &&
        kept.trust === shownNow.trust &&
        kept.uniqueness === shownNow.uniqueness
      const statement = same ? kept.statement : statementOf(key.address, address, shownNow, now)
      const signature = same ? kept.signature : signStatement(key, statement)
      putRating.run(address, shownNow.ratings.value, shownNow.ratings.count, shownNow.trust, shownNow.uniqueness, sortBy.get(address) ?? null, statement, signature)
    }
  })

  // The tree, then the proofs each profile entry shows, against the roots as they are now.
  const signed = new Map((db.prepare('select profile, trust from ratings').all() as Array<{ profile: string; trust: number }>).map((r) => [r.profile, r.trust]))
  updateTree(store, key, leavesOf(counted.map(([address]) => ({ address, trust: signed.get(address)! }))), now)
  const setProofs = db.prepare('update profiles set proofs = ? where address = ?')
  for (const [address, f] of filtered) {
    const shown = await reputationProofs(store, address, f.body, lists.indexes, key.address, lists.maxAgeDays, now)
    // By each proof's place among proofsOf's, as filter.ts and tree.ts number them.
    const results = proofsOf(f.body as never).map((p, i) => f.verifications.get(i) ?? shown.get(i) ?? { circuit: p.circuit, result: 'this index does not read this kind of proof' })
    setProofs.run(JSON.stringify(results), address)
  }
}
