// The registry's rows, read from the program's own accounts (forest/registry/README.md). A row says:
// this profile holds a note this issuer signed, under this label. It holds the profile, the stamp,
// the issuer's key, who paid, when the chain wrote it, and the label; it never changes. The program
// writes a row only after checking the person proof against the issuer's key the row names, so a
// row from an issuer is a row that issuer's note stands behind.
//
// The index reads only the rows of the issuers in lists/issuers.json: `fetchRows`, one
// `getProgramAccounts` per issuer, filtered at the issuer's offset, so the RPC does the filtering.
// Rows never change and never close, so each read finds the same rows and maybe new ones; a row
// already stored is left as it is.

import type { Connection, Commitment } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'

import { hex } from '../../../forest/records/src/index.ts'
import { type Row, fetchRows, fromBytes32, issuerKeyBytes, toBytes32 } from '../../../forest/registry/client/src/index.ts'

import type { Queryable } from '../db.ts'
import { splitLabel } from '../markets.ts'

/** One row, as the index stores it. */
export type RowRecord = {
  address: string
  /** The profile's address, which signed the row. */
  profile: string
  /** 64 hex: the row's stamp, the person's for this label at this issuer. */
  stamp: string
  /** 128 hex: the issuer's key, x then y, as the row holds it. */
  issuer: string
  payer: string
  /** When the chain wrote the row: Unix seconds. */
  made: number
  label: string
  market: string
  role: string | null
}

/** An issuer's key, as the index writes it: 128 hex characters, x then y. */
export const issuerHex = (issuer: Row['issuer']): string => hex.encode(issuerKeyBytes(issuer))

/** An issuer's key from its 128 hex characters. */
export function issuerFromHex(text: string): Row['issuer'] {
  const bytes = hex.decode(text)
  return [fromBytes32(bytes.subarray(0, 32)), fromBytes32(bytes.subarray(32))]
}

/** A row as the index stores it. */
export function rowRecord(address: string, row: Row): RowRecord {
  return {
    address,
    profile: row.profile.toBase58(),
    stamp: hex.encode(toBytes32(row.stamp)),
    issuer: issuerHex(row.issuer),
    payer: row.payer.toBase58(),
    made: row.made,
    label: row.label,
    ...splitLabel(row.label),
  }
}

/** A row, once: it never changes after it is written. Returns whether it is new here. */
export async function storeRow(db: Queryable, r: RowRecord): Promise<boolean> {
  const res = await db.query(
    `insert into rows (address, profile, stamp, issuer, payer, made, label, market, role)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
    [r.address, r.profile, r.stamp, r.issuer, r.payer, r.made, r.label, r.market, r.role],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Every row of each issuer, read now. The program id goes to the registry client as this copy's key,
 * which the connection reads only as base58.
 */
export async function readRows(connection: Connection, programId: string, issuers: string[], commitment: Commitment): Promise<RowRecord[]> {
  const out: RowRecord[] = []
  for (const issuer of issuers) {
    const rows = await fetchRows(connection as never, { issuer: issuerFromHex(issuer), programId: new PublicKey(programId) as never, commitment })
    for (const { address, row } of rows) out.push(rowRecord(address.toBase58(), row))
  }
  return out
}

/**
 * A row `r` this index counts: its issuer is one it trusts (`$1`, their keys). Every other row counts
 * for nothing here, and a profile with no counted row is neither stored nor shown.
 */
export const COUNTED = `(r.issuer = any($1))`

/** The profiles holding a counted row: all of them, or those among `profiles`. */
export async function countedProfiles(db: Queryable, issuers: string[], profiles?: string[]): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct r.profile from rows r where ${COUNTED}${profiles ? ' and r.profile = any($2)' : ''}`,
    profiles ? [issuers, profiles] : [issuers],
  )
  return new Set(rows.map((r) => r.profile as string))
}
