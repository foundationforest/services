// The registry payer on loopback, with a stand-in RPC for payments, rows, simulations and sends.
// Real credits: bought, paid by a Solana payment or a sponsor's ticket, collected and finished with
// standard's credits client, checked with its checkCredit. Each refusal is provoked once, and
// nothing refused is held or sent. A row that exists is refused before anything is held; a credit
// is held, with the row and its blockhash, before the row is sent; a simulation that fails, or
// costs the payer more than the row's rent and the fee, frees it with nothing sent. Spent once the
// row exists; freed once the row is absent and its blockhash expired; one settle round at a time; a
// hold outlives a restart. Its address and liveness are its own; `//` gets 400, and it goes on.
//
//   npm test
//
// Needs the registry client's and the credits' dependencies (`../../standard.sh registry/client
// credits`). If either is missing the test says which and skips.

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'

import { type Credit, PAYMENT_HEADER, authorization, buy, finish, serviceOf, ticket, ticketMessage } from '../../../standard/credits/src/index.ts'
import { DIRECTORY_PATH, keyFrom } from '../../../standard/credits/src/service.ts'
import { issuerKeyOf, registerIx, rowSpace } from '../../../standard/registry/client/src/index.ts'
import { base58 } from '../../../standard/registry/client/src/rows.ts'

import { type Config, UNIT, startFront } from '../src/payer.ts'

const here = dirname(fileURLToPath(import.meta.url))
const standard = join(here, '../../../standard')
const REGISTRY = new PublicKey('J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4')
const ORIGIN = 'https://registry-payer.test.example'
const MINT = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'
const payerKey = Keypair.generate()
const alice = Keypair.generate()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const sponsor = generateKeyPairSync('ed25519')
const SPONSOR = new PublicKey(sponsor.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()

function missing(): string | null {
  for (const p of ['registry/client', 'credits']) if (!existsSync(join(standard, p, 'node_modules'))) return `run \`npm ci\` in standard/${p}`
  return null
}

/** A `register` for this main key, as an app sends it, and its row's address. The row's own proof is the program's to check. */
function register(profile: Keypair, opts: { programId?: PublicKey; payer?: PublicKey } = {}): TransactionInstruction {
  return registerIx({
    profile: profile.publicKey as never,
    label: 'tutoring/seller',
    stamp: new Uint8Array(randomBytes(32)),
    issuer: issuerKeyOf(new Uint8Array(randomBytes(32))),
    tier: 1n,
    proof: { a: new Uint8Array(32), b: new Uint8Array(64), c: new Uint8Array(32) },
    payer: (opts.payer ?? payerKey.publicKey) as never,
    programId: (opts.programId ?? REGISTRY) as never,
  }) as never
}

let blockhashes = 0
/** A transaction as an app sends it: the registry payer pays, the main key signs. */
function transaction(instructions: TransactionInstruction[], signers: Keypair[], feePayer = payerKey.publicKey): { wire: string; blockhash: string; row: string } {
  const blockhash = new PublicKey(Buffer.alloc(32, ++blockhashes)).toBase58()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message())
  tx.sign(signers)
  return { wire: b64(tx.serialize()), blockhash, row: instructions[0]!.keys[0]!.pubkey.toBase58() }
}
const row = () => transaction([register(alice)], [alice])

// The stand-in RPC: payments by signature; rows that exist; blockhashes past; how simulations go; what was sent.
const rentOf = (space: number) => (space + 128) * 5_080
const payments = new Map<string, string>()
const rows = new Set<string>()
const pastBlockhashes = new Set<string>()
let simulation: 'pass' | 'fail' | 'greedy' | 'unread' = 'pass'
let rpcDown = false
let sendDown = false
let slow = 0
const sent: string[] = []
let heldWhenSent: (string | null)[] = []
let front: Awaited<ReturnType<typeof startFront>> | undefined

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (rpcDown) throw new Error('down')
  if (slow) await sleep(slow)
  if (method === 'getTransaction') {
    const reference = payments.get(params[0] as string)
    if (!reference) return null
    return {
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payerKey.publicKey.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payerKey.publicKey.toBase58(), uiTokenAmount: { amount: '10000000', decimals: 6 } }],
      },
      transaction: { message: { accountKeys: ['Buyer', payerKey.publicKey.toBase58(), reference] } },
    }
  }
  if (method === 'getMinimumBalanceForRentExemption') return rentOf(params[0] as number)
  if (method === 'simulateTransaction') {
    const tx = VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64'))
    assert.ok(tx.signatures[0]!.some((b) => b !== 0), 'the payer signed before the simulation')
    assert.equal((params[1] as { innerInstructions?: boolean }).innerInstructions, true, 'with what ran inside it')
    if (simulation === 'fail') return { value: { err: { InstructionError: [0, { Custom: 6001 }] }, innerInstructions: null } }
    const rent = rentOf(rowSpace('tutoring/seller'.length))
    const system = (info: unknown, type = 'createAccount') => ({ programId: SystemProgram.programId.toBase58(), program: 'system', parsed: { type, info }, stackHeight: 2 })
    const payer = payerKey.publicKey.toBase58()
    const inner = {
      pass: [system({ source: payer, newAccount: 'Row', lamports: rent, space: 1, owner: REGISTRY.toBase58() })],
      greedy: [system({ source: payer, newAccount: 'Row', lamports: rent }), system({ source: payer, destination: 'Them', lamports: 1 }, 'transfer')],
      unread: [{ programId: SystemProgram.programId.toBase58(), accounts: [], data: 'x', stackHeight: 2 }],
    }[simulation]
    return { value: { err: null, innerInstructions: [{ index: 0, instructions: inner }] } }
  }
  if (method === 'sendTransaction') {
    heldWhenSent = front!.payer.spent.holds().map((h) => h.note)
    if (sendDown) throw new Error('down')
    sent.push(params[0] as string)
    return `sent-${sent.length}`
  }
  if (method === 'isBlockhashValid') return { value: !pastBlockhashes.has(params[0] as string) }
  if (method === 'getAccountInfo') return { value: rows.has(params[0] as string) ? { lamports: 1 } : null }
  throw new Error(`no ${method}`)
}

let dir: string
let config: Config

before(
  async () => {
    if (missing()) return
    dir = mkdtempSync(join(tmpdir(), 'forest-registry-payer-'))
    const pkcs8 = new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))
    config = {
      key: payerKey,
      registry: REGISTRY,
      origin: ORIGIN,
      creditKey: await keyFrom(pkcs8),
      credit: { address: payerKey.publicKey.toBase58(), mint: MINT, price: '0.5' },
      maxBuy: 3,
      sponsors: [SPONSOR],
      rpcUrl: 'unused',
      databasePath: join(dir, 'credits.sqlite'),
      port: 0,
      settleMs: 3_600_000,
    }
    front = await startFront(config, rpc)
  },
  { timeout: 60_000 },
)

after(async () => {
  await front?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(front!.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body) })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) }
}
const service = async () => serviceOf(ORIGIN, (await (await fetch(front!.url + DIRECTORY_PATH)).json()) as unknown)

/** Credits as an app gets them: a buy, paid on Solana, collected with the payment's signature, finished. */
async function credits(n: number): Promise<Credit[]> {
  const b = await buy(await service(), n)
  const signature = base58(new Uint8Array(randomBytes(64)))
  payments.set(signature, b.reference)
  const got = await post('/credits/buy', b.buy, { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `solana ${signature}` })
  assert.equal(got.status, 200, JSON.stringify(got.body))
  return finish(b.pending, got.body as Uint8Array)
}
const shown = (credit: Credit) => ({ authorization: authorization(credit) })
/** Every row held now lands, and is settled: what one subtest leaves held, the next does not see. */
async function landAll() {
  for (const h of front!.payer.spent.holds()) rows.add(h.note!.split(' ')[0]!)
  await front!.payer.settle()
}

test('the registry payer', async (t) => {
  const why = missing()
  if (why) return t.skip(why)

  await t.test('its directory: what one credit buys, where it is paid, and its key', async () => {
    const res = await fetch(front!.url + DIRECTORY_PATH)
    assert.equal(res.headers.get('content-type'), 'application/private-token-issuer-directory')
    const s = serviceOf(ORIGIN, await res.json())
    assert.deepEqual([s.unit, s.address, s.mint, s.price, s.requestUri], [UNIT, payerKey.publicKey.toBase58(), MINT, '0.5', `${ORIGIN}/credits/buy`])
    assert.deepEqual(s.key, config.creditKey.published)
  })

  await t.test('a buy: collected once a Solana payment or a sponsor’s ticket pays for it, never more than it allows', async () => {
    const unpaid = await buy(await service(), 2)
    const refused = await post('/credits/buy', unpaid.buy)
    assert.deepEqual([refused.status, (refused.body as { error: string }).error], [402, 'not_paid'])
    assert.match((refused.body as { detail: string }).detail, /^1 to /, 'it says what to pay')
    assert.deepEqual((await post('/credits/buy', (await buy(await service(), 4)).buy)).body, { error: 'too_many', detail: 'at most 3 credits a buy' })
    assert.deepEqual((await post('/credits/buy', new Uint8Array([1, 2, 3]))).body, { error: 'not_a_buy' })
    rpcDown = true
    const sig = base58(new Uint8Array(randomBytes(64)))
    assert.deepEqual((await post('/credits/buy', unpaid.buy, { [PAYMENT_HEADER]: `solana ${sig}` })).body, { error: 'payment_check_unavailable' })
    rpcDown = false
    assert.equal((await credits(3)).length, 3)
    const tickets = new Uint8Array(edSign(null, ticketMessage(ORIGIN, unpaid.reference, 2), sponsor.privateKey))
    const got = await post('/credits/buy', unpaid.buy, { [PAYMENT_HEADER]: `ticket ${ticket(SPONSOR, 2, tickets)}` })
    assert.equal((await finish(unpaid.pending, got.body as Uint8Array)).length, 2, 'paid by a sponsor it takes')
    assert.deepEqual(front!.payer.seller.bill(), { [SPONSOR]: 2 })
  })

  await t.test('refused before anything is held or sent: the request, the transaction, the signature, the credit', async () => {
    const [credit] = await credits(1)
    const changed = Buffer.from(credit!.credit, 'base64url')
    changed[changed.length - 1]! ^= 1
    const one = row()
    const label = register(alice)
    label.data = Buffer.concat([label.data, Buffer.from([0])])
    const cases: [unknown, Record<string, string>, number, string][] = [
      [{}, shown(credit!), 400, 'bad_request'],
      [{ transaction: one.wire, more: 1 }, shown(credit!), 400, 'bad_request'],
      [{ transaction: 'not base64!' }, shown(credit!), 400, 'bad_transaction'],
      [{ transaction: transaction([register(alice), SystemProgram.transfer({ fromPubkey: payerKey.publicKey, toPubkey: alice.publicKey, lamports: 1 })], [alice]).wire }, shown(credit!), 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice, { programId: Keypair.generate().publicKey })], [alice]).wire }, shown(credit!), 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice)], [alice], alice.publicKey).wire }, shown(credit!), 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice, { payer: alice.publicKey })], [alice]).wire }, shown(credit!), 400, 'not_one_registration'],
      [{ transaction: transaction([label], [alice]).wire }, shown(credit!), 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice)], []).wire }, shown(credit!), 400, 'not_signed_by_main_key'],
      [{ transaction: one.wire }, {}, 401, 'no_credit'],
      [{ transaction: one.wire }, { authorization: 'PrivateToken token="AAAA"' }, 401, 'no_credit'],
      [{ transaction: one.wire }, { authorization: authorization(changed) }, 402, 'credit'],
    ]
    for (const [body, headers, status, error] of cases) {
      const got = await post('/register', body, headers)
      assert.deepEqual([got.status, (got.body as { error: string }).error], [status, error], error)
    }
    rows.add(one.row)
    assert.deepEqual((await post('/register', { transaction: one.wire }, shown(credit!))).body, { error: 'row_exists' })
    assert.deepEqual([sent.length, front!.payer.spent.holds().length], [0, 0], 'nothing sent, nothing held')
    assert.equal((await post('/register', { transaction: row().wire }, shown(credit!))).status, 200, 'and the credit still pays for a row')
    await landAll()
  })

  await t.test('a simulation that fails, or funds more than the row’s rent from the payer: freed, nothing sent', async () => {
    const [credit] = await credits(1)
    const before = sent.length
    simulation = 'fail'
    assert.deepEqual((await post('/register', { transaction: row().wire }, shown(credit!))).body, { error: 'row_refused', detail: '{"InstructionError":[0,{"Custom":6001}]}' })
    simulation = 'greedy'
    assert.equal(((await post('/register', { transaction: row().wire }, shown(credit!))).body as { error: string }).error, 'over_cap', 'one lamport past the rent')
    simulation = 'unread'
    assert.equal(((await post('/register', { transaction: row().wire }, shown(credit!))).body as { error: string }).error, 'over_cap', 'a System instruction it cannot count')
    simulation = 'pass'
    assert.equal(sent.length, before, 'nothing sent')
    assert.equal((await post('/register', { transaction: row().wire }, shown(credit!))).status, 200, 'freed each time: the same credit pays for a row')
    await landAll()
  })

  await t.test('held with its row before it is sent; spent once the row exists', async () => {
    const [credit] = await credits(1)
    const one = row()
    const got = await post('/register', { transaction: one.wire }, shown(credit!))
    assert.deepEqual(got.body, { signature: `sent-${sent.length}` })
    assert.ok(heldWhenSent.includes(`${one.row} ${one.blockhash}`), 'held, with the row and its blockhash, before the send')
    const tx = VersionedTransaction.deserialize(Buffer.from(sent.at(-1)!, 'base64'))
    assert.ok(tx.signatures.every((s) => s.some((b) => b !== 0)), 'sent signed by the payer and the main key')
    assert.deepEqual((await post('/register', { transaction: row().wire }, shown(credit!))).body, { error: 'held' })
    await front!.payer.settle()
    assert.deepEqual((await post('/register', { transaction: row().wire }, shown(credit!))).body, { error: 'held' }, 'no row yet, blockhash live: still held')
    rows.add(one.row)
    await front!.payer.settle()
    assert.deepEqual((await post('/register', { transaction: row().wire }, shown(credit!))).body, { error: 'spent' })
  })

  await t.test('freed once its row is absent and its blockhash expired; a send the RPC did not take waits for the same', async () => {
    const [lost, unsent] = await credits(2)
    const one = row()
    assert.equal((await post('/register', { transaction: one.wire }, shown(lost!))).status, 200)
    sendDown = true
    const two = row()
    assert.equal(((await post('/register', { transaction: two.wire }, shown(unsent!))).body as { error: string }).error, 'not_sent')
    sendDown = false
    await front!.payer.settle()
    assert.equal(front!.payer.spent.holds().length, 2, 'both held while their blockhashes live')
    pastBlockhashes.add(one.blockhash)
    pastBlockhashes.add(two.blockhash)
    await front!.payer.settle()
    for (const c of [lost, unsent]) assert.equal((await post('/register', { transaction: row().wire }, shown(c!))).status, 200, 'freed: shown again, and sent')
    await landAll()
  })

  await t.test('a hold outlives a restart, and settles after it; a hold from before the one rule is freed', async () => {
    const [credit] = await credits(1)
    const one = row()
    await post('/register', { transaction: one.wire }, shown(credit!))
    await front!.close()
    front = await startFront(config, rpc)
    assert.deepEqual(front.payer.spent.holds().map((h) => h.note), [`${one.row} ${one.blockhash}`], 'still held, with what settles it')
    rows.add(one.row)
    front.payer.spent.hold('ab'.repeat(32), `${'5'.repeat(88)} ${one.blockhash}`)
    front.payer.spent.hold('cd'.repeat(32), null)
    await front.payer.settle()
    assert.deepEqual((await post('/register', { transaction: row().wire }, shown(credit!))).body, { error: 'spent' })
    assert.deepEqual([front.payer.spent.hold('ab'.repeat(32)), front.payer.spent.hold('cd'.repeat(32))], ['held', 'held'], 'freed, so they hold again')
    front.payer.spent.free(['ab'.repeat(32), 'cd'.repeat(32)])
  })

  await t.test('one settle round at a time', async () => {
    const quick = await startFront({ ...config, databasePath: join(dir, 'quick.sqlite'), settleMs: 1 }, rpc)
    let running = 0
    let most = 0
    let rounds = 0
    const settle = quick.payer.settle.bind(quick.payer)
    quick.payer.settle = async () => {
      most = Math.max(most, ++running)
      rounds++
      await sleep(20)
      await settle()
      running--
    }
    await sleep(200)
    await quick.close()
    assert.ok(rounds > 2, `it went round (${rounds})`)
    assert.equal(most, 1, 'never two at once')
  })

  await t.test('its address and liveness are its own; nothing else at `/`; `//` gets 400 and it goes on', async () => {
    const signer = await post('/', { jsonrpc: '2.0', id: 7, method: 'getPayerSigner', params: {} })
    assert.deepEqual(signer.body, { jsonrpc: '2.0', id: 7, result: { signer_address: payerKey.publicKey.toBase58(), payment_address: payerKey.publicKey.toBase58() } })
    assert.equal((await post('/', { jsonrpc: '2.0', id: 1, method: 'signAndSendTransaction', params: {} })).status, 404)
    assert.equal((await fetch(front!.url + '/liveness')).status, 200)
    const status = await new Promise<string>((resolve) => {
      const socket = connect(Number(new URL(front!.url).port), '127.0.0.1', () => socket.end('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      let got = ''
      socket.on('data', (c) => (got += c.toString('latin1')))
      socket.on('close', () => resolve(got.split('\r\n')[0]!))
    })
    assert.equal(status, 'HTTP/1.1 400 Bad Request')
    assert.equal((await fetch(front!.url + DIRECTORY_PATH)).status, 200, 'and it goes on')
  })
})
