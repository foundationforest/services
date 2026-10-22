// The tree this index publishes in the standard's format (proofs/reputation), so a person proves a
// rating from their own profiles on their device, naming none of them.
//
//   - One leaf per stamp of a counted profile with a rating: the stamp its counted note proof shows;
//     the scope of its label; its rating times ten, rounded (9.2 is 92); and how many counted
//     reviews it received. Two counted proofs with one stamp (two keys of one issuer) give one leaf.
//   - In order of stamp, which says nothing about whose leaf is whose.
//   - Built with the reputation client's `buildTree`; its root signed with the index's key over the
//     client's `signedBytes(root, time)`, the time in ms. A new root only when the leaves change, so
//     a proof goes stale only when a rating in the tree moves. Every root is kept (store.ts).
//
// A reputation proof on a profile record shows when its index is one lists/indexes.json names, its
// root is one of that index's newest `roots`, and it checks (the client's `verifyReputation`). This
// index knows only its own roots.

import { packSignature, scopeOf, signBytes } from '@foundationforest/keys'
import { toBytes32 } from '@foundationforest/note'
import { b64u, hex, type Key, proofsOf, reputationCheck } from '@foundationforest/records'
import { buildTree, signedBytes, verifyReputation } from '@foundationforest/reputation'

import { checkedOnce } from './filter.ts'
import type { ListedIndex } from './lists.ts'
import type { Store } from './store.ts'

export type ServedLeaf = { stamp: string; scope: string; score: number; count: number }
export type Root = { root: string; time: number; signature: string; leaves: number }

/** A reputation proof on a profile record, and what this index made of it. */
export type ReputationResult = {
  circuit: 'reputation'
  index: string | null
  /** The score the proof shows, out of 10. */
  rating: number | null
  label: string | null
  time: number | null
  result: string
}
export const SHOWN = 'shown'

/** The leaves for these profiles, in order of stamp. */
export function leavesOf(profiles: Array<{ stamps: Array<{ stamp: string; label: string }>; value: number | null; reviews: number }>): ServedLeaf[] {
  const leaves = new Map<string, ServedLeaf>()
  for (const p of profiles) {
    if (p.value === null) continue
    for (const { stamp, label } of p.stamps) {
      // One stamp is one seed, label and issuer name, so one profile; a second is left out.
      if (!leaves.has(stamp)) leaves.set(stamp, { stamp, scope: hex.encode(toBytes32(scopeOf(label))), score: Math.round(p.value * 10), count: p.reviews })
    }
  }
  return [...leaves.values()].sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0))
}

/** The newest root, or null before the first. */
export function newestRoot(store: Store): Root | null {
  return (store.db.prepare('select root, time, signature, leaves from roots order by time desc limit 1').get() as Root | undefined) ?? null
}

/** The newest `n` roots. */
export function newestRoots(store: Store, n: number): Root[] {
  return store.db.prepare('select root, time, signature, leaves from roots order by time desc limit ?').all(n) as Root[]
}

export function servedLeaves(store: Store): ServedLeaf[] {
  return store.db.prepare('select stamp, scope, score, count from leaves order by n').all() as ServedLeaf[]
}

/** The tree for these leaves: the root kept when they did not change, else a new one, signed. */
export function updateTree(store: Store, key: Key, leaves: ServedLeaf[], now: number): Root | null {
  const same = JSON.stringify(servedLeaves(store)) === JSON.stringify(leaves)
  const newest = newestRoot(store)
  if (same && (newest || !leaves.length)) return newest
  store.tx(() => {
    store.db.exec('delete from leaves')
    const put = store.db.prepare('insert into leaves (n, stamp, scope, score, count) values (?, ?, ?, ?, ?)')
    leaves.forEach((l, n) => put.run(n, l.stamp, l.scope, l.score, l.count))
  })
  if (!leaves.length) return newest
  const tree = buildTree(leaves.map((l) => ({ stamp: BigInt('0x' + l.stamp), scope: BigInt('0x' + l.scope), score: BigInt(l.score), count: BigInt(l.count) })))
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
export async function reputationProofs(store: Store, profile: string, body: { [key: string]: unknown }, indexes: ListedIndex[], self: string, roots: number): Promise<Map<number, ReputationResult>> {
  const out = new Map<number, ReputationResult>()
  const ours = newestRoots(store, roots).map((r) => r.root)
  for (const [i, proof] of proofsOf(body as never).entries()) {
    if (proof.circuit !== 'reputation') continue
    const r = reputationCheck(proof, profile)
    const said = (result: string): ReputationResult => ({
      circuit: 'reputation',
      index: typeof proof.index === 'string' ? proof.index : null,
      rating: Number.isSafeInteger(proof.score) ? (proof.score as number) / 10 : null,
      label: typeof proof.label === 'string' ? proof.label : null,
      time: Number.isSafeInteger(proof.time) ? (proof.time as number) : null,
      result,
    })
    let result: string
    if (!r) result = "it is not a reputation proof's shape"
    else if (!indexes.some((x) => (x.index === 'self' ? self : x.index) === r.index)) result = 'its index is not one this index lists'
    else if (r.index !== self) result = "this index knows none of that index's roots"
    else if (!ours.includes(hex.encode(toBytes32(r.root)))) result = `its root is not one of this index's newest ${roots}`
    else {
      const what = ['reputation', r.index, r.root.toString(), r.time, hex.encode(r.signature), r.score.toString(), r.label ?? null, r.profile, hex.encode(r.proof)]
      result = (await checkedOnce(store, what, () => verifyReputation(r))) ? SHOWN : 'it does not check'
    }
    out.set(i, said(result))
  }
  return out
}
