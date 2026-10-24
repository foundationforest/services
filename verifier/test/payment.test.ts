// The RPC payment check against a local stand-in that answers the two calls the way Solana's JSON-RPC
// does. Nothing here reaches a chain.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { PaymentCheckUnavailable, RpcPayments, received } from '../src/payment.ts'

const PAY_TO = '3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH'
const MINT = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'
const OTHER_MINT = 'g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz'
const PAYER = '394TwRgAmEmRiqoA2EJXhWuLdzBRrCwchFf4DpjxuiRR'
const REFERENCE = 'BVT1PcgV7PAUVipZzm2xP9g6qQS97vdhofvZbkJy1JX4'
const PRICE = { amount: 2_500_000n, mint: MINT, payTo: PAY_TO }

const balance = (accountIndex: number, owner: string, amount: string, mint = MINT) => ({
  accountIndex,
  mint,
  owner,
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
})

/** A transfer of `amount` from the payer to the receiving address's account, which may be new. */
function transfer(amount: number, options: { mint?: string; to?: string; newAccount?: boolean; err?: unknown } = {}) {
  const mint = options.mint ?? MINT
  const to = options.to ?? PAY_TO
  return {
    slot: 1,
    blockTime: 1_790_000_000,
    meta: {
      err: options.err ?? null,
      fee: 10_000,
      preTokenBalances: [balance(1, PAYER, '10000000', mint), ...(options.newAccount ? [] : [balance(2, to, '1000000', mint)])],
      postTokenBalances: [balance(1, PAYER, String(10_000_000 - amount), mint), balance(2, to, String((options.newAccount ? 0 : 1_000_000) + amount), mint)],
    },
    transaction: { message: { accountKeys: [PAYER, 'payerAta', 'payToAta', MINT, REFERENCE] }, signatures: ['x'] },
  }
}

const transactions: Record<string, unknown> = {
  paid: transfer(2_500_000),
  paidToANewAccount: transfer(3_000_000, { newAccount: true }),
  short: transfer(2_499_999),
  wrongDollar: transfer(2_500_000, { mint: OTHER_MINT }),
  elsewhere: transfer(2_500_000, { to: PAYER }),
  failedInMeta: transfer(2_500_000, { err: { InstructionError: [0, 'Custom'] } }),
  failed: transfer(2_500_000),
  notFinalizedYet: null,
}
const named = [
  ...Object.keys(transactions).filter((s) => s !== 'failed').map((signature) => ({ signature, err: null, confirmationStatus: 'finalized' })),
  { signature: 'failed', err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
]

type Call = { method: string; params: any[] }
const calls: Call[] = []
let answer: (call: Call) => unknown = () => ({})
let base = ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const call = JSON.parse(body) as Call
    calls.push(call)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(answer(call) as object) }))
  })
})

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

test('a payment counts when a finalized transaction naming the reference paid the address at least the price, in the dollar', async () => {
  calls.length = 0
  answer = (call) =>
    call.method === 'getSignaturesForAddress' ? { result: named } : { result: transactions[call.params[0] as string] ?? null }
  const payments = new RpcPayments({ rpcUrl: base, price: PRICE })
  assert.deepEqual(await payments.landed(REFERENCE), ['paid', 'paidToANewAccount'])

  const [first, ...rest] = calls
  assert.deepEqual(first, { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [REFERENCE, { commitment: 'finalized', limit: 20 }] })
  assert.ok(rest.every((c) => c.method === 'getTransaction' && c.params[1].commitment === 'finalized' && c.params[1].maxSupportedTransactionVersion === 0))
  assert.equal(rest.some((c) => c.params[0] === 'failed'), false, 'a transaction that failed is not even read')
})

test('what the receiving address gained: its accounts in the dollar after, less before', () => {
  assert.equal(received(transfer(2_500_000) as never, PAY_TO, MINT), 2_500_000n)
  assert.equal(received(transfer(7, { newAccount: true }) as never, PAY_TO, MINT), 7n, 'an account the transfer made held nothing before')
  assert.equal(received(transfer(2_500_000) as never, PAY_TO, OTHER_MINT), 0n)
  assert.equal(received(transfer(2_500_000) as never, PAYER, MINT), -2_500_000n)
  assert.equal(received({ meta: null }, PAY_TO, MINT), 0n)
})

test('nothing landed is an empty list; an RPC that cannot answer throws, naming no reference', async () => {
  answer = () => ({ result: [] })
  assert.deepEqual(await new RpcPayments({ rpcUrl: base, price: PRICE }).landed(REFERENCE), [])

  for (const reply of [{ error: { code: -32602, message: `Invalid param: ${REFERENCE}` } }, { result: { not: 'a list' } }, {}]) {
    answer = () => reply
    await assert.rejects(new RpcPayments({ rpcUrl: base, price: PRICE }).landed(REFERENCE), (error: Error) => {
      assert.ok(error instanceof PaymentCheckUnavailable)
      assert.ok(!error.message.includes(REFERENCE))
      return true
    })
  }
  await assert.rejects(new RpcPayments({ rpcUrl: 'http://127.0.0.1:1/?api-key=secret', price: PRICE }).landed(REFERENCE), (error: Error) => {
    assert.ok(error instanceof PaymentCheckUnavailable)
    assert.ok(!error.message.includes('secret'), 'the URL, and any key in it, is not passed on')
    return true
  })
})
