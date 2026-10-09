// The reputation tree this index publishes, in forest's format (standard/circuits/README.md, "The tree
// an index publishes"), so a person proves on their device a score from their own profiles, naming
// none of them (standard/circuits/reputation).
//
//   a leaf   one per stamp of a counted row (README.md, "Which rows count"), for each profile with
//            a rating: Poseidon(stamp, scope, score, count), where stamp is the row's own, scope the
//            row's label as the registry computes it, score the rating times ten as the pages round it
//            (1.0 to 10.0 is 10 to 100), and count the reviews the rating comes from. A profile with
//            no rating has no leaf: a leaf with no review can prove nothing. A profile with rows from
//            two issuers has two leaves, one per stamp, and proves from either issuer's secret.
//   order    by stamp: stable, and it says nothing about whose leaf is whose.
//   root     circuits' buildTree over the leaves, signed with the index's ed25519 key (the one that
//            signs its scores, sign.ts) over circuits' signedBytes(root, time), the time in ms.
//
// Rebuilt after every scoring pass (run.ts), in its transaction. Leaves that did not change keep
// their root, time and signature, as an unchanged score keeps its statement, so a proof made against
// the newest root stays against the newest root. With no leaf there is no tree.

import { ed25519 } from '@noble/curves/ed25519.js'

import { type Leaf, buildTree, signedBytes } from '../../../standard/circuits/reputation/src/index.ts'
import { b64u, hex } from '../../../standard/records/src/index.ts'
import { isFieldElement, scopeOf, toBytes32 } from '../../../standard/registry/client/src/field.ts'

import type { Queryable } from '../db.ts'
import type { Directory } from '../markets.ts'
import { type Inputs, type Rating, stampStatus } from './compute.ts'
import type { IndexKeys } from './sign.ts'

/** A field element as the tree's URLs and a profile's proofs write it: 32 bytes, 64 lowercase hex. */
export const hex64 = (v: bigint): string => hex.encode(toBytes32(v))

/** The tree's leaves, in its order: one per stamp of a counted row of a profile with a rating. */
export function reputationLeaves(inputs: Pick<Inputs, 'profiles' | 'stamps'>, rating: Rating[], directory: Directory): Leaf[] {
  const profiles = new Map(inputs.profiles.map((p) => [p.address, p]))
  const rated = new Map(rating.filter((r) => r.value !== null).map((r) => [r.profile, r]))
  const leaves = new Map<string, Leaf>()
  for (const st of inputs.stamps) {
    const profile = profiles.get(st.profile)
    const r = rated.get(st.profile)
    if (!profile || !r || !st.stamp || !stampStatus(st, profile, directory).counted) continue
    const stamp = BigInt(`0x${st.stamp}`)
    if (!isFieldElement(stamp)) continue
    leaves.set(st.stamp, { stamp, scope: scopeOf(st.label), score: BigInt(Math.round(r.value! * 10)), count: BigInt(r.reviews) })
  }
  return [...leaves.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, leaf]) => leaf)
}

/**
 * Store the tree of these leaves: a new root, signed now, only when the leaves changed. With no leaf
 * the stored leaves go and the pages serve no tree; the roots signed before stay, for the proofs made
 * against them.
 */
export async function rebuild(client: Queryable, leaves: Leaf[], keys: IndexKeys, time: number): Promise<void> {
  const rows = leaves.map((l) => ({ stamp: hex64(l.stamp), scope: hex64(l.scope), score: l.score.toString(), count: l.count.toString() }))
  const { rows: old } = await client.query('select stamp, scope, score::text, count::text from reputation_leaves order by position')
  const same =
    old.length === rows.length &&
    old.every((o, i) => o.stamp === rows[i]!.stamp && o.scope === rows[i]!.scope && o.score === rows[i]!.score && o.count === rows[i]!.count)
  if (same) return
  await client.query('delete from reputation_leaves')
  if (!leaves.length) return
  const { root } = buildTree(leaves)
  const signature = ed25519.sign(signedBytes(root, time), keys.ed25519.secret)
  await client.query('insert into reputation_roots (root, time, signature, leaves) values ($1, $2, $3, $4)', [
    hex64(root),
    time,
    b64u.encode(signature),
    leaves.length,
  ])
  await client.query(
    `insert into reputation_leaves (position, stamp, scope, score, count)
     select * from unnest($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[])`,
    [rows.map((_, i) => i), rows.map((r) => r.stamp), rows.map((r) => r.scope), rows.map((r) => r.score), rows.map((r) => r.count)],
  )
}
