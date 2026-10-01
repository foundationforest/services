// Issuers' roots, read from the chain. An issuer may write each batch it publishes to Solana too, as
// notes its own key signs (the issuer's README, "Each batch on chain"): each note the root's line
// of the roots file with a run of the batch's new members, so a batch of many members takes several
// notes, each naming the root:
//
//   forest.foundation/issuer/root/v2\n{"commitments":["<decimal>",…],"from":n,"root":"<decimal>","size":n,"time":ms}
//
// or, from the issuer's first version, the root's line alone:
//
//   forest.foundation/issuer/root/v1\n{"root":"<decimal>","size":n,"time":ms}
//
// For each issuer this index trusts, the reader looks up every transaction naming the issuer's key
// (its did:key's public key is its Solana address) since the last one it read, and keeps a root from
// a transaction only when the transaction succeeded, the issuer's key signed it, and a top-level
// instruction to the memo program (v2) names that key and carries exactly one of those texts.
// Anything else naming the key, such as a transfer to it, is passed over. A root found here counts
// as one from the issuer's roots file does; either is enough. The index keeps roots only: the
// members are there for whoever rebuilds the list (the issuer's `listFromNotes`).

import { type Connection, type Finality, PublicKey, type VersionedMessage } from '@solana/web3.js'

import { base58, fromUtf8 } from '../../../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../../../forest/records/src/canonical.ts'
import { publicKeyFromDid } from '../../../forest/records/src/keys.ts'

import { type Db, getCursor, setCursor } from '../db.ts'
import { type Root, checkRoot, storeRoots } from '../issuers.ts'

/** Solana's memo program, v2: it checks that every account it is given signed. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
/** A note with members begins with this. */
export const NOTE_LABEL = 'forest.foundation/issuer/root/v2\n'
/** A root memo from the issuer's first version, the root alone, begins with this. */
export const ROOT_MEMO_LABEL = 'forest.foundation/issuer/root/v1\n'

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

/** The root a memo's text carries, or throws: a v2 note's or a v1 memo's, each exactly its fields. */
function rootFromText(text: string): Root {
  const v2 = text.startsWith(NOTE_LABEL)
  if (!v2 && !text.startsWith(ROOT_MEMO_LABEL)) throw new Error('not a root memo')
  const body = text.slice((v2 ? NOTE_LABEL : ROOT_MEMO_LABEL).length)
  const value = parseCanonical(body)
  if (canonical(value) !== body) throw new Error('not canonical text')
  if (!v2) return checkRoot(value)
  const { commitments, from, ...root } = value as Record<string, unknown>
  if (!Array.isArray(commitments) || commitments.length === 0 || !commitments.every((c) => typeof c === 'string' && DECIMAL.test(c))) throw new Error('no members')
  const checked = checkRoot(root)
  if (!Number.isSafeInteger(from) || (from as number) < 0 || (from as number) + commitments.length > checked.size) throw new Error('members past the root')
  return checked
}

/** What the reader needs of a transaction: whether it failed, and its message. */
export type ReadTransaction = { meta: { err: unknown } | null; transaction: { message: VersionedMessage } }

/**
 * The root a transaction carries, or null: it must have succeeded, be signed by `issuer` (a base58
 * address), and hold a top-level memo (v2) naming that key whose text is a label, then canonical
 * text with exactly that label's fields: `commitments`, `from`, `root`, `size` and `time` for a v2
 * note, `root`, `size` and `time` for a v1 memo. The root comes back as 64 hex, as the file's do.
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
    try {
      return rootFromText(text)
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
