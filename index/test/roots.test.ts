// Issuers' roots on chain: which transactions the reader takes a root from, the issuer's own
// transaction read back as the index reads it, and the reader on Postgres with a stand-in RPC.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test test/roots.test.ts

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'

import { hex } from '../../forest/records/src/bytes.ts'
import { canonical } from '../../forest/records/src/canonical.ts'
import { didFromPublicKey } from '../../forest/records/src/keys.ts'
import { toBytes32 } from '../../forest/registry/client/src/field.ts'
import { batchNotes, memoTransaction } from '../../issuer/src/chain.ts'
import { parseKeypair } from '../../issuer/src/key.ts'

import { MEMO_PROGRAM, type ReadTransaction, readChainRoots, rootFromMemo } from '../src/chain/roots.ts'
import { type Db, createPool, getCursor, migrate } from '../src/db.ts'
import { storeRoots } from '../src/issuers.ts'

const MEMO = new PublicKey(MEMO_PROGRAM)
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58()
const issuer = Keypair.generate()
const other = Keypair.generate()
const ROOT = 21888242871839275222246405745257275088548364400416034343698204186575808495616n
const memo = (text: string, signer = issuer.publicKey, isSigner = true) =>
  new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: signer, isSigner, isWritable: false }], data: Buffer.from(text) })
/** A root memo as the issuer's first version wrote it: the root's line alone. */
const v1 = (r: { root: bigint; size: number; time: number }) => 'forest.foundation/issuer/root/v1\n' + canonical({ root: r.root.toString(), size: r.size, time: r.time })
const good = v1({ root: ROOT, size: 3, time: 1_790_000_000_000 })
/** The issuer's notes for a batch of 25 at positions 3 to 27: three notes, each naming the root. */
const batch = batchNotes({ root: ROOT, size: 28, time: 1_790_000_000_000 }, 3, Array.from({ length: 25 }, (_, i) => ROOT - BigInt(i)))

/** A transaction as `getTransaction` serves it: legacy or v0, succeeded unless `err`. */
function served(instructions: TransactionInstruction[], opts: { payer?: PublicKey; v0?: boolean; err?: unknown } = {}): ReadTransaction {
  const payer = opts.payer ?? issuer.publicKey
  const message = opts.v0
    ? new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message()
    : new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(...instructions).compileMessage()
  return { meta: { err: opts.err ?? null }, transaction: { message } }
}

const expected = { root: hex.encode(toBytes32(ROOT)), size: 3, time: 1_790_000_000_000 }
const address = issuer.publicKey.toBase58()

test('a root is taken from a v1 memo the issuer signed, legacy or v0, and from nothing else', () => {
  assert.deepEqual(rootFromMemo(served([memo(good)]), address), expected)
  assert.deepEqual(rootFromMemo(served([memo(good)], { v0: true }), address), expected)
  assert.deepEqual(rootFromMemo(served([memo(good)], { payer: other.publicKey }), address), expected, 'someone else may pay, if the key signs the memo')

  assert.equal(rootFromMemo(served([memo(good)], { err: { InstructionError: [0, 'x'] } }), address), null, 'a failed transaction')
  assert.equal(rootFromMemo(null, address), null, 'none served')
  assert.equal(rootFromMemo(served([memo(good, issuer.publicKey, false)], { payer: other.publicKey }), address), null, 'the key named, not signing')
  assert.equal(rootFromMemo(served([memo(good, other.publicKey)], { payer: other.publicKey }), address), null, 'another key’s memo')
  assert.equal(rootFromMemo(served([memo(good)]), other.publicKey.toBase58()), null, 'read for another issuer')
  const notMemo = new TransactionInstruction({ programId: other.publicKey, keys: [{ pubkey: issuer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(good) })
  assert.equal(rootFromMemo(served([notMemo]), address), null, 'another program')
  for (const text of [
    good.replace('root/v1', 'root/v2'),
    good.replace('\n', ' '),
    good.replace('{"root"', '{ "root"'),
    good.replace('"time"', '"extra":1,"time"'),
    good.replace('"size":3', '"size":-3'),
    good.replace(`"${ROOT}"`, String(ROOT)),
    'forest.foundation/issuer/root/v1\n{"root":"12","size":1}',
  ]) {
    assert.equal(rootFromMemo(served([memo(text)]), address), null, text)
  }
  assert.deepEqual(rootFromMemo(served([memo('hello'), memo(good)]), address), expected, 'the root memo among others')
})

test('a root is taken from each of the issuer’s notes with members, and from no malformed one', () => {
  assert.equal(batch.length, 3)
  for (const note of batch) assert.deepEqual(rootFromMemo(served([memo(note)]), address), { ...expected, size: 28 }, 'every note of a batch names its root')
  const one = batch[2]!
  for (const text of [
    one.replace('root/v2', 'root/v3'),
    one.replace('"commitments":[', '"commitments":[1,'),
    one.replace(/"commitments":\[[^\]]*\]/, '"commitments":[]'),
    one.replace(/"from":\d+/, '"from":27'),
    one.replace(/"from":\d+/, '"from":-1'),
    one.replace('"from"', '"extra":1,"from"'),
    one.replace(/"from":\d+,/, ''),
  ]) {
    assert.equal(rootFromMemo(served([memo(text)]), address), null, text.slice(0, 80))
  }
})

test('the issuer’s own transaction, read back as the index reads it', () => {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const secret = Buffer.from(jwk.d!, 'base64url')
  const publicKey = Buffer.from(jwk.x!, 'base64url')
  const key = parseKeypair(JSON.stringify([...secret, ...publicKey]), 'test')
  for (const note of batch) {
    const tx = VersionedTransaction.deserialize(memoTransaction(key, note, BLOCKHASH))
    assert.equal(tx.signatures.length, 1)
    assert.deepEqual(rootFromMemo({ meta: { err: null }, transaction: { message: tx.message } }, new PublicKey(publicKey).toBase58()), { ...expected, size: 28 })
  }
})

// ---- The reader, on Postgres, with a stand-in RPC ----

let admin: pg.Client | undefined
let db: Db | undefined
let name = ''
before(async () => {
  if (!process.env.DATABASE_URL) return
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await admin.connect()
  name = `forest_index_roots_${randomBytes(4).toString('hex')}`
  await admin.query(`create database ${name}`)
  const url = new URL(process.env.DATABASE_URL)
  url.pathname = `/${name}`
  db = createPool(url.toString())
  await migrate(db)
})
after(async () => {
  await db?.end()
  if (admin) {
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  }
})

test('the reader keeps each root once with its transaction, moves its cursor, and never reads a transaction twice', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is not set' }, async () => {
  const did = didFromPublicKey(issuer.publicKey.toBytes())
  const notes = batchNotes({ root: 7n, size: 23, time: 1_790_000_060_000 }, 3, Array.from({ length: 20 }, (_, i) => ROOT - BigInt(i)))
  assert.equal(notes.length, 2)
  const [secondRoot, alsoSecondRoot] = notes
  const history: Array<{ signature: string; err: unknown; tx: ReadTransaction | null }> = [
    { signature: 'sig-transfer-in', err: null, tx: served([SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: issuer.publicKey, lamports: 1 })], { payer: other.publicKey }) },
    { signature: 'sig-root-1', err: null, tx: served([memo(good)]) },
    { signature: 'sig-failed', err: { InstructionError: [0, 'x'] }, tx: null },
  ]
  const asked: string[] = []
  const connection = {
    async getSignaturesForAddress(key: PublicKey, opts?: { until?: string; before?: string; limit?: number }) {
      assert.equal(key.toBase58(), address, 'read at the issuer’s own address')
      const newestFirst = [...history].reverse()
      const stop = opts?.until ? newestFirst.findIndex((h) => h.signature === opts.until) : -1
      return (stop < 0 ? newestFirst : newestFirst.slice(0, stop)).map((h) => ({ signature: h.signature, err: h.err, slot: 1, blockTime: null, memo: null }))
    },
    async getTransaction(signature: string) {
      asked.push(signature)
      return history.find((h) => h.signature === signature)!.tx
    },
  }
  const errors: unknown[] = []
  const chain = { connection: connection as never, commitment: 'finalized' as const }

  // The file had the first root already: the chain adds its transaction, and counts as a change.
  await storeRoots(db!, did, [expected])
  assert.equal(await readChainRoots(db!, chain, [did], (e) => errors.push(e)), 1)
  assert.deepEqual(errors as unknown[], [])
  assert.deepEqual(asked, ['sig-transfer-in', 'sig-root-1'], 'a failed transaction is not fetched')
  assert.equal(await getCursor(db!, `issuer-chain:${did}`), 'sig-failed')

  // A batch of twenty: two notes, each naming its root, kept once with the first note's transaction.
  history.push({ signature: 'sig-root-2', err: null, tx: served([memo(secondRoot!)]) }, { signature: 'sig-root-2b', err: null, tx: served([memo(alsoSecondRoot!)]) })
  assert.equal(await readChainRoots(db!, chain, [did], (e) => errors.push(e)), 1)
  assert.deepEqual(asked, ['sig-transfer-in', 'sig-root-1', 'sig-root-2', 'sig-root-2b'], 'only what is new')
  assert.equal(await readChainRoots(db!, chain, [did], (e) => errors.push(e)), 0)

  // The file read again later changes nothing the chain recorded.
  assert.equal(await storeRoots(db!, did, [expected, { root: hex.encode(toBytes32(7n)), size: 23, time: 1_790_000_060_000 }]), 0)
  const { rows } = await db!.query('select root, size, signature from issuer_roots where issuer = $1 order by size', [did])
  assert.deepEqual(rows, [
    { root: expected.root, size: 3, signature: 'sig-root-1' },
    { root: hex.encode(toBytes32(7n)), size: 23, signature: 'sig-root-2' },
  ])
})
