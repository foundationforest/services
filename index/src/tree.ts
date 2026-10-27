// The tree this index publishes in the standard's format (proofs/reputation), so a person proves a
// trust from their own profiles on their device, naming none of them.
//
//   - One leaf per tag of a counted profile: the tag its counted stamp proof shows; the scope of
//     its label; its trust, from 0 to 100, as its page shows it; and a count of 1. A reputation
//     proof averages its leaves' scores weighted by their counts, so a trust carried from several
//     profiles is their plain average. Two counted proofs with one tag (two keys of one verifier)
//     give one leaf.
//   - In order of tag, which says nothing about whose leaf is whose.
//   - Built with the reputation client's `buildTree`; its root signed with the index's key over the
//     client's `signedBytes(root, time)`, the time in ms. A new root only when the leaves change, so
//     a proof goes stale only when a trust in the tree moves. Every root is kept (store.ts).
//
// A reputation proof on a profile record shows when its index is one lists/indexes.json names, its
// root is that index's newest or one it signed within `maxAgeDays`, and it checks (the client's
// `checkReputation`). The newest always counts: a tree that does not move for a month still says
// exactly what its proofs say. A root's age is from when this index last signed it, since a root
// that comes back is signed again. This index knows only its own roots.

import { packSignature, scopeOf, signBytes } from '@foundationforest/keys'
import { b64u, hex, type Key, proofsOf, reputationCheck } from '@foundationforest/records'
import { buildTree, checkReputation, signedBytes } from '@foundationforest/reputation'
import { toBytes32 } from '@foundationforest/stamp'

import { checkedOnce } from './filter.ts'
import type { ListedIndex } from './lists.ts'
import type { Store } from './store.ts'

export type ServedLeaf = { tag: string; scope: string; score: number; count: number }
export type Root = { root: string; time: number; signature: string; leaves: number }

/** A reputation proof on a profile record, and what this index made of it. */
export type ReputationResult = {
  circuit: 'reputation'
  index: string | null
  /** The trust the proof shows, from 0 to 100. */
  trust: number | null
  label: string | null
  time: number | null
  result: string
}
export const SHOWN = 'shown'

/** The leaves for these profiles, each with its trust from 0 to 100, in order of tag. */
export function leavesOf(profiles: Array<{ tags: Array<{ tag: string; label: string }>; trust: number }>): ServedLeaf[] {
  const leaves = new Map<string, ServedLeaf>()
  for (const p of profiles) {
    for (const { tag, label } of p.tags) {
      // One tag is one seed, label and verifier name, so one profile; a second is left out.
      if (!leaves.has(tag)) leaves.set(tag, { tag, scope: hex.encode(toBytes32(scopeOf(label))), score: p.trust, count: 1 })
    }
  }
  return [...leaves.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

/** The newest root, or null before the first. */
export function newestRoot(store: Store): Root | null {
  return (store.db.prepare('select root, time, signature, leaves from roots order by time desc limit 1').get() as Root | undefined) ?? null
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** The roots a reputation proof may be made against at `now`: the newest, and every one signed within `maxAgeDays`. */
export function shownRoots(store: Store, maxAgeDays: number, now: number): string[] {
  const within = store.db.prepare('select root from roots where time >= ?').all(now - maxAgeDays * DAY_MS) as Array<{ root: string }>
  const newest = newestRoot(store)
  return [...(newest ? [newest.root] : []), ...within.map((r) => r.root)]
}

export function servedLeaves(store: Store): ServedLeaf[] {
  return store.db.prepare('select tag, scope, score, count from leaves order by n').all() as ServedLeaf[]
}

/** The tree for these leaves: the root kept when they did not change, else a new one, signed. */
export function updateTree(store: Store, key: Key, leaves: ServedLeaf[], now: number): Root | null {
  const same = JSON.stringify(servedLeaves(store)) === JSON.stringify(leaves)
  const newest = newestRoot(store)
  if (same && (newest || !leaves.length)) return newest
  store.tx(() => {
    store.db.exec('delete from leaves')
    const put = store.db.prepare('insert into leaves (n, tag, scope, score, count) values (?, ?, ?, ?, ?)')
    leaves.forEach((l, n) => put.run(n, l.tag, l.scope, l.score, l.count))
  })
  if (!leaves.length) return newest
  const tree = buildTree(leaves.map((l) => ({ tag: BigInt('0x' + l.tag), scope: BigInt('0x' + l.scope), score: BigInt(l.score), count: BigInt(l.count) })))
  const time = Math.max(now, (newest?.time ?? 0) + 1)
  const root: Root = {
    root: hex.encode(toBytes32(tree.root)),
    time,
    signature: b64u.encode(packSignature(signBytes(key.scalar, signedBytes(tree.root, time)))),
    leaves: leaves.length,
  }
  // A root the tree had before comes back as the newest, signed again with its new time; a proof
  // made against it before carries the time and signature it was made with.
  store.db
    .prepare('insert into roots (root, time, signature, leaves) values (?, ?, ?, ?) on conflict (root) do update set time = excluded.time, signature = excluded.signature')
    .run(root.root, root.time, root.signature, root.leaves)
  return root
}

/** Each reputation proof on a profile record, by its place in `proofs`, with what this index made of it. */
export async function reputationProofs(
  store: Store,
  profile: string,
  body: { [key: string]: unknown },
  indexes: ListedIndex[],
  self: string,
  maxAgeDays: number,
  now: number,
): Promise<Map<number, ReputationResult>> {
  const out = new Map<number, ReputationResult>()
  const ours = shownRoots(store, maxAgeDays, now)
  for (const [i, proof] of proofsOf(body as never).entries()) {
    if (proof.circuit !== 'reputation') continue
    const r = reputationCheck(proof, profile)
    const said = (result: string): ReputationResult => ({
      circuit: 'reputation',
      index: typeof proof.index === 'string' ? proof.index : null,
      trust: Number.isSafeInteger(proof.score) ? (proof.score as number) : null,
      label: typeof proof.label === 'string' ? proof.label : null,
      time: Number.isSafeInteger(proof.time) ? (proof.time as number) : null,
      result,
    })
    let result: string
    if (!r) result = "it is not a reputation proof's shape"
    else if (!indexes.some((x) => (x.index === 'self' ? self : x.index) === r.index)) result = 'its index is not one this index lists'
    else if (r.index !== self) result = "this index knows none of that index's roots"
    else if (!ours.includes(hex.encode(toBytes32(r.root)))) result = `its root is neither this index's newest nor one it signed in the last ${maxAgeDays} days`
    else {
      const what = ['reputation', r.index, r.root.toString(), r.time, hex.encode(r.signature), r.score.toString(), r.label ?? null, r.profile, hex.encode(r.proof)]
      result = (await checkedOnce(store, what, () => checkReputation(r))) ? SHOWN : 'it does not check'
    }
    out.set(i, said(result))
  }
  return out
}
