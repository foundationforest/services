// The registry adapter: `Registered` entries into the index's own `Badge`. Only entries the
// registry program itself wrote are read (`decodeRegisteredEvents` follows the runtime's invoke
// lines), so another program writing the same bytes with any DID adds no badge.

import { PublicKey } from '@solana/web3.js'

import { PROGRAM_ID, decodeRegisteredEvents } from '../../../registry/client/src/program.ts'
import { splitScope } from '../markets.ts'

export const REGISTRY_PROGRAM_ID: string = PROGRAM_ID.toBase58()

export type Badge = {
  /** The name the proof was made for, as the entry wrote it. Counted only if it is a directory name, byte for byte. */
  scope: string
  market: string
  role: string | null
  did: string
  /** The profile's wallet that signed. The badge counts only if the profile declares this wallet. */
  wallet: string
  code: string
  listIndex: number
  /** Who vouched: the list's owner when the badge was registered. */
  listOwner: string
}

export function decodeBadges(logs: string[], programId: string = REGISTRY_PROGRAM_ID): Badge[] {
  // The client's `PublicKey` comes from its own copy of web3.js; the decoder only reads its base58.
  return decodeRegisteredEvents(logs, new PublicKey(programId) as never).map((e) => ({
    scope: e.market,
    ...splitScope(e.market),
    did: e.did,
    wallet: e.wallet.toBase58(),
    code: Buffer.from(e.code).toString('hex'),
    listIndex: e.listIndex,
    listOwner: e.listOwner.toBase58(),
  }))
}
