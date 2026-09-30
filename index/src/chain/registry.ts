// The registry adapter: its lines, read from the registry program's own accounts. A line is written
// once and never changes (forest/registry/README.md): this profile is one verified human under this
// label, proven against the list whose root the line holds. Who vouched is not on chain: it is
// whichever trusted issuer published that root (issuers.ts), and any membership record in the
// profile's folder (memberships.ts).
//
// The chain reader backfills every line from the program's accounts at start (`fetchLines`: every
// account with the line's discriminator, each checked to sit at the address its own code derives),
// then follows only new transactions to pick up new lines (`linesIn`). So the index never needs a
// transaction older than its start to know every badge.

import { type AccountInfo, PublicKey } from '@solana/web3.js'

import { hex } from '../../../forest/records/src/bytes.ts'
import { didFromPublicKey } from '../../../forest/records/src/keys.ts'
import { type Line, PROGRAM_ID, decodeLine, lineAddress } from '../../../forest/registry/client/src/program.ts'
import { splitScope } from '../markets.ts'

export const REGISTRY_PROGRAM_ID: string = PROGRAM_ID.toBase58()

/** One line, as the index stores it. */
export type LineRow = {
  address: string
  /** The proof's nullifier: one per human per label. 64 lowercase hex. */
  code: string
  /** The profile the line names, by its did:key. */
  did: string
  /** The same key as an address: the profile's wallet. */
  wallet: string
  /** The name the proof was made for, as the line holds it. Counted only as `market/role` under a directory name, byte for byte. */
  label: string
  market: string
  role: string | null
  /** The root of the issuer's list the proof was made against. 64 lowercase hex. */
  root: string
  /** Unix seconds. */
  time: number
  payer: string
}

/** A line as the index stores it. */
export function lineRow(address: string, line: Line): LineRow {
  return {
    address,
    code: hex.encode(line.code),
    did: didFromPublicKey(line.profile.toBytes()),
    wallet: line.profile.toBase58(),
    label: line.label,
    ...splitScope(line.label),
    root: hex.encode(line.root),
    time: Number(line.time),
    payer: line.payer.toBase58(),
  }
}

/** A stored line, in the shape the registry client's checks read: its profile, code, label and root. */
export function lineOf(row: { wallet: string; code: string; label: string; root: string; payer: string; time: Date | string }): Line {
  return {
    profile: new PublicKey(row.wallet) as never,
    code: hex.decode(row.code),
    payer: new PublicKey(row.payer) as never,
    time: BigInt(Math.floor(new Date(row.time).getTime() / 1000)),
    bump: 0,
    root: hex.decode(row.root),
    label: row.label,
  }
}

/**
 * The line an account holds, or null when it holds none: not the registry's, not a line's bytes, or
 * not at the address its own code derives.
 */
export function lineAt(address: string, account: Pick<AccountInfo<Buffer | Uint8Array>, 'owner' | 'data'>, programId: string): LineRow | null {
  if (account.owner.toBase58() !== programId) return null
  let line: Line
  try {
    line = decodeLine(new Uint8Array(account.data))
  } catch {
    return null
  }
  // The client's PublicKey comes from its own copy of web3.js; the derivation only reads its bytes.
  if (lineAddress(line.code, new PublicKey(programId) as never).toBase58() !== address) return null
  return lineRow(address, line)
}

/** Every line among a transaction's accounts: the accounts, read now, that hold one. */
export function linesIn(keys: PublicKey[], accounts: (AccountInfo<Buffer> | null)[], programId: string): LineRow[] {
  const out: LineRow[] = []
  keys.forEach((key, i) => {
    const account = accounts[i]
    const row = account ? lineAt(key.toBase58(), account, programId) : null
    if (row) out.push(row)
  })
  return out
}
