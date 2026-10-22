// What decides which profiles count here. A profile counts when its profile record names a
// market in the directory and a role of that market, and carries a note proof that:
//
//   1. is a note proof's shape (the standard's `noteCheck`, for this profile's address);
//   2. names a key lists/issuers.json lists;
//   3. carries the issuer name that list gives the key;
//   4. is for the label `<market>/<role>`, the profile record's own;
//   5. checks (the note client's `verifyNote`);
//   6. was first seen by this index no later than the key's `until`, when the list gives one.
//
// A counted profile starts the ranking with the points of its counted keys, the largest one: two
// keys of one issuer are one person checked twice (README.md, FAQ). Each counted proof gives the
// profile's stamp for its label at that issuer, the tree's leaf (tree.ts).

import { createHash } from 'node:crypto'

import { verifyNote } from '@foundationforest/note'
import { hex, noteCheck, proofsOf } from '@foundationforest/records'

import type { ListedKey } from './lists.ts'
import type { Markets } from './markets.ts'
import type { Store } from './store.ts'

/** One check a counted profile passed: the issuer's name, its key, and what the pages call its check. */
export type Check = { issuer: string; key: string; label: string }

/** A note proof on a profile record, and what this index made of it. */
export type NoteResult = { circuit: 'note'; issuer: string | null; key: string | null; label: string | null; result: string }

export type Filtered = {
  counted: boolean
  points: number
  checks: Check[]
  /** The profile's stamps from its counted proofs, each with its label, in hex. */
  stamps: Array<{ stamp: string; label: string }>
  /** By the proof's place in the profile record's `proofs`. */
  notes: Map<number, NoteResult>
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

/** When this index first saw a checked proof of this key on this profile: now, the first time. */
function firstSeen(store: Store, profile: string, key: string, stamp: string, now: number): number {
  store.db.prepare('insert or ignore into seen (profile, key, stamp, first) values (?, ?, ?, ?)').run(profile, key, stamp, now)
  return (store.db.prepare('select first from seen where profile = ? and key = ?').get(profile, key) as { first: number }).first
}

export async function filter(store: Store, profile: Profile, keys: ListedKey[], markets: Markets, now: number): Promise<Filtered> {
  const out: Filtered = { counted: false, points: 0, checks: [], stamps: [], notes: new Map() }
  const market = profile.market ? markets.get(profile.market) : undefined
  const inDirectory = !!market && market.roles.some((r) => r.role === profile.role)
  const label = `${profile.market}/${profile.role}`

  for (const [i, proof] of proofsOf(profile.body as never).entries()) {
    if (proof.circuit !== 'note') continue
    const note = noteCheck(proof, profile.address)
    const said = (result: string): NoteResult => ({
      circuit: 'note',
      issuer: typeof proof.issuerName === 'string' ? proof.issuerName : null,
      key: typeof proof.issuer === 'string' ? proof.issuer : null,
      label: typeof proof.label === 'string' ? proof.label : null,
      result,
    })
    const listed = note && keys.find((k) => k.key === note.issuer)
    let result: string
    if (!note) result = "it is not a note proof's shape"
    else if (!inDirectory) result = `this profile's market and role, ${label}, are not a market and one of its roles in the directory`
    else if (!listed) result = 'its key is not one this index lists'
    else if (note.issuerName !== listed.issuer) result = `its issuer name is not ${listed.issuer}, the name this index lists for its key`
    else if (note.label !== label) result = `its label is not ${label}, this profile's market and role`
    else if (!(await checkedOnce(store, ['note', note.issuer, note.issuerName, note.label, note.profile, hex.encode(note.stamp), hex.encode(note.proof)], () => verifyNote(note)))) {
      result = 'it does not check'
    } else {
      const stamp = hex.encode(note.stamp)
      const first = firstSeen(store, profile.address, note.issuer, stamp, now)
      if (listed.until !== undefined && first > listed.until) {
        result = `this index first saw it after ${new Date(listed.until).toISOString()}, when its key stopped counting here`
      } else {
        result = COUNTS
        out.counted = true
        out.points = Math.max(out.points, listed.points)
        if (!out.checks.some((c) => c.key === listed.key)) out.checks.push({ issuer: listed.issuer, key: listed.key, label: listed.label })
        if (!out.stamps.some((s) => s.stamp === stamp)) out.stamps.push({ stamp, label })
      }
    }
    out.notes.set(i, said(result))
  }
  return out
}
