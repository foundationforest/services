// Each batch on chain: the notes' text, how a batch is cut into notes, the transaction the
// issuer's key signs, the list rebuilt from the notes alone, and the service writing each batch
// once, through a stand-in Solana RPC that checks every transaction as the chain would (the
// signature over the message, the memo program, the key as the memo's signer).
//
//   npm test

import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { base58, fromUtf8, utf8 } from '../../forest/records/src/bytes.ts'
import { parseCanonical } from '../../forest/records/src/canonical.ts'
import { listRoot } from '../../forest/registry/client/src/proof.ts'

import { COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, NOTE_COMPUTE_UNITS, NOTE_LABEL, NOTE_MAX_BYTES, batchNotes, memoTransaction, parseNote } from '../src/chain.ts'
import { listFromNotes } from '../src/list.ts'
import { parseKeypair } from '../src/key.ts'
import { readConfig, startIssuer } from '../src/service.ts'
import { Store } from '../src/store.ts'
import { FakeFaceCheck, WORKFLOW, keypairJson, passed, randomCommitment } from './fakes.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Solana's compact length, read back. */
function readCompact(bytes: Uint8Array, at: number): [number, number] {
  let n = 0
  for (let shift = 0; ; shift += 7) {
    const b = bytes[at++]!
    n |= (b & 0x7f) << shift
    if (!(b & 0x80)) return [n, at]
  }
}

/** A legacy transaction taken apart: what the chain would check. `data` is the last instruction's, as text. */
function decode(wire: Uint8Array) {
  let [sigs, at] = readCompact(wire, 0)
  const signatures = Array.from({ length: sigs }, (_, i) => wire.slice(at + 64 * i, at + 64 * (i + 1)))
  at += 64 * sigs
  const message = wire.slice(at)
  const header = [...message.slice(0, 3)]
  let [keys, m] = readCompact(message, 3)
  const accounts = Array.from({ length: keys }, (_, i) => base58.encode(message.slice(m + 32 * i, m + 32 * (i + 1))))
  m += 32 * keys
  const blockhash = base58.encode(message.slice(m, m + 32))
  m += 32
  const [count, first] = readCompact(message, m)
  const instructions: { program: string; accountIndexes: number[]; bytes: Uint8Array }[] = []
  for (let i = 0, a = first; i < count; i++) {
    const program = accounts[message[a]!]!
    const [n, b] = readCompact(message, a + 1)
    const accountIndexes = [...message.slice(b, b + n)]
    const [len, c] = readCompact(message, b + n)
    instructions.push({ program, accountIndexes, bytes: message.slice(c, c + len) })
    a = c + len
    if (i === count - 1) m = a
  }
  const data = fromUtf8(instructions.at(-1)!.bytes)
  return { signatures, message, header, accounts, blockhash, instructions, data, rest: message.length - m }
}

const spki = (publicKey: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' })

/** BN254's field order less one: the largest a commitment or a root can be, 77 digits. */
const MAX = 21888242871839275222246405745257275088548364400416034343698204186575808495616n

test('a note is the root’s line of the roots file with its run of members, under its own label', () => {
  const notes = batchNotes({ root: 123n, size: 5, time: 1_790_000_000_000 }, 3, [7n, 11n])
  assert.deepEqual(notes, ['forest.foundation/issuer/root/v2\n{"commitments":["7","11"],"from":3,"root":"123","size":5,"time":1790000000000}'])
  assert.equal(notes[0]!.startsWith(NOTE_LABEL), true)
  assert.deepEqual(parseNote(notes[0]!), { root: { root: 123n, size: 5, time: 1_790_000_000_000 }, from: 3, commitments: [7n, 11n] })
  assert.throws(() => batchNotes({ root: 1n, size: 5, time: 0 }, 2, [7n, 11n]), /end at its root/, 'members that do not end at the root’s size')
  assert.throws(() => batchNotes({ root: 1n, size: 0, time: 0 }, 0, []), /end at its root/, 'a batch with no members')
})

test('a batch too long for one note is cut into as few as fit, each reading alone', () => {
  const members = Array.from({ length: 25 }, randomCommitment)
  const root = { root: MAX, size: 1025, time: 1_790_000_000_000 }
  const notes = batchNotes(root, 1000, members)
  assert.equal(notes.length, 3, '25 members of 75 or so digits: about 10 a note')
  const parts = notes.map(parseNote)
  assert.ok(notes.every((n) => utf8(n).length <= NOTE_MAX_BYTES), 'each fits')
  assert.ok(notes.slice(0, -1).every((n) => utf8(n).length > NOTE_MAX_BYTES - 80), 'each but the last is full: one more member would not fit')
  assert.ok(parts.every((p) => p.root.root === root.root && p.root.size === root.size && p.root.time === root.time), 'each carries the root’s line')
  assert.deepEqual(parts.map((p) => p.from), [1000, 1000 + parts[0]!.commitments.length, 1000 + parts[0]!.commitments.length + parts[1]!.commitments.length])
  assert.deepEqual(parts.flatMap((p) => p.commitments), members, 'together, the batch in order')
})

test('the transaction: one signature by the issuer’s key, a compute limit, the memo program with the key as its one signer, within Solana’s 1,232 bytes', () => {
  const { json, publicKey } = keypairJson()
  const key = parseKeypair(json, 'test')
  const blockhash = base58.encode(new Uint8Array(32).fill(7))
  // The fullest note there can be: every number at its longest.
  const fullest = batchNotes({ root: MAX, size: 2 ** 32, time: 9_999_999_999_999 }, 2 ** 32 - 30, Array(30).fill(MAX))[0]!
  const wire = memoTransaction(key, fullest, blockhash)
  assert.ok(wire.length <= 1232, `${wire.length} bytes`)
  assert.equal(memoTransaction(key, 'x'.repeat(NOTE_MAX_BYTES), blockhash).length, 1232, 'a note of NOTE_MAX_BYTES makes a transaction of exactly 1,232 bytes')
  const tx = decode(wire)
  assert.equal(tx.signatures.length, 1)
  assert.equal(verify(null, tx.message, spki(publicKey), tx.signatures[0]!), true, 'the issuer’s key signed the message')
  assert.equal(tx.message[0]! < 0x80, true, 'a legacy message: its first byte is never the roots file’s 0xff')
  assert.deepEqual(tx.header, [1, 0, 2])
  assert.deepEqual(tx.accounts, [base58.encode(publicKey), MEMO_PROGRAM, COMPUTE_BUDGET_PROGRAM], 'the key pays; the programs are read only')
  assert.equal(tx.blockhash, blockhash)
  assert.equal(tx.instructions.length, 2)
  const [limit, memo] = tx.instructions
  assert.equal(limit!.program, COMPUTE_BUDGET_PROGRAM)
  assert.deepEqual(limit!.accountIndexes, [])
  assert.deepEqual([...limit!.bytes], [2, ...new Uint8Array(new Uint32Array([NOTE_COMPUTE_UNITS]).buffer)], 'SetComputeUnitLimit, and no price')
  assert.equal(memo!.program, MEMO_PROGRAM)
  assert.deepEqual(memo!.accountIndexes, [0], 'the key is the memo’s signer')
  assert.equal(tx.data, fullest, 'a memo over 127 bytes keeps its length right')
  assert.equal(tx.rest, 0, 'nothing else')
})

test('the list rebuilt from notes: a note seen twice is kept once; a gap, a disagreement or a wrong root is refused', () => {
  const list = Array.from({ length: 14 }, randomCommitment)
  const r1 = { root: listRoot(list.slice(0, 2)), size: 2, time: 1 }
  const r2 = { root: listRoot(list), size: 14, time: 2 }
  const notes = [...batchNotes(r1, 0, list.slice(0, 2)), ...batchNotes(r2, 2, list.slice(2))]
  assert.equal(notes.length, 3)
  assert.deepEqual(listFromNotes(notes), { list, roots: [r1, r2] })
  assert.deepEqual(listFromNotes([notes[2]!, notes[0]!, notes[1]!, notes[0]!]), { list, roots: [r1, r2] }, 'in any order, a duplicate once')
  assert.throws(() => listFromNotes([notes[0]!, notes[2]!]), /no member at position 2/, 'a note missing')
  assert.throws(() => listFromNotes([notes[1]!, notes[2]!]), /no member at position 0/, 'the first batch missing')
  const swapped = batchNotes(r1, 0, [list[1]!, list[0]!])
  assert.throws(() => listFromNotes([...notes, ...swapped]), /two members at position 0/)
  assert.throws(() => listFromNotes(batchNotes({ ...r1, root: r1.root + 1n }, 0, list.slice(0, 2))), /not its members' root/)
  assert.throws(() => listFromNotes([...notes, ...batchNotes({ ...r1, time: 9 }, 0, list.slice(0, 2))]), /two roots for size 2/)
  assert.throws(() => listFromNotes([notes[0]!.replace('root/v2', 'root/v1')]), /not a note/)
  assert.throws(() => listFromNotes([notes[0]!.replace('"from":0', '"from":1')]), /run past its root/)
  assert.throws(() => listFromNotes([notes[0]!.replace('"from":0', '"extra":1,"from":0')]), /not a note/)
})

/**
 * A stand-in RPC: blockhashes, sends and statuses. It refuses a transaction whose signature does not
 * verify, and fails the sends counted in `failSends` (0 for the first) as an RPC that does not answer.
 */
async function standInRpc(options: { failSends?: number[] } = {}) {
  const sent: ReturnType<typeof decode>[] = []
  let sends = 0
  let height = 100
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const { method, params } = JSON.parse(raw) as { method: string; params: any[] }
      const reply = (body: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }))
      if (method === 'getLatestBlockhash') return reply({ result: { value: { blockhash: base58.encode(new Uint8Array(32).fill(height % 255)), lastValidBlockHeight: height + 150 } } })
      if (method === 'getBlockHeight') return reply({ result: ++height })
      if (method === 'sendTransaction') {
        if (options.failSends?.includes(sends++)) return reply({ error: { code: -32005, message: 'node is behind' } })
        const tx = decode(Buffer.from(params[0], 'base64'))
        const payer = base58.decode(tx.accounts[0]!)
        if (!verify(null, tx.message, spki(payer), tx.signatures[0]!)) return reply({ error: { code: -32003, message: 'signature verification failure' } })
        sent.push(tx)
        return reply({ result: base58.encode(tx.signatures[0]!) })
      }
      if (method === 'getSignatureStatuses') return reply({ result: { value: [{ err: null, confirmationStatus: 'confirmed' }] } })
      reply({ error: { code: -32601, message: 'no such method' } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, sent, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function startWith(rpcUrl: string, dbPath: string, key: string, logs: string[]) {
  const faces = new FakeFaceCheck()
  const config = readConfig({
    DIDIT_API_KEY: 'not-used',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    ISSUER_KEYPAIR: key,
    DATABASE_PATH: dbPath,
    BATCH_MAX: '1000',
    BATCH_INTERVAL_SECONDS: '3600',
    SESSION_LIMIT_PER_HOUR: '100000',
    SOLANA_RPC_URL: rpcUrl,
    PORT: '0',
  })
  const issuer = await startIssuer(config, { faceCheck: faces, log: (line) => logs.push(line), chain: { retryMs: 50, sleep: async () => {} } })
  const join = async () => {
    const created = (await (await fetch(`${issuer.url}/session`, { method: 'POST' })).json()) as { sessionId: string }
    faces.set(created.sessionId, passed())
    const commitment = randomCommitment()
    const res = await fetch(`${issuer.url}/submit`, { method: 'POST', body: JSON.stringify({ sessionId: created.sessionId, commitment: commitment.toString() }) })
    assert.equal(res.status, 202)
  }
  return { issuer, join }
}

type Files = { list: bigint[]; roots: { root: bigint; size: number; time: number }[] }

/** The issuer's two files, as a reader gets them. */
async function files(url: string): Promise<Files> {
  const list = (parseCanonical(await (await fetch(`${url}/list.json`)).text()) as { commitments: string[] }).commitments.map(BigInt)
  const roots = (parseCanonical(await (await fetch(`${url}/roots.json`)).text()) as { roots: { root: string; size: number; time: number }[] }).roots
  return { list, roots: roots.map((r) => ({ ...r, root: BigInt(r.root) })) }
}

/** Every note each batch should have written, in the order of the roots file. */
const expectedNotes = ({ list, roots }: Files) => roots.flatMap((r, i) => batchNotes(r, roots[i - 1]?.size ?? 0, list.slice(roots[i - 1]?.size ?? 0, r.size)))

test('each batch goes on chain once, its notes in order, and a restart sends nothing again', async () => {
  const rpc = await standInRpc()
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const dbPath = join(dir, 'issuer.sqlite')
  const { json, publicKey } = keypairJson()
  const logs: string[] = []
  try {
    const { issuer, join: joinList } = await startWith(rpc.url, dbPath, json, logs)
    await joinList()
    await issuer.batcher.flush()
    await issuer.writer!.idle()
    for (let i = 0; i < 12; i++) await joinList()
    await issuer.batcher.flush()
    await issuer.writer!.idle()
    await issuer.batcher.flush() // nothing waiting: no root, nothing sent
    await issuer.writer!.idle()

    const written = await files(issuer.url)
    assert.equal(written.roots.length, 2)
    assert.deepEqual(rpc.sent.map((tx) => tx.data), expectedNotes(written), 'the notes of each batch, oldest first, each the root file’s own line with its members')
    assert.equal(rpc.sent.length, 3, 'one note for a batch of 1, two for a batch of 12')
    assert.ok(rpc.sent.every((tx) => tx.accounts[0] === base58.encode(publicKey)), 'each paid and signed by the issuer’s key')
    assert.deepEqual(
      logs.filter((l) => l.includes('on chain')),
      ['issuer: 1 note written on chain, 1 root complete', 'issuer: 2 notes written on chain, 1 root complete'],
      'counts only',
    )
    assert.equal(issuer.store.unwritten().length, 0)
    await issuer.close()

    const again = await startWith(rpc.url, dbPath, json, logs)
    await again.issuer.writer!.idle()
    assert.equal(rpc.sent.length, 3, 'a restart finds every batch written')
    await again.issuer.close()
  } finally {
    await rpc.close()
  }
})

test('the list rebuilt from the notes on chain alone gives the same list and the same roots', async () => {
  const rpc = await standInRpc()
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const logs: string[] = []
  try {
    const { issuer, join: joinList } = await startWith(rpc.url, join(dir, 'issuer.sqlite'), keypairJson().json, logs)
    for (const size of [1, 25, 2]) {
      for (let i = 0; i < size; i++) await joinList()
      await issuer.batcher.flush()
      await issuer.writer!.idle()
    }
    const published = await files(issuer.url)
    assert.equal(published.list.length, 28)
    assert.ok(rpc.sent.length >= 5, 'the batch of 25 took several notes')

    const rebuilt = listFromNotes(rpc.sent.map((tx) => tx.data))
    assert.deepEqual(rebuilt.list, published.list, 'list.json, from the chain alone')
    assert.deepEqual(rebuilt.roots, published.roots, 'every root in roots.json, sizes and times included')
    for (const r of published.roots) assert.equal(listRoot(rebuilt.list.slice(0, r.size)), r.root, `forest's listRoot of the rebuilt list's first ${r.size} is the root`)
    await issuer.close()
  } finally {
    await rpc.close()
  }
})

test('a note the RPC does not take is tried again from that note on, and none is sent twice', async () => {
  const rpc = await standInRpc({ failSends: [1, 2] })
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const logs: string[] = []
  try {
    const { issuer, join: joinList } = await startWith(rpc.url, join(dir, 'issuer.sqlite'), keypairJson().json, logs)
    for (let i = 0; i < 25; i++) await joinList()
    await issuer.batcher.flush()
    for (let i = 0; i < 100 && issuer.store.unwritten().length; i++) await new Promise((r) => setTimeout(r, 20))
    await issuer.writer!.idle()
    assert.equal(issuer.store.unwritten().length, 0, 'written in the end')
    assert.deepEqual(rpc.sent.map((tx) => tx.data), expectedNotes(await files(issuer.url)), 'each note once, in order: the first was not sent again')
    const failures = logs.filter((l) => l.includes('not written'))
    assert.equal(failures.length, 2)
    assert.ok(failures.every((l) => l === 'issuer: a note not written on chain (RpcUnavailable); tried again in 0 s'), 'the kind of failure, never the RPC’s words')
    assert.ok(logs.every((l) => !l.includes(rpc.url) && !l.includes('behind')))
    await issuer.close()
  } finally {
    await rpc.close()
  }
})

test('a file from before the notes carried members writes every batch again, with its members', async () => {
  const rpc = await standInRpc()
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const dbPath = join(dir, 'issuer.sqlite')
  const { json } = keypairJson()
  const logs: string[] = []
  try {
    // A list of two batches, its roots on chain alone, as the earlier version kept them: `chain`.
    const plain = await startIssuer(readConfig({ DIDIT_API_KEY: 'x', DIDIT_WORKFLOW_ID: WORKFLOW, ISSUER_KEYPAIR: json, DATABASE_PATH: dbPath, PORT: '0' }), { faceCheck: new FakeFaceCheck(), log: () => {} })
    plain.list.append([randomCommitment(), randomCommitment()], [], 1)
    plain.list.append([randomCommitment()], [], 2)
    await plain.close()
    const old = new DatabaseSync(dbPath)
    old.exec("ALTER TABLE roots RENAME COLUMN notes TO chain; UPDATE roots SET chain = 'a v1 memo'")
    old.close()

    const { issuer } = await startWith(rpc.url, dbPath, json, logs)
    await issuer.writer!.idle()
    const columns = new DatabaseSync(dbPath).prepare('SELECT name FROM pragma_table_info(?)').all('roots').map((c) => c.name)
    assert.deepEqual(columns, ['size', 'root', 'time', 'notes'], '`chain` gone, `notes` in its place')
    const published = await files(issuer.url)
    assert.deepEqual(rpc.sent.map((tx) => tx.data), expectedNotes(published), 'both batches, with their members')
    assert.deepEqual(listFromNotes(rpc.sent.map((tx) => tx.data)).list, published.list)
    await issuer.close()
  } finally {
    await rpc.close()
  }
})

test('a file from before anything went on chain gains the column, and its batches are all waiting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const path = join(dir, 'old.sqlite')
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE roots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL)')
  old.prepare('INSERT INTO roots (size, root, time) VALUES (?, ?, ?)').run(1, new Uint8Array(32).fill(1), 5)
  old.prepare('INSERT INTO roots (size, root, time) VALUES (?, ?, ?)').run(3, new Uint8Array(32).fill(2), 6)
  old.close()
  const store = new Store(path)
  assert.deepEqual(store.unwritten().map((r) => [r.from, r.size]), [[0, 1], [1, 3]], 'each with where its batch starts')
  store.written(1, ['sig1', 'sig2'])
  assert.deepEqual(store.unwritten().map((r) => r.size), [3])
  store.close()
})
