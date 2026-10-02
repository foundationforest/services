// The registry's rows, read from the program's own accounts (forest/registry/README.md). A row says:
// this profile holds a market stamp on this keeper's list, under this label. It carries the root of
// the keeper's list the proof was made against and the keeper's signature on that root, and it never
// changes.
//
// The index reads only the rows of the keepers in lists/keepers.json: `fetchRows`, one
// `getProgramAccounts` per keeper, filtered at the keeper's offset, so the RPC does the filtering.
// Rows never change and never close, so each read finds the same rows and maybe new ones; a row
// already stored is left as it is. A row counts when its keeper's signature on its root checks
// (`keeperSigned`), which needs nothing but the row: no issuer's file, no list.

import type { Connection, Commitment } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'

import { base58, hex } from '../../../forest/records/src/index.ts'
import { type Row, fetchRows, keeperSigned } from '../../../forest/registry/client/src/index.ts'

import type { Queryable } from '../db.ts'
import { splitLabel } from '../markets.ts'

/** One row, as the index stores it. */
export type RowRecord = {
  address: string
  /** The profile's address, which signed the row. */
  profile: string
  keeper: string
  /** 64 hex: the root of the keeper's list the proof was made against. */
  root: string
  /** 128 hex: the keeper's signature over that root, as the row holds it. */
  keeperSignature: string
  keeperSigned: boolean
  payer: string
  label: string
  market: string
  role: string | null
}

/** A row as the index stores it. */
export function rowRecord(address: string, row: Row): RowRecord {
  return {
    address,
    profile: row.profile.toBase58(),
    keeper: row.keeper.toBase58(),
    root: hex.encode(row.root),
    keeperSignature: hex.encode(row.keeperSignature),
    keeperSigned: keeperSigned(row),
    payer: row.payer.toBase58(),
    label: row.label,
    ...splitLabel(row.label),
  }
}

/** A row, once: it never changes after it is written. Returns whether it is new here. */
export async function storeRow(db: Queryable, r: RowRecord): Promise<boolean> {
  const res = await db.query(
    `insert into rows (address, profile, keeper, root, keeper_signature, keeper_signed, payer, label, market, role)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
    [r.address, r.profile, r.keeper, r.root, r.keeperSignature, r.keeperSigned, r.payer, r.label, r.market, r.role],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Every row of each keeper, read now. The registry client has its own copy of web3.js, so a keeper
 * goes to it as its 32 bytes, which its filter takes as they are, and the program id as this copy's
 * key, which the connection reads only as base58.
 */
export async function readRows(connection: Connection, programId: string, keepers: string[], commitment: Commitment): Promise<RowRecord[]> {
  const out: RowRecord[] = []
  for (const keeper of keepers) {
    const rows = await fetchRows(connection as never, { keeper: base58.decode(keeper) as never, programId: new PublicKey(programId) as never, commitment })
    for (const { address, row } of rows) out.push(rowRecord(address.toBase58(), row))
  }
  return out
}

/**
 * A row `r` this index counts: its keeper is one it trusts (`$1`, their addresses) and the keeper's
 * signature on its root checks. Every other row counts for nothing here, and a profile with no
 * counted row is neither stored nor shown.
 */
export const COUNTED = `(r.keeper = any($1) and r.keeper_signed)`

/** The profiles holding a counted row: all of them, or those among `profiles`. */
export async function countedProfiles(db: Queryable, keepers: string[], profiles?: string[]): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct r.profile from rows r where ${COUNTED}${profiles ? ' and r.profile = any($2)' : ''}`,
    profiles ? [keepers, profiles] : [keepers],
  )
  return new Set(rows.map((r) => r.profile as string))
}
