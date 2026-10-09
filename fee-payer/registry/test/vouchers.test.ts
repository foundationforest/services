// The voucher check on loopback, the fee payer's front, in front of two stand-in Koras that record
// what reaches them: the free one, behind the voucher door, and the at-cost one, which gets every
// other request. Real vouchers: person proofs from notes a test issuer signed, made with forest's
// provePerson, checked with its verifyPerson. Each refusal is provoked once, and nothing refused ever
// reaches either Kora. A request whose URL cannot be read gets 400, and the front goes on.
//
//   npm test
//
// Needs the registry client's dependencies (`../../standard.sh registry/client`); the person circuit's
// files are committed in forest. If either is missing the test says which and skips.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

import { issuerKeyBytes, issuerKeyOf, noteNumberOf, provePerson, refundIx, registerIx, signNote, toBytes32 } from '../../../standard/registry/client/src/index.ts'

import { UsedSet, readConfig, startFront, type Config } from '../src/vouchers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const standard = join(here, '../../../standard')
const artifacts = { wasm: join(standard, 'registry/circuit/devnet/person.wasm'), zkey: join(standard, 'registry/circuit/devnet/person.zkey') }
const REGISTRY = new PublicKey('J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4')
const NAME = 'fee-payer.test.forest.example'
const API_KEY = randomBytes(16).toString('hex')

function missing(): string | null {
  if (!existsSync(join(standard, 'registry/client/node_modules'))) return 'run `npm ci` in standard/registry/client'
  if (!existsSync(artifacts.zkey)) return "no person circuit's files in standard/registry/circuit/devnet"
  return null
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

// The issuer, as far as this test goes: its key, and a note it signs for Alice, at tier 1 and at
// tier 2, from her secret for it. Another issuer the fee payer does not trust signs her a note too.
const issuerPrivate = new Uint8Array(randomBytes(32))
const issuer = issuerKeyOf(issuerPrivate)
const issuerHex = hex(issuerKeyBytes(issuer))
const secret = new Uint8Array(randomBytes(32))
const noteAt = (tier: bigint, key = issuerPrivate) =>
  signNote(key, { noteNumber: noteNumberOf(secret), embedding: new Uint8Array(512).fill(7), model: 'test-model', tier })
const feePayer = Keypair.generate()
const alice = Keypair.generate()
const bob = Keypair.generate()

type VoucherJson = { proof: unknown; issuer: string; tier: string; label: string; stamp: string }
async function voucherFor(profile: Keypair, label: string, note = noteAt(1n)): Promise<VoucherJson> {
  const p = await provePerson({ secret, note, label, profile: profile.publicKey.toBytes(), artifacts })
  return { proof: p.proof, issuer: hex(issuerKeyBytes(p.issuer)), tier: p.tier.toString(), label, stamp: hex(toBytes32(p.stamp)) }
}
const label = (n: number | string, name = NAME) => `voucher/${name}/${n}`

/** A `register` for this main key, as an app sends it. The row's own proof is the program's to check, not the voucher check's. */
function register(profile: Keypair, programId = REGISTRY): TransactionInstruction {
  return registerIx({
    profile: profile.publicKey as never,
    label: 'tutoring/seller',
    stamp: new Uint8Array(randomBytes(32)),
    issuer,
    tier: 1n,
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
      name: NAME,
      issuers: [
        { issuer: issuerHex, tier: 1n, vouchers: 3 },
        { issuer: issuerHex, tier: 2n, vouchers: 10 },
      ],
      registry: REGISTRY,
      databasePath: join(dir, 'data/vouchers.sqlite'),
      port: 0,
    }
    service = await startFront(config)
    vouchers.one = await voucherFor(alice, label(1))
    vouchers.two = await voucherFor(alice, label(2))
    vouchers.tierTwoOne = await voucherFor(alice, label(1), noteAt(2n))
    vouchers.tierTwoFour = await voucherFor(alice, label(4), noteAt(2n))
    vouchers.tierTwoTen = await voucherFor(alice, label(10), noteAt(2n))
    vouchers.tierOneFour = await voucherFor(alice, label(4))
    vouchers.elsewhere = await voucherFor(alice, label(1, 'another.fee-payer.example'))
    vouchers.stranger = await voucherFor(alice, label(1), noteAt(1n, new Uint8Array(randomBytes(32))))
    vouchers.tierThree = await voucherFor(alice, label(1), noteAt(3n))
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
  await refused({ transaction: good, voucher: { ...one, stamp: 'zz' } }, 'bad_request')
  await refused({ transaction: good, voucher: { ...one, issuer: one.issuer.toUpperCase() } }, 'bad_request')
  await refused({ transaction: good, voucher: { ...one, tier: 1 } }, 'bad_request')
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

  // The voucher: an issuer and tier this fee payer takes, this fee payer's label within the tier's
  // count, and its proof.
  await refused({ transaction: good, voucher: vouchers.stranger }, 'not_a_trusted_issuer')
  await refused({ transaction: good, voucher: vouchers.tierThree }, 'not_a_trusted_issuer')
  await refused({ transaction: good, voucher: vouchers.elsewhere }, 'not_a_voucher_label')
  await refused({ transaction: good, voucher: vouchers.tierOneFour }, 'not_a_voucher_label')
  for (const bad of [label(0), label('01'), label(11), 'sponsor/1', 'tutoring/seller', `voucher/${NAME}`, `voucher/${NAME}/1/2`]) {
    await refused({ transaction: good, voucher: { ...one, label: bad } }, 'not_a_voucher_label')
  }
  await refused({ transaction: good, voucher: { ...vouchers.tierTwoTen!, label: label(11) } }, 'not_a_voucher_label')
  // The proof must hold for what the voucher says: its label, its stamp, its tier, its main key.
  await refused({ transaction: good, voucher: { ...one, label: label(3) } }, 'voucher_does_not_hold')
  const otherStamp = Buffer.from(one.stamp, 'hex')
  otherStamp[31] ^= 1
  await refused({ transaction: good, voucher: { ...one, stamp: otherStamp.toString('hex') } }, 'voucher_does_not_hold')
  await refused({ transaction: good, voucher: { ...one, tier: '2' } }, 'voucher_does_not_hold')
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

  // A tier 2 note earns ten: the same person's stamps under the same labels, so its first three are
  // the tier 1 note's, and the rest are new.
  assert.equal(vouchers.tierTwoOne!.stamp, one.stamp, 'a stamp depends on the person and the label, not the tier')
  await refused({ transaction: transaction([register(alice)], [alice]), voucher: vouchers.tierTwoOne }, 'voucher_used', 409)
  for (const voucher of [vouchers.tierTwoFour!, vouchers.tierTwoTen!]) {
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

/** One request as raw bytes, so a URL no client would send arrives as written; the status line's code, or null if none came. */
function raw(url: string, request: string): Promise<number | null> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.end(request))
    let got = ''
    socket.on('data', (chunk) => (got += chunk.toString('latin1')))
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]) || null))
    socket.on('error', reject)
  })
}

test('a request whose URL cannot be read gets 400, reaches neither Kora, and the front goes on answering', async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  for (const path of ['//', '/\\', '//x:99999']) {
    const before = [calls.length, atCostCalls.length]
    assert.equal(await raw(service!.url, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), 400, path)
    assert.deepEqual([calls.length, atCostCalls.length], before, `${path}: nothing reached either Kora`)
    assert.equal((await fetch(`${service!.url}/liveness`)).status, 200, `still answering after ${path}`)
  }
})

test('FEE_PAYER_NAME and VOUCHER_ISSUERS: the name in every label, and each issuer and tier with how many vouchers it earns', () => {
  const env = { FREE_KORA_URL: 'http://127.0.0.1:8082', FREE_KORA_API_KEY: 'k', AT_COST_KORA_URL: 'http://127.0.0.1:8081', REGISTRY_PROGRAM: REGISTRY.toBase58(), FEE_PAYER_NAME: NAME }
  const a = issuerHex
  const b = 'ab'.repeat(64)
  const config = readConfig({ ...env, VOUCHER_ISSUERS: `${a}:1:3, ${a}:2:10,${b}:1:1` })
  assert.equal(config.name, NAME)
  assert.deepEqual(config.issuers, [{ issuer: a, tier: 1n, vouchers: 3 }, { issuer: a, tier: 2n, vouchers: 10 }, { issuer: b, tier: 1n, vouchers: 1 }])
  assert.throws(() => readConfig({ ...env, FEE_PAYER_NAME: '' , VOUCHER_ISSUERS: `${a}:1:3` }), /missing environment variables: FEE_PAYER_NAME/)
  assert.throws(() => readConfig({ ...env, VOUCHER_ISSUERS: `${a}:1:3`, FEE_PAYER_NAME: 'a/b' }), /FEE_PAYER_NAME/)
  assert.throws(() => readConfig(env), /missing environment variables: VOUCHER_ISSUERS/)
  for (const bad of [a, `${a}:1`, `${a}:0:3`, `${a}:1:0`, `${a}:1:3:4`, `${a}:1:three`, `${a.toUpperCase()}:1:3`, `${a.slice(2)}:1:3`, `:1:3`, `${a}:1:3,${a}:1:10`]) {
    assert.throws(() => readConfig({ ...env, VOUCHER_ISSUERS: bad }), /VOUCHER_ISSUERS/, bad)
  }
})

test('a used set kept before notes: its column renamed, its vouchers still spent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-vouchers-old-'))
  try {
    const path = join(dir, 'vouchers.sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE used (market_stamp BLOB PRIMARY KEY) WITHOUT ROWID')
    const spent = new Uint8Array(randomBytes(32))
    old.prepare('INSERT INTO used (market_stamp) VALUES (?)').run(spent)
    old.close()
    const used = new UsedSet(path)
    assert.equal(used.spend(spent), false, 'spent before, still spent')
    assert.equal(used.spend(new Uint8Array(randomBytes(32))), true)
    used.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
