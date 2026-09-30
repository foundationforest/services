// Issuers' roots, read from the chain. An issuer may write each root it publishes to Solana too, as
// one memo its own key signs (the issuer's README, "Each root on chain"):
//
//   forest.foundation/issuer/root/v1\n{"root":"<decimal>","size":n,"time":ms}
//
// For each issuer this index trusts, the reader looks up every transaction naming the issuer's key
// (its did:key's public key is its Solana address) since the last one it read, and keeps a root from
// a transaction only when the transaction succeeded, the issuer's key signed it, and a top-level
// instruction to the memo program (v2) names that key and carries exactly that text. Anything else
// naming the key, such as a transfer to it, is passed over. A root found here counts as one from the
// issuer's roots file does; either is enough.

import { type Connection, type Finality, PublicKey, type VersionedMessage } from '@solana/web3.js'

import { base58, fromUtf8 } from '../../../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../../../forest/records/src/canonical.ts'
import { publicKeyFromDid } from '../../../forest/records/src/keys.ts'

import { type Db, getCursor, setCursor } from '../db.ts'
import { type Root, checkRoot, storeRoots } from '../issuers.ts'

/** Solana's memo program, v2: it checks that every account it is given signed. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
/** Every root memo begins with this. */
export const ROOT_MEMO_LABEL = 'forest.foundation/issuer/root/v1\n'

/** What the reader needs of a transaction: whether it failed, and its message. */
export type ReadTransaction = { meta: { err: unknown } | null; transaction: { message: VersionedMessage } }

/**
 * The root a transaction carries, or null: it must have succeeded, be signed by `issuer` (a base58
 * address), and hold a top-level memo (v2) naming that key whose text is the label, then canonical
 * text with exactly `root`, `size` and `time`. The root comes back as 64 hex, as the file's do.
 */
export function rootFromMemo(tx: ReadTransaction | null, issuer: string): Root | null {
  if (!tx || !tx.meta || tx.meta.err !== null) return null
  const message = tx.transaction.message
  const keys = message.staticAccountKeys.map((k) => k.toBase58())
  const signer = keys.indexOf(issuer)
  if (signer < 0 || signer >= message.header.numRequiredSignatures) return null
  for (const ix of message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== MEMO_PROGRAM || !ix.accountKeyIndexes.includes(signer)) continue
    let text: string
    try {
      text = fromUtf8(ix.data)
    } catch {
      continue
    }
    if (!text.startsWith(ROOT_MEMO_LABEL)) continue
    const body = text.slice(ROOT_MEMO_LABEL.length)
    try {
      const value = parseCanonical(body)
      if (canonical(value) !== body) continue
      return checkRoot(value)
    } catch {
      continue
    }
  }
  return null
}

export type ChainRoots = { connection: Pick<Connection, 'getSignaturesForAddress' | 'getTransaction'>; commitment: Finality }

/**
 * Every root each issuer wrote on chain since the last read, oldest first, kept with its
 * transaction's signature. A cursor per issuer (`issuer-chain:<did>`) moves past each transaction
 * read. An issuer that fails is reported; the others are read. Returns how many roots are new here.
 */
export async function readChainRoots(db: Db, chain: ChainRoots, issuers: string[], onError: (err: unknown) => void): Promise<number> {
  let added = 0
  for (const issuer of issuers) {
    const key = publicKeyFromDid(issuer)
    if (!key) continue
    const address = base58.encode(key)
    const source = `issuer-chain:${issuer}`
    try {
      const until = (await getCursor(db, source)) ?? undefined
      // Newest first, a page at a time, back to the cursor; then read oldest first.
      const found: { signature: string; failed: boolean }[] = []
      let before: string | undefined
      for (;;) {
        const page = await chain.connection.getSignaturesForAddress(new PublicKey(address), { until, before, limit: 1000 }, chain.commitment)
        found.push(...page.map((s) => ({ signature: s.signature, failed: s.err !== null })))
        if (page.length < 1000) break
        before = page[page.length - 1]!.signature
      }
      found.reverse()
      for (const { signature, failed } of found) {
        if (!failed) {
          const tx = await chain.connection.getTransaction(signature, { commitment: chain.commitment, maxSupportedTransactionVersion: 0 })
          if (!tx) throw new Error(`transaction ${signature} not served yet`)
          const root = rootFromMemo(tx, address)
          if (root) added += await storeRoots(db, issuer, [root], signature)
        }
        await setCursor(db, source, signature)
      }
    } catch (err) {
      onError(new Error(`the roots of ${issuer} on chain: ${(err as Error).message}`, { cause: err }))
    }
  }
  return added
}
