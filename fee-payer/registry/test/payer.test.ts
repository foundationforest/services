// The registry payer's front on loopback, in front of a stand-in Kora that records what reaches it,
// with a stand-in RPC for payments and for the rows it watches. Real credits: bought, collected and
// finished with forest's credits client, checked with its checkCredit. Each refusal is provoked once,
// and nothing refused reaches Kora; a credit is held while its row is in flight, spent once the row
// lands, and freed when Kora refuses it, when the row fails, or when its blockhash goes past; a hold
// outlives a restart. A request whose URL cannot be read gets 400, and the front goes on.
//
//   npm test
//
// Needs the registry client's and the credits' dependencies (`../../standard.sh registry/client
// credits`). If either is missing the test says which and skips.

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'

import { type Credit, authorization, buy, finish, referenceOf, serviceOf } from '../../../standard/credits/src/index.ts'
import { DIRECTORY_PATH, keyFrom } from '../../../standard/credits/src/service.ts'
import { issuerKeyOf, registerIx } from '../../../standard/registry/client/src/index.ts'

import { type Config, UNIT, startFront } from '../src/payer.ts'

const here = dirname(fileURLToPath(import.meta.url))
const standard = join(here, '../../../standard')
const REGISTRY = new PublicKey('J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4')
const ORIGIN = 'https://registry-payer.test.example'
const MINT = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'
const API_KEY = randomBytes(16).toString('hex')
const payerKey = Keypair.generate()
const alice = Keypair.generate()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

function missing(): string | null {
  for (const p of ['registry/client', 'credits']) if (!existsSync(join(standard, p, 'node_modules'))) return `run \`npm ci\` in standard/${p}`
  return null
}

/** A `register` for this main key, as an app sends it. The row's own proof is the program's to check, not the front's. */
function register(profile: Keypair, programId = REGISTRY): TransactionInstruction {
  return registerIx({
    profile: profile.publicKey as never,
    label: 'tutoring/seller',
    stamp: new Uint8Array(randomBytes(32)),
    issuer: issuerKeyOf(new Uint8Array(randomBytes(32))),
    tier: 1n,
    proof: { a: new Uint8Array(32), b: new Uint8Array(64), c: new Uint8Array(32) },
    payer: payerKey.publicKey as never,
    programId: programId as never,
  }) as never
}

let blockhashes = 0
function transaction(instructions: TransactionInstruction[], signers: Keypair[]): { wire: string; blockhash: string } {
  const blockhash = new PublicKey(Buffer.alloc(32, ++blockhashes)).toBase58()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payerKey.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message())
  tx.sign(signers)
  return { wire: b64(tx.serialize()), blockhash }
}

// The stand-in Kora: it records each call, checks the key, and answers as `mode` says.
let mode: 'sign' | 'refuse' = 'sign'
let signed = 0
const calls: { url: string | undefined; apiKey: string | undefined; body: any }[] = []
const kora = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    if (req.url === '/liveness') return res.writeHead(200).end()
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ url: req.url, apiKey: req.headers['x-api-key'] as string | undefined, body })
    const result =
      body.method === 'getPayerSigner'
        ? { result: { signer_address: payerKey.publicKey.toBase58(), payment_address: payerKey.publicKey.toBase58() } }
        : mode === 'sign'
          ? { result: { signature: `row-${++signed}`, signed_transaction: body.params.transaction } }
          : { error: { code: -32000, message: 'Invalid transaction: stand-in refusal' } }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result }))
  })
})

// The stand-in RPC: the buys paid for, by reference; each row's status, by signature; each blockhash, live or past.
const paidRefs = new Set<string>()
const statuses = new Map<string, { err: unknown; confirmationStatus: string } | null>()
const pastBlockhashes = new Set<string>()
let rpcDown = false
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (rpcDown) throw new Error('down')
  if (method === 'getSignaturesForAddress') return paidRefs.has(params[0] as string) ? [{ signature: `pay-${params[0]}`, err: null }] : []
  if (method === 'getTransaction') {
    return {
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payerKey.publicKey.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payerKey.publicKey.toBase58(), uiTokenAmount: { amount: '10000000', decimals: 6 } }],
      },
      transaction: { message: { accountKeys: [] } },
    }
  }
  if (method === 'getSignatureStatuses') return { value: (params[0] as string[]).map((s) => statuses.get(s) ?? null) }
  if (method === 'isBlockhashValid') return { value: !pastBlockhashes.has(params[0] as string) }
  throw new Error(`no ${method}`)
}

let dir: string
let config: Config
let front: Awaited<ReturnType<typeof startFront>> | undefined

before(
  async () => {
    if (missing()) return
    await new Promise<void>((resolve) => kora.listen(0, '127.0.0.1', resolve))
    dir = mkdtempSync(join(tmpdir(), 'forest-registry-payer-'))
    const pkcs8 = new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))
    config = {
      koraUrl: `http://127.0.0.1:${(kora.address() as AddressInfo).port}`,
      koraApiKey: API_KEY,
      registry: REGISTRY,
      origin: ORIGIN,
      creditKey: await keyFrom(pkcs8),
      credit: { address: payerKey.publicKey.toBase58(), mint: MINT, price: '0.5' },
      maxBuy: 3,
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
  kora.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(front!.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body) })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) }
}

/** Credits as an app gets them: a buy, paid, collected, finished. */
async function credits(n: number): Promise<Credit[]> {
  const service = serviceOf(ORIGIN, (await (await fetch(front!.url + DIRECTORY_PATH)).json()) as unknown)
  const b = await buy(service, n)
  paidRefs.add(await referenceOf(b.buy))
  const got = await post('/credits/buy', b.buy, { 'content-type': 'application/private-token-generic-batch-request' })
  assert.equal(got.status, 200, JSON.stringify(got.body))
  return finish(b.pending, got.body as Uint8Array)
}

test('the registry payer', async (t) => {
  const why = missing()
  if (why) return t.skip(why)

  await t.test('its directory: what one credit buys, where it is paid, and its key', async () => {
    const res = await fetch(front!.url + DIRECTORY_PATH)
    assert.equal(res.headers.get('content-type'), 'application/private-token-issuer-directory')
    const service = serviceOf(ORIGIN, await res.json())
    assert.deepEqual([service.unit, service.address, service.mint, service.price, service.requestUri], [UNIT, payerKey.publicKey.toBase58(), MINT, '0.5', `${ORIGIN}/credits/buy`])
    assert.deepEqual(service.key, config.creditKey.published)
  })

  await t.test('a buy: collected once paid, never more than it allows, never unpaid', async () => {
    const service = serviceOf(ORIGIN, (await (await fetch(front!.url + DIRECTORY_PATH)).json()) as unknown)
    const unpaid = await buy(service, 2)
    const refused = await post('/credits/buy', unpaid.buy)
    assert.deepEqual([refused.status, (refused.body as { error: string }).error], [402, 'not_paid'])
    assert.match((refused.body as { detail: string }).detail, /^1 to /, 'it says what to pay')
    assert.deepEqual((await post('/credits/buy', (await buy(service, 4)).buy)).body, { error: 'too_many', detail: 'at most 3 credits a buy' })
    assert.deepEqual((await post('/credits/buy', new Uint8Array([1, 2, 3]))).body, { error: 'not_a_buy' })
    rpcDown = true
    assert.deepEqual((await post('/credits/buy', unpaid.buy)).body, { error: 'payment_check_unavailable' })
    rpcDown = false
    assert.equal((await credits(3)).length, 3)
  })

  await t.test('refused before Kora: the request, the transaction, the signature, the credit', async () => {
    const [credit] = await credits(1)
    const shown = { authorization: authorization(credit!) }
    // A credit with one byte of its signature changed: read as a credit, checked, and refused.
    const changed = Buffer.from(credit!.credit, 'base64url')
    changed[changed.length - 1]! ^= 1
    const before = calls.length
    const one = transaction([register(alice)], [payerKey, alice])
    const cases: [unknown, Record<string, string>, number, string][] = [
      [{}, shown, 400, 'bad_request'],
      [{ transaction: one.wire, more: 1 }, shown, 400, 'bad_request'],
      [{ transaction: 'not base64!' }, shown, 400, 'bad_transaction'],
      [{ transaction: transaction([register(alice), SystemProgram.transfer({ fromPubkey: payerKey.publicKey, toPubkey: alice.publicKey, lamports: 1 })], [payerKey, alice]).wire }, shown, 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice, Keypair.generate().publicKey)], [payerKey, alice]).wire }, shown, 400, 'not_one_registration'],
      [{ transaction: transaction([register(alice)], [payerKey]).wire.replace(/^A/, 'A') }, shown, 400, 'not_signed_by_main_key'],
      [{ transaction: one.wire }, {}, 401, 'no_credit'],
      [{ transaction: one.wire }, { authorization: 'PrivateToken token="AAAA"' }, 401, 'no_credit'],
      [{ transaction: one.wire }, { authorization: authorization(changed) }, 402, 'credit'],
    ]
    for (const [body, headers, status, error] of cases) {
      const got = await post('/register', body, headers)
      assert.deepEqual([got.status, (got.body as { error: string }).error], [status, error], error)
    }
    assert.equal(calls.length, before, 'nothing refused reached Kora')
  })

  await t.test('Kora refuses: the credit is freed at once, and can be shown again', async () => {
    const [credit] = await credits(1)
    const shown = { authorization: authorization(credit!) }
    mode = 'refuse'
    const refused = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)
    assert.deepEqual([refused.status, (refused.body as { error: string }).error], [502, 'fee_payer_refused'])
    mode = 'sign'
    const again = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)
    assert.equal(again.status, 200, 'the same credit, again')
    assert.equal(calls.at(-1)!.apiKey, API_KEY, 'Kora asked with its key')
    statuses.set((again.body as { signature: string }).signature, { err: null, confirmationStatus: 'confirmed' })
    await front!.payer.settle()
  })

  await t.test('held while the row is in flight; spent once it lands', async () => {
    const [credit] = await credits(1)
    const shown = { authorization: authorization(credit!) }
    const sent = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)
    assert.equal(sent.status, 200)
    const { signature } = sent.body as { signature: string }
    assert.deepEqual((await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)).body, { error: 'held' })
    await front!.payer.settle()
    assert.deepEqual((await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)).body, { error: 'held' }, 'not landed yet, blockhash live: still held')
    statuses.set(signature, { err: null, confirmationStatus: 'confirmed' })
    await front!.payer.settle()
    assert.deepEqual((await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, shown)).body, { error: 'spent' })
  })

  await t.test('freed when the row fails, or never lands before its blockhash goes past', async () => {
    const [failed, lost] = await credits(2)
    const first = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, { authorization: authorization(failed!) })
    statuses.set((first.body as { signature: string }).signature, { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' })
    const second = transaction([register(alice)], [payerKey, alice])
    assert.equal((await post('/register', { transaction: second.wire }, { authorization: authorization(lost!) })).status, 200)
    pastBlockhashes.add(second.blockhash)
    await front!.payer.settle()
    for (const c of [failed, lost]) {
      const again = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, { authorization: authorization(c!) })
      assert.equal(again.status, 200, 'freed: shown again, and sent')
    }
  })

  await t.test('a hold outlives a restart, and settles after it', async () => {
    const [credit] = await credits(1)
    const sent = await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, { authorization: authorization(credit!) })
    await front!.close()
    front = await startFront(config, rpc)
    const held = front.payer.spent.holds().find((h) => h.note?.startsWith(`${(sent.body as { signature: string }).signature} `))
    assert.ok(held, 'still held, with what settles it')
    statuses.set((sent.body as { signature: string }).signature, { err: null, confirmationStatus: 'finalized' })
    await front.payer.settle()
    assert.deepEqual((await post('/register', { transaction: transaction([register(alice)], [payerKey, alice]).wire }, { authorization: authorization(credit!) })).body, { error: 'spent' })
    // A hold with no row sent (the process stopped between) is freed once no blockhash could still live.
    front.payer.spent.hold('ab'.repeat(32), null, Date.now())
    await front.payer.settle(Date.now() + 121_000)
    assert.equal(front.payer.spent.hold('ab'.repeat(32)), 'held', 'freed, so it holds again')
  })

  await t.test('getPayerSigner reaches Kora with its key; nothing else at `/`; `//` gets 400 and it goes on', async () => {
    const signer = await post('/', { jsonrpc: '2.0', id: 1, method: 'getPayerSigner', params: {} })
    assert.equal((signer.body as { result: { signer_address: string } }).result.signer_address, payerKey.publicKey.toBase58())
    assert.equal(calls.at(-1)!.apiKey, API_KEY)
    assert.equal((await post('/', { jsonrpc: '2.0', id: 1, method: 'signAndSendTransaction', params: {} })).status, 404)
    assert.equal((await fetch(front!.url + '/liveness')).status, 200)
    const status = await new Promise<string>((resolve) => {
      const socket = connect((new URL(front!.url).port as unknown as number) * 1, '127.0.0.1', () => socket.end('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      let got = ''
      socket.on('data', (c) => (got += c.toString('latin1')))
      socket.on('close', () => resolve(got.split('\r\n')[0]!))
    })
    assert.equal(status, 'HTTP/1.1 400 Bad Request')
    assert.equal((await fetch(front!.url + DIRECTORY_PATH)).status, 200, 'and it goes on')
  })
})
