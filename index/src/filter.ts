// What decides which profiles count here. A profile counts when its profile entry names a market in
// the directory and a role of that market, and carries a verification that:
//
//   1. is a verification's shape (the standard's `verificationCheck`, for this profile's address);
//   2. names a key lists/verifiers.json lists;
//   3. carries the verifier name that list gives the key;
//   4. is for the label `<market>/<role>`, the profile entry's own;
//   5. checks (the verification client's `checkVerification`);
//   6. was first seen by this index no later than the key's `until`, when the list gives one.
//
// A counted profile's uniqueness is 1 - prod(1 - c) over the confidences of the keys its
// verifications count for, each key once (rank.ts): the chance that at least one of its checks
// holds. When this index first saw each is kept by the profile's key and the verifier's key, one
// row for each pair.

import { createHash } from 'node:crypto'

import { hex, proofsOf, verificationCheck } from '@foundationforest/folders'
import { checkVerification } from '@foundationforest/verification'

import type { ListedKey } from './lists.ts'
import type { Markets } from './markets.ts'
import { uniqueness } from './rank.ts'
import type { Store } from './store.ts'

/** One check a counted profile passed: the verifier's name, its key, and what the pages call its check. */
export type Check = { verifier: string; key: string; label: string }

/** A verification on a profile entry, and what this index made of it. */
export type VerificationResult = { circuit: 'verification'; verifier: string | null; key: string | null; label: string | null; result: string }

export type Filtered = {
  counted: boolean
  /** From 0 to 1, from the keys its verifications count for. */
  uniqueness: number
  checks: Check[]
  /** By the proof's place in the profile entry's `proofs`. */
  verifications: Map<number, VerificationResult>
}

export type Profile = { address: string; body: { [key: string]: unknown }; market: string | null; role: string | null }

export const COUNTS = 'counts'

/** A check's answer, kept by a hash of everything it took, so a proof is checked once. */
export async function checkedOnce(store: Store, what: unknown[], check: () => Promise<boolean>): Promise<boolean> {
  const hash = createHash('sha256').update(JSON.stringify(what)).digest('hex')
  const held = store.db.prepare('select ok from checked where hash = ?').get(hash) as { ok: number } | undefined
  if (held) return held.ok === 1
  const ok = await check()
  store.db.prepare('insert or replace into checked (hash, ok) values (?, ?)').run(hash, ok ? 1 : 0)
  return ok
}

/** When this index first saw a checked verification of this key on this profile: now, the first time. */
function firstSeen(store: Store, profile: string, key: string, now: number): number {
  store.db.prepare('insert or ignore into seen (profile, key, first) values (?, ?, ?)').run(profile, key, now)
  return (store.db.prepare('select first from seen where profile = ? and key = ?').get(profile, key) as { first: number }).first
}

export async function filter(store: Store, profile: Profile, keys: ListedKey[], markets: Markets, now: number): Promise<Filtered> {
  const out: Filtered = { counted: false, uniqueness: 0, checks: [], verifications: new Map() }
  const confidences = new Map<string, number>()
  const market = profile.market ? markets.get(profile.market) : undefined
  const inDirectory = !!market && market.roles.some((r) => r.role === profile.role)
  const label = `${profile.market}/${profile.role}`

  for (const [i, proof] of proofsOf(profile.body as never).entries()) {
    if (proof.circuit !== 'verification') continue
    const v = verificationCheck(proof, profile.address)
    const said = (result: string): VerificationResult => ({
      circuit: 'verification',
      verifier: typeof proof.verifierName === 'string' ? proof.verifierName : null,
      key: typeof proof.verifier === 'string' ? proof.verifier : null,
      label: typeof proof.label === 'string' ? proof.label : null,
      result,
    })
    const listed = v && keys.find((k) => k.key === v.verifier)
    let result: string
    if (!v) result = "it is not a verification's shape"
    else if (!inDirectory) result = `this profile's market and role, ${label}, are not a market and one of its roles in the directory`
    else if (!listed) result = 'its key is not one this index lists'
    else if (v.verifierName !== listed.verifier) result = `its verifier name is not ${listed.verifier}, the name this index lists for its key`
    else if (v.label !== label) result = `its label is not ${label}, this profile's market and role`
    else if (!(await checkedOnce(store, ['verification', v.verifier, v.verifierName, v.label, v.profile, hex.encode(v.proof)], () => checkVerification(v)))) {
      result = 'it does not check'
    } else {
      const first = firstSeen(store, profile.address, v.verifier, now)
      if (listed.until !== undefined && first > listed.until) {
        result = `this index first saw it after ${new Date(listed.until).toISOString()}, when its key stopped counting here`
      } else {
        result = COUNTS
        out.counted = true
        confidences.set(listed.key, listed.confidence)
        if (!out.checks.some((c) => c.key === listed.key)) out.checks.push({ verifier: listed.verifier, key: listed.key, label: listed.label })
      }
    }
    out.verifications.set(i, said(result))
  }
  out.uniqueness = uniqueness([...confidences.values()])
  return out
}
