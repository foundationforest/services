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
//
// A row's bytes do not hold its market stamp: the stamp is the seed of the row's address, and is in
// the `register` instruction that wrote it. The reputation tree needs it (scores/reputation.ts), so
// each counted row's stamp is read once from that transaction (`readStamp`), and kept only when the
// row's address is derived from it.

import type { Connection, Commitment, Finality } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'

import { base58, hex } from '../../../forest/records/src/index.ts'
import { type Row, discriminator, fetchRows, issuerSigned, rowAddress } from '../../../forest/registry/client/src/index.ts'

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
  /** 64 hex: the row's market stamp, once read from the transaction that wrote the row; null until then. */
  marketStamp: string | null
}

/** A row as the index stores it. Its market stamp is read later, from its transaction. */
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
    marketStamp: null,
  }
}

/** A row, once: it never changes after it is written. Returns whether it is new here. */
export async function storeRow(db: Queryable, r: RowRecord): Promise<boolean> {
  const res = await db.query(
    `insert into rows (address, profile, issuer, root, issuer_signature, issuer_signed, payer, label, market, role, market_stamp)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing`,
    [r.address, r.profile, r.issuer, r.root, r.issuerSignature, r.issuerSigned, r.payer, r.label, r.market, r.role, r.marketStamp],
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

const REGISTER = discriminator('global', 'register')

/**
 * A row's market stamp, from the instructions of a transaction: the 32 bytes after `register`'s
 * discriminator (the registry client's `registerIx`), kept only when the row's address is derived
 * from them, so no other stamp can pass for the row's. 64 hex, or null when none is the row's.
 */
export function stampFrom(instructions: { programId: string; data: Uint8Array }[], programId: string, row: string): string | null {
  for (const ix of instructions) {
    if (ix.programId !== programId || ix.data.length < 40 || !REGISTER.every((b, i) => ix.data[i] === b)) continue
    const stamp = ix.data.slice(8, 40)
    if (rowAddress(stamp, new PublicKey(programId) as never).toBase58() === row) return hex.encode(stamp)
  }
  return null
}

/**
 * A row's market stamp, from the transaction that wrote it: the row's transactions, oldest first,
 * the failed ones skipped, each instruction looked through, inner ones too. Null when the RPC serves
 * none that holds it.
 */
export async function readStamp(connection: Connection, programId: string, row: string, commitment: Finality): Promise<string | null> {
  const signatures = await connection.getSignaturesForAddress(new PublicKey(row), { limit: 1000 }, commitment)
  for (const s of signatures.reverse()) {
    if (s.err) continue
    const tx = await connection.getTransaction(s.signature, { commitment, maxSupportedTransactionVersion: 0 })
    if (!tx || tx.meta?.err) continue
    const message = tx.transaction.message
    const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    const program = (i: number) => keys.get(i)?.toBase58() ?? ''
    const stamp = stampFrom(
      [
        ...message.compiledInstructions.map((ix) => ({ programId: program(ix.programIdIndex), data: ix.data })),
        ...(tx.meta?.innerInstructions ?? []).flatMap((inner) =>
          inner.instructions.map((ix) => ({ programId: program(ix.programIdIndex), data: base58.decode(ix.data) })),
        ),
      ],
      programId,
      row,
    )
    if (stamp) return stamp
  }
  return null
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
