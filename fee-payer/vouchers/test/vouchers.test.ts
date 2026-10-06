// The voucher check on loopback, the fee payer's front, in front of two stand-in Koras that record
// what reaches them: the free one, behind the voucher door, and the at-cost one, which gets every
// other request. Real vouchers: proofs from a stamp on a test issuer's list, made with forest's
// proveStamp, checked with its verifyStamp. Each refusal is provoked once, and nothing refused ever
// reaches either Kora.
//
//   npm test
//
// Needs the registry's proving files (`npm run fetch` in forest/registry/artifacts) and its client's
// dependencies (`../../forest.sh registry/client registry/artifacts`). If either is missing the test
// says which and skips.

import assert from 'node:assert/strict'
import { createPrivateKey, randomBytes, sign as edSign } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'

import { listRoot, proveStamp, refundIx, registerIx, stampOf, toBytes32 } from '../../../forest/registry/client/src/index.ts'

import { readConfig, startFront, type Config } from '../src/vouchers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const forest = join(here, '../../../forest')
const artifacts = { wasm: join(forest, 'registry/artifacts/semaphore-32.wasm'), zkey: join(forest, 'registry/artifacts/semaphore-32.zkey') }
const REGISTRY = new PublicKey('5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC')
const API_KEY = randomBytes(16).toString('hex')

function missing(): string | null {
  if (!existsSync(join(forest, 'registry/client/node_modules'))) return 'run `npm ci` in forest/registry/client'
  if (!existsSync(artifacts.zkey)) return 'no proving files; run `npm run fetch` in forest/registry/artifacts'
  return null
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
function signRoot(key: Keypair, root: bigint): Uint8Array {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), key.secretKey.subarray(0, 32)])
  return new Uint8Array(edSign(null, toBytes32(root), createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })))
}

// The foundation's issuer's two lists, as far as this test goes: the face list, whose stamps earn
// three vouchers, and the ID list, signed by its own key, whose stamps earn ten. One person has a
// stamp on each among others, from a secret per list.
function list() {
  const key = Keypair.generate()
  const secret = new Uint8Array(randomBytes(32))
  const stamps = [stampOf(new Uint8Array(randomBytes(32))), stampOf(secret), stampOf(new Uint8Array(randomBytes(32)))]
  const root = listRoot(stamps)
  return { key, secret, stamps, root, signature: signRoot(key, root) }
}
const face = list()
const id = list()
const { key: issuer, root, signature: issuerSignature } = face
const feePayer = Keypair.generate()
const alice = Keypair.generate()
const bob = Keypair.generate()

type VoucherJson = { proof: unknown; root: string; issuerSignature: string; label: string; marketStamp: string }
async function voucherFor(profile: Keypair, label: string, from = face): Promise<VoucherJson> {
  const p = await proveStamp({ secret: from.secret, label, profile: profile.publicKey.toBytes(), stamps: from.stamps, artifacts })
  return { proof: p.raw, root: hex(toBytes32(p.root)), issuerSignature: hex(from.signature), label, marketStamp: hex(toBytes32(p.marketStamp)) }
}

/** A `register` for this main key, as an app sends it. The row's own proof is the program's to check, not the voucher check's. */
function register(profile: Keypair, programId = REGISTRY): TransactionInstruction {
  return registerIx({
    profile: profile.publicKey as never,
    label: 'tutoring/seller',
    marketStamp: new Uint8Array(randomBytes(32)),
    issuer: issuer.publicKey.toBytes(),
    root,
    issuerSignature,
    proof: { a: new Uint8Array(32), b: new Uint8Array(64), c: new Uint8Array(32) },
    payer: feePayer.publicKey as never,
    programId: programId as never,
  }) as never
}

function transaction(instructions: TransactionInstruction[], signers: Keypair[], tables: AddressLookupTableAccount[] = []): string {
  const message = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: new PublicKey(randomBytes(32)).toBase58(), instructions }).compileToV0Message(tables)
  const tx = new VersionedTransaction(message)
  tx.sign(signers)
  return b64(tx.serialize())
}

// The stand-in free Kora: it records each call, checks the key, and answers as `mode` says.
let mode: 'sign' | 'refuse' = 'sign'
const calls: { apiKey: string | undefined; body: any }[] = []
const kora = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ apiKey: req.headers['x-api-key'] as string | undefined, body })
    const answer =
      mode === 'sign'
        ? { jsonrpc: '2.0', id: body.id, result: { signature: 'stand-in-signature', signed_transaction: body.params.transaction } }
        : { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Invalid transaction: stand-in refusal' } }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
  })
})

// The stand-in at-cost Kora: it records each request as it arrived, and answers with a status, a
// header and a body of its own, so the test can see both pass through unchanged.
const atCostCalls: { method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }[] = []
const atCost = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    atCostCalls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(req.url === '/liveness' ? 200 : 207, { 'content-type': 'application/json', 'x-stand-in': 'at-cost' }).end(JSON.stringify({ answered: req.url }))
  })
})

let dir: string
let config: Config
let service: { url: string; close: () => Promise<void> } | undefined
const vouchers: Record<string, VoucherJson> = {}

before(
  async () => {
    if (missing()) return
    await new Promise<void>((resolve) => kora.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => atCost.listen(0, '127.0.0.1', resolve))
    dir = mkdtempSync(join(tmpdir(), 'forest-vouchers-'))
    config = {
      freeKoraUrl: `http://127.0.0.1:${(kora.address() as AddressInfo).port}`,
      freeKoraApiKey: API_KEY,
      atCostKoraUrl: `http://127.0.0.1:${(atCost.address() as AddressInfo).port}`,
      issuers: [
        { issuer: face.key.publicKey.toBytes(), vouchers: 3 },
        { issuer: id.key.publicKey.toBytes(), vouchers: 10 },
      ],
      registry: REGISTRY,
      databasePath: join(dir, 'data/vouchers.sqlite'),
      port: 0,
    }
    service = await startFront(config)
    vouchers.one = await voucherFor(alice, 'sponsor/1')
    vouchers.two = await voucherFor(alice, 'sponsor/2')
    vouchers.idOne = await voucherFor(alice, 'sponsor/1', id)
    vouchers.idTen = await voucherFor(alice, 'sponsor/10', id)
  },
  { timeout: 120_000 },
)

after(async () => {
  await service?.close()
  kora.close()
  atCost.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service!.url}/vouchers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

/** A refusal: the named error, and nothing reaches either Kora. */
async function refused(body: unknown, error: string, status = 400): Promise<void> {
  const before = [calls.length, atCostCalls.length]
  const answer = await post(body)
  assert.deepEqual([answer.status, answer.body.error], [status, error], JSON.stringify(answer.body))
  assert.deepEqual([calls.length, atCostCalls.length], before, `${error}: nothing reached either Kora`)
}

test('the voucher door lets through one registry row per voucher, and refuses everything else by name', { timeout: 120_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  const one = vouchers.one!
  const good = transaction([register(alice)], [alice])

  // The request's shape.
  await refused('not json', 'bad_request')
  await refused({ transaction: good }, 'bad_request')
  await refused({ transaction: good, voucher: { ...one, root: 'zz' } }, 'bad_request')
  await refused({ transaction: good, voucher: { ...one, proof: null } }, 'bad_request')

  // The transaction decodes, whole.
  await refused({ transaction: 'not a transaction', voucher: one }, 'bad_transaction')
  await refused({ transaction: b64(randomBytes(300)), voucher: one }, 'bad_transaction')
  await refused({ transaction: b64(Buffer.concat([Buffer.from(good, 'base64'), Buffer.from([0])])), voucher: one }, 'bad_transaction')

  // One `register` and nothing else.
  const memo = { programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('hi') } as unknown as TransactionInstruction
  const seeded = await PublicKey.createWithSeed(alice.publicKey, 'take', SystemProgram.programId)
  const notOne: [string, string][] = [
    ['no register', transaction([SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: bob.publicKey, lamports: 1 })], [alice])],
    ['another instruction beside it', transaction([register(alice), memo], [alice])],
    ['two registers', transaction([register(alice), register(alice)], [alice])],
    ['another program', transaction([register(alice, Keypair.generate().publicKey)], [alice])],
    ["the registry's other instruction", transaction([refundIx({ row: bob.publicKey as never, payer: feePayer.publicKey as never, programId: REGISTRY as never }) as never], [])],
    // What Kora alone signs (fee-payer/README.md, FAQ): the fee payer's SOL into an account the main key can empty.
    ['a top-level System instruction', transaction([register(alice), SystemProgram.createAccountWithSeed({ fromPubkey: feePayer.publicKey, newAccountPubkey: seeded, basePubkey: alice.publicKey, seed: 'take', lamports: 660_000, space: 0, programId: SystemProgram.programId })], [alice])],
  ]
  const ix = register(alice)
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(ix.keys[0]!.pubkey.toBase58())] } })
  notOne.push(['an address lookup table', transaction([ix], [alice], [table])])
  for (const [what, tx] of notOne) {
    await t.test(what, () => refused({ transaction: tx, voucher: one }, 'not_one_registration'))
  }

  // Signed by the main key the row is for.
  const unsigned = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: new PublicKey(randomBytes(32)).toBase58(), instructions: [register(alice)] }).compileToV0Message())
  await refused({ transaction: b64(unsigned.serialize()), voucher: one }, 'not_signed_by_main_key')
  const forged = VersionedTransaction.deserialize(Buffer.from(good, 'base64'))
  forged.signatures[forged.message.staticAccountKeys.findIndex((k) => k.equals(alice.publicKey))] = new Uint8Array(randomBytes(64))
  await refused({ transaction: b64(forged.serialize()), voucher: one }, 'not_signed_by_main_key')

  // The voucher: its issuer, its label on that issuer's list, its proof.
  await refused({ transaction: good, voucher: { ...one, issuerSignature: hex(signRoot(Keypair.generate(), root)) } }, 'not_signed_by_issuer')
  await refused({ transaction: good, voucher: { ...one, label: 'sponsor/4' } }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: { ...one, label: 'sponsor/10' } }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: { ...one, label: 'sponsor/0' } }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: { ...one, label: 'sponsor/01' } }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: { ...one, label: 'tutoring/seller' } }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: { ...vouchers.idTen!, label: 'sponsor/11' } }, 'not_a_voucher_label')
  const otherStamp = Buffer.from(one.marketStamp, 'hex')
  otherStamp[31] ^= 1
  await refused({ transaction: good, voucher: { ...one, marketStamp: otherStamp.toString('hex') } }, 'voucher_does_not_hold')
  // A voucher seen in flight, sent with another main key's row: its proof names Alice.
  await refused({ transaction: transaction([register(bob)], [bob]), voucher: one }, 'voucher_does_not_hold')

  // The voucher holds: forwarded to Kora unchanged, with the key, and answered with the signature.
  const answer = await post({ transaction: good, voucher: one })
  assert.deepEqual(answer, { status: 200, body: { signature: 'stand-in-signature' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.apiKey, API_KEY, "with the key Kora asks for")
  assert.equal(calls[0]!.body.method, 'signAndSendTransaction')
  assert.equal(calls[0]!.body.params.transaction, good, 'the transaction exactly as it came')

  // Spent: the same voucher again, even on a new transaction, is refused.
  await refused({ transaction: good, voucher: one }, 'voucher_used', 409)
  await refused({ transaction: transaction([register(alice)], [alice]), voucher: one }, 'voucher_used', 409)

  // The ID list's vouchers: ten per stamp, each its own, `sponsor/1` apart from the face list's.
  for (const voucher of [vouchers.idOne!, vouchers.idTen!]) {
    assert.deepEqual(await post({ transaction: transaction([register(alice)], [alice]), voucher }), { status: 200, body: { signature: 'stand-in-signature' } })
    await refused({ transaction: transaction([register(alice)], [alice]), voucher }, 'voucher_used', 409)
  }
  assert.equal(calls.length, 3)

  // Kora refuses: the voucher was spent when it was forwarded.
  mode = 'refuse'
  const two = await post({ transaction: transaction([register(alice)], [alice]), voucher: vouchers.two })
  assert.deepEqual([two.status, two.body.error], [502, 'fee_payer_refused'])
  assert.match(two.body.detail, /stand-in refusal/)
  assert.equal(calls.length, 4)
  mode = 'sign'
  await refused({ transaction: transaction([register(alice)], [alice]), voucher: vouchers.two }, 'voucher_used', 409)

  // The used set is on disk: a restart keeps it.
  await service!.close()
  service = await startFront(config)
  await refused({ transaction: good, voucher: one }, 'voucher_used', 409)

  // Browsers ask first; the voucher door answers nothing but POST.
  const preflight = await fetch(`${service.url}/vouchers`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.equal((await fetch(`${service.url}/vouchers`)).status, 405)
  assert.equal(atCostCalls.length, 0, 'nothing at /vouchers reached the at-cost Kora')
})

test('the at-cost door: every other request goes to the at-cost Kora, and its answer comes back, both unchanged', async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  const free = calls.length

  // Kora's JSON-RPC, as an app calls it.
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'getPayerSigner', params: {} })
  const res = await fetch(`${service!.url}/?a=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-app': 'forest' }, body: rpc })
  assert.equal(res.status, 207, "the at-cost Kora's status")
  assert.equal(res.headers.get('x-stand-in'), 'at-cost', 'and its headers')
  assert.deepEqual(await res.json(), { answered: '/?a=1' }, 'and its body')
  const call = atCostCalls.at(-1)!
  assert.deepEqual([call.method, call.url, call.body], ['POST', '/?a=1', rpc], 'the request as it came')
  assert.equal(call.headers['x-app'], 'forest')
  assert.equal(call.headers['content-type'], 'application/json')

  // Railway's health check, and a browser's preflight: Kora's own to answer.
  assert.equal((await fetch(`${service!.url}/liveness`)).status, 200)
  assert.equal(atCostCalls.at(-1)!.method, 'GET')
  await fetch(`${service!.url}/`, { method: 'OPTIONS' })
  assert.deepEqual([atCostCalls.at(-1)!.method, atCostCalls.at(-1)!.url], ['OPTIONS', '/'])
  assert.equal(calls.length, free, 'none of it reached the free Kora')
})

test('VOUCHER_ISSUERS: each issuer with how many vouchers a stamp on its list earns', () => {
  const env = { FREE_KORA_URL: 'http://127.0.0.1:8082', FREE_KORA_API_KEY: 'k', AT_COST_KORA_URL: 'http://127.0.0.1:8081', REGISTRY_PROGRAM: REGISTRY.toBase58() }
  const [a, b] = [face.key.publicKey.toBase58(), id.key.publicKey.toBase58()]
  const config = readConfig({ ...env, VOUCHER_ISSUERS: `${a}:3, ${b}:10` })
  assert.deepEqual(
    config.issuers.map((i) => [new PublicKey(i.issuer).toBase58(), i.vouchers]),
    [[a, 3], [b, 10]],
  )
  assert.throws(() => readConfig(env), /missing environment variables: VOUCHER_ISSUERS/)
  for (const bad of [a, `${a}:0`, `${a}:-1`, `${a}:3:4`, `${a}:three`, `:3`, `${a}:3,${a}:10`]) {
    assert.throws(() => readConfig({ ...env, VOUCHER_ISSUERS: bad }), /VOUCHER_ISSUERS|public key/i, bad)
  }
})
