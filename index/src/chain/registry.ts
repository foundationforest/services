// The registry's rows, read from the program's own accounts (forest/registry/README.md). A row says:
// this profile holds a market stamp on this issuer's list, under this label. It carries the root of
// the issuer's list the proof was made against and the issuer's signature on that root, and it never
// changes.
//
// The index reads only the rows of the issuers in lists/issuers.json: `fetchRows`, one
// `getProgramAccounts` per issuer, filtered at the issuer's offset, so the RPC does the filtering.
// Rows never change and never close, so each read finds the same rows and maybe new ones; a row
// already stored is left as it is. A row counts when its issuer's signature on its root checks
// (`issuerSigned`), which needs nothing but the row: no file from the issuer, no list.

import type { Connection, Commitment } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'

import { base58, hex } from '../../../forest/records/src/index.ts'
import { type Row, fetchRows, issuerSigned } from '../../../forest/registry/client/src/index.ts'

import type { Queryable } from '../db.ts'
import { splitLabel } from '../markets.ts'

/** One row, as the index stores it. */
export type RowRecord = {
  address: string
  /** The profile's address, which signed the row. */
  profile: string
  issuer: string
  /** 64 hex: the root of the issuer's list the proof was made against. */
  root: string
  /** 128 hex: the issuer's signature over that root, as the row holds it. */
  issuerSignature: string
  issuerSigned: boolean
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
    issuer: row.issuer.toBase58(),
    root: hex.encode(row.root),
    issuerSignature: hex.encode(row.issuerSignature),
    issuerSigned: issuerSigned(row),
    payer: row.payer.toBase58(),
    label: row.label,
    ...splitLabel(row.label),
  }
}

/** A row, once: it never changes after it is written. Returns whether it is new here. */
export async function storeRow(db: Queryable, r: RowRecord): Promise<boolean> {
  const res = await db.query(
    `insert into rows (address, profile, issuer, root, issuer_signature, issuer_signed, payer, label, market, role)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
    [r.address, r.profile, r.issuer, r.root, r.issuerSignature, r.issuerSigned, r.payer, r.label, r.market, r.role],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Every row of each issuer, read now. The registry client has its own copy of web3.js, so an issuer
 * goes to it as its 32 bytes, which its filter takes as they are, and the program id as this copy's
 * key, which the connection reads only as base58.
 */
export async function readRows(connection: Connection, programId: string, issuers: string[], commitment: Commitment): Promise<RowRecord[]> {
  const out: RowRecord[] = []
  for (const issuer of issuers) {
    const rows = await fetchRows(connection as never, { issuer: base58.decode(issuer) as never, programId: new PublicKey(programId) as never, commitment })
    for (const { address, row } of rows) out.push(rowRecord(address.toBase58(), row))
  }
  return out
}

/**
 * A row `r` this index counts: its issuer is one it trusts (`$1`, their addresses) and the issuer's
 * signature on its root checks. Every other row counts for nothing here, and a profile with no
 * counted row is neither stored nor shown.
 */
export const COUNTED = `(r.issuer = any($1) and r.issuer_signed)`

/** The profiles holding a counted row: all of them, or those among `profiles`. */
export async function countedProfiles(db: Queryable, issuers: string[], profiles?: string[]): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct r.profile from rows r where ${COUNTED}${profiles ? ' and r.profile = any($2)' : ''}`,
    profiles ? [issuers, profiles] : [issuers],
  )
  return new Set(rows.map((r) => r.profile as string))
}
