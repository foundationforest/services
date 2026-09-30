// Each root on chain: the memo's text, the transaction the issuer's key signs, and the service
// writing each new root once, through a stand-in Solana RPC that checks every transaction as the
// chain would (the signature over the message, the memo program, the key as the memo's signer).
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

import { base58, fromUtf8 } from '../../forest/records/src/bytes.ts'
import { parseCanonical } from '../../forest/records/src/canonical.ts'

import { MEMO_PROGRAM, ROOT_MEMO_LABEL, memoTransaction, rootMemo } from '../src/chain.ts'
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

/** A legacy transaction with one instruction, taken apart: what the chain would check. */
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
  const [instructions, a] = readCompact(message, m)
  const program = accounts[message[a]!]
  const [n, b] = readCompact(message, a + 1)
  const accountIndexes = [...message.slice(b, b + n)]
  const [len, c] = readCompact(message, b + n)
  const data = fromUtf8(message.slice(c, c + len))
  return { signatures, message, header, accounts, blockhash, instructions, program, accountIndexes, data, rest: message.length - (c + len) }
}

const spki = (publicKey: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' })

test('the memo is the root file’s line, under its own label', () => {
  const memo = rootMemo({ root: 123n, size: 3, time: 1_790_000_000_000 })
  assert.equal(memo, 'forest.foundation/issuer/root/v1\n{"root":"123","size":3,"time":1790000000000}')
  assert.equal(memo.startsWith(ROOT_MEMO_LABEL), true)
})

test('the transaction: one signature by the issuer’s key, the memo program, the key as the memo’s one signer', () => {
  const { json, publicKey } = keypairJson()
  const key = parseKeypair(json, 'test')
  const blockhash = base58.encode(new Uint8Array(32).fill(7))
  const memo = rootMemo({ root: 2n ** 250n, size: 1000, time: 1_790_000_000_000 })
  const tx = decode(memoTransaction(key, memo, blockhash))
  assert.equal(tx.signatures.length, 1)
  assert.equal(verify(null, tx.message, spki(publicKey), tx.signatures[0]!), true, 'the issuer’s key signed the message')
  assert.equal(tx.message[0]! < 0x80, true, 'a legacy message: its first byte is never the roots file’s 0xff')
  assert.deepEqual(tx.header, [1, 0, 1])
  assert.deepEqual(tx.accounts, [base58.encode(publicKey), MEMO_PROGRAM], 'the key pays; the program is read only')
  assert.equal(tx.blockhash, blockhash)
  assert.equal(tx.instructions, 1)
  assert.equal(tx.program, MEMO_PROGRAM)
  assert.deepEqual(tx.accountIndexes, [0], 'the key is the memo’s signer')
  assert.equal(tx.data, memo, 'a memo over 127 bytes keeps its length right')
  assert.equal(tx.rest, 0, 'nothing else')
})

/**
 * A stand-in RPC: blockhashes, sends and statuses. It refuses a transaction whose signature does not
 * verify, and fails the first `failSends` sends as an RPC that does not answer.
 */
async function standInRpc(options: { failSends?: number } = {}) {
  const sent: ReturnType<typeof decode>[] = []
  let failSends = options.failSends ?? 0
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
        if (failSends > 0) {
          failSends--
          return reply({ error: { code: -32005, message: 'node is behind' } })
        }
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

test('each batch’s root goes on chain once, in the order of the roots file, and a restart sends nothing again', async () => {
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
    await joinList()
    await joinList()
    await issuer.batcher.flush()
    await issuer.writer!.idle()
    await issuer.batcher.flush() // nothing waiting: no root, nothing sent
    await issuer.writer!.idle()

    const roots = (parseCanonical(await (await fetch(`${issuer.url}/roots.json`)).text()) as { roots: { root: string; size: number; time: number }[] }).roots
    assert.equal(roots.length, 2)
    assert.deepEqual(
      rpc.sent.map((tx) => tx.data),
      roots.map((r) => ROOT_MEMO_LABEL + `{"root":"${r.root}","size":${r.size},"time":${r.time}}`),
      'one memo per root, each the root file’s own line',
    )
    assert.ok(rpc.sent.every((tx) => tx.accounts[0] === base58.encode(publicKey)), 'each paid and signed by the issuer’s key')
    assert.deepEqual(logs.filter((l) => l.includes('on chain')), ['issuer: 1 root written on chain', 'issuer: 1 root written on chain'], 'counts only')
    assert.equal(issuer.store.unwritten().length, 0)
    await issuer.close()

    const again = await startWith(rpc.url, dbPath, json, logs)
    await again.issuer.writer!.idle()
    assert.equal(rpc.sent.length, 2, 'a restart finds every root written')
    await again.issuer.close()
  } finally {
    await rpc.close()
  }
})

test('a root the RPC does not take is tried again until it is on chain, and never twice', async () => {
  const rpc = await standInRpc({ failSends: 2 })
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const logs: string[] = []
  try {
    const { issuer, join: joinList } = await startWith(rpc.url, join(dir, 'issuer.sqlite'), keypairJson().json, logs)
    await joinList()
    await issuer.batcher.flush()
    for (let i = 0; i < 100 && issuer.store.unwritten().length; i++) await new Promise((r) => setTimeout(r, 20))
    await issuer.writer!.idle()
    assert.equal(issuer.store.unwritten().length, 0, 'written in the end')
    assert.equal(rpc.sent.length, 1, 'once')
    const failures = logs.filter((l) => l.includes('not written'))
    assert.equal(failures.length, 2)
    assert.ok(failures.every((l) => l === 'issuer: a root not written on chain (RpcUnavailable); tried again in 0 s'), 'the kind of failure, never the RPC’s words')
    assert.ok(logs.every((l) => !l.includes(rpc.url) && !l.includes('behind')))
    await issuer.close()
  } finally {
    await rpc.close()
  }
})

test('a file from before roots went on chain gains the column, and its roots are all waiting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-chain-'))
  dirs.push(dir)
  const path = join(dir, 'old.sqlite')
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE roots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL)')
  old.prepare('INSERT INTO roots (size, root, time) VALUES (?, ?, ?)').run(1, new Uint8Array(32).fill(1), 5)
  old.close()
  const store = new Store(path)
  assert.equal(store.unwritten().length, 1)
  store.written(1, 'sig')
  assert.equal(store.unwritten().length, 0)
  store.close()
})
