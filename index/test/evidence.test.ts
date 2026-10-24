// Evidence, against a stand-in RPC: `<chain>:<id>` on the chain the lists read; escrow receipts
// read from the program's own events, and direct payments read from one getTransaction each, kept
// once the chain has an answer, and asked again while it has none until the review is a day old. On
// a chain the lists do not name it is unchecked, and with no chain invalid.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { discriminator } from '@foundationforest/escrow-client'
import { base58, ownerRecord } from '@foundationforest/records'

import { ESCROW_PROGRAM } from '../src/chain.ts'
import type { DealPage } from '../src/pages/deal.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
import { at, CHAIN, DOLLAR, index, verifier, post, profile, publishProfile, startHost, startRpc, twin } from './world.ts'

/** Bytes one after another. */
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))
const address = () => base58.encode(randomBytes(32))
const signature = () => base58.encode(randomBytes(64))
const u8 = (n: number) => Uint8Array.of(n)
const u16 = (n: number) => {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, true)
  return b
}
const u64 = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const key = (a: string) => base58.decode(a)
const noSchedule = concat(u8(0), ...Array.from({ length: 4 }, () => concat(u64(0n), u16(0))), u8(0))
const OUTCOMES = ['pay', 'refund', 'takeBack', 'agree', 'decide', 'end']

/** The program's Created and Ended events, as its log lines carry them. */
function created(escrow: string, payer: string, recipient: string, mint: string, amount: bigint): Uint8Array {
  return concat(discriminator('event', 'Created'), key(escrow), u8(3), u64(1n), key(payer), key(recipient), u8(0), new Uint8Array(32), key(mint), key(address()), key(address()), u64(amount), noSchedule, u64(1_790_000_000n))
}
function ended(escrow: string, outcome: string, amount: bigint, toPayer: bigint, toRecipient: bigint): Uint8Array {
  return concat(discriminator('event', 'Ended'), key(escrow), u8(OUTCOMES.indexOf(outcome)), u64(amount), u64(amount), u64(toPayer), u64(toRecipient), u64(1_790_000_100n), key(address()), u64(0n), u64(1_790_000_050n))
}
const logs = (...events: Uint8Array[]) => [`Program ${ESCROW_PROGRAM} invoke [1]`, ...events.map((e) => `Program data: ${Buffer.from(e).toString('base64')}`), `Program ${ESCROW_PROGRAM} success`]
const balance = (owner: string, mint: string, amount: string, accountIndex: number) => ({ accountIndex, mint, owner, uiTokenAmount: { amount } })

const by = verifier()
let host: Awaited<ReturnType<typeof startHost>>
before(async () => {
  host = await startHost()
})
after(() => host.close())

test('evidence: an escrow or a payment between the two profiles, in either direction, in a listed mint, counts', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  for (const p of [tutor, student]) await publishProfile(host.url, p)
  const [T, S] = [tutor.pay.solana, student.pay.solana]
  const other = address()
  const otherMint = address()

  // The chain: escrows and payments, oldest first.
  const escrows = { paid: address(), refunded: address(), others: address(), reverse: address(), otherMint: address(), open: address() }
  const history: Array<{ signature: string; logs: string[]; meta?: object | null }> = [
    { signature: signature(), logs: logs(created(escrows.paid, S, T, DOLLAR, 100n), ended(escrows.paid, 'pay', 100n, 0n, 100n)) },
    { signature: signature(), logs: logs(created(escrows.refunded, S, T, DOLLAR, 100n)) },
    { signature: signature(), logs: logs(ended(escrows.refunded, 'refund', 100n, 100n, 0n)) },
    { signature: signature(), logs: logs(created(escrows.others, S, other, DOLLAR, 100n), ended(escrows.others, 'pay', 100n, 0n, 100n)) },
    { signature: signature(), logs: logs(created(escrows.reverse, T, S, DOLLAR, 100n), ended(escrows.reverse, 'agree', 100n, 40n, 60n)) },
    { signature: signature(), logs: logs(created(escrows.otherMint, S, T, otherMint, 100n), ended(escrows.otherMint, 'pay', 100n, 0n, 100n)) },
    { signature: signature(), logs: logs(created(escrows.open, S, T, DOLLAR, 100n)) },
  ]
  const moved = (from: string, to: string, mint: string) => ({
    err: null,
    preTokenBalances: [balance(from, mint, '500', 1), balance(to, mint, '0', 2)],
    postTokenBalances: [balance(from, mint, '400', 1), balance(to, mint, '100', 2)],
  })
  const payments: { [name: string]: { signature: string; meta: object | null } } = {
    paid: { signature: signature(), meta: moved(S, T, DOLLAR) },
    reverse: { signature: signature(), meta: moved(T, S, DOLLAR) },
    otherMint: { signature: signature(), meta: moved(S, T, otherMint) },
    others: { signature: signature(), meta: moved(S, other, DOLLAR) },
    failed: { signature: signature(), meta: { ...moved(S, T, DOLLAR), err: { InstructionError: [0, 'Custom'] } } },
    missing: { signature: signature(), meta: null },
    late: { signature: signature(), meta: moved(S, T, DOLLAR) },
    old: { signature: signature(), meta: null },
  }
  // The late payment is on chain, final, only from the second pass.
  let final = false
  const asked: string[] = []
  const rpc = await startRpc((method, params) => {
    if (method === 'getSignaturesForAddress') {
      const until = (params[1] as { until?: string }).until
      const from = until ? history.findIndex((h) => h.signature === until) + 1 : 0
      return history.slice(from).reverse().map((h) => ({ signature: h.signature, err: null }))
    }
    const sig = params[0] as string
    asked.push(sig)
    const h = history.find((x) => x.signature === sig)
    if (h) return { blockTime: 1_790_000_200, meta: { err: null, logMessages: h.logs } }
    const p = Object.values(payments).find((x) => x.signature === sig)
    if (p === payments.late && !final) return null
    return p?.meta ? { blockTime: 1_790_000_200, meta: p.meta } : null
  })

  // One review for each, by the student of the tutor, each about its own post so each counts.
  const on = (id: string) => `${CHAIN}:${id}`
  const mainnet = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
  const reviews: Array<[string, string | undefined, 'with' | 'invalid' | 'without' | 'unchecked']> = [
    ['escrow-paid', on(escrows.paid), 'with'],
    ['escrow-refunded', on(escrows.refunded), 'invalid'],
    ['escrow-others', on(escrows.others), 'invalid'],
    ['escrow-reverse', on(escrows.reverse), 'with'],
    ['escrow-other-mint', on(escrows.otherMint), 'invalid'],
    ['escrow-open', on(escrows.open), 'invalid'],
    ['escrow-unknown', on(address()), 'invalid'],
    ['payment-paid', on(payments.paid!.signature), 'with'],
    ['payment-reverse', on(payments.reverse!.signature), 'with'],
    ['payment-other-mint', on(payments.otherMint!.signature), 'invalid'],
    ['payment-others', on(payments.others!.signature), 'invalid'],
    ['payment-failed', on(payments.failed!.signature), 'invalid'],
    ['payment-missing', on(payments.missing!.signature), 'without'],
    ['payment-late', on(payments.late!.signature), 'with'],
    ['not-evidence', on('a receipt, I promise'), 'invalid'],
    ['no-chain', escrows.paid, 'invalid'],
    ['no-chain-payment', payments.paid!.signature, 'invalid'],
    ['not-a-chain', `x:${escrows.paid}`, 'invalid'],
    ['other-chain', `${mainnet}:${payments.paid!.signature}`, 'unchecked'],
    ['other-chain-escrow', `${mainnet}:${escrows.paid}`, 'unchecked'],
    ['evm', `eip155:1:0x${'ab'.repeat(32)}`, 'unchecked'],
    ['none', undefined, 'without'],
  ]
  await post(
    host.url,
    reviews.map(([id, evidence]) => at(student, `review/${id}`, { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/${id}`, ...(evidence && { evidence }) })),
  )
  // A review written two days ago, naming a payment the chain still does not hold.
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
  await post(host.url, [ownerRecord(student.key, 'review/payment-old', { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/old`, evidence: on(payments.old!.signature) }, twoDaysAgo)])
  reviews.push(['payment-old', payments.old!.signature, 'invalid'])

  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', points: 1 }] }, rpc.url)
  await i.pass()
  const early = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  const status = (id: string) => early.reviews.received.find((x) => x.address.endsWith(`/review/${id}`))!.evidence
  assert.deepEqual([status('payment-late'), status('payment-missing'), status('payment-old')], ['without', 'without', 'invalid'])
  final = true
  await i.pass()
  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  for (const [id, , want] of reviews) {
    const r = t.reviews.received.find((x) => x.address.endsWith(`/review/${id}`))!
    assert.equal(r.counted, true, id)
    assert.equal(r.evidence, want, id)
    // Only an unchecked one says why: the chain this index does not read.
    assert.equal(r.evidenceWhy, want === 'unchecked' ? `this index reads no evidence on ${id === 'evm' ? 'eip155:1' : mainnet}` : undefined, id)
  }
  assert.equal(t.rating.withPayment, 5)
  assert.equal(t.rating.reviews, reviews.length)

  // Over two passes: a payment the chain answered for, and one past its day, asked once; one not on
  // chain yet, on each pass. Each escrow transaction once.
  const asks = (p: { signature: string }) => asked.filter((s) => s === p.signature).length
  for (const [name, p] of Object.entries(payments)) assert.equal(asks(p), name === 'missing' || name === 'late' ? 2 : 1, name)
  for (const h of history) assert.equal(asked.filter((s) => s === h.signature).length, 1)

  // The deal's page: its receipt and its moves.
  const d = (await twin<DealPage>(i, `/deals/${escrows.reverse}.json`)).body
  assert.equal(d.receipt!.payer, T)
  assert.equal(d.receipt!.outcome, 'agree')
  assert.equal(d.receipt!.toRecipient, '60')
  assert.deepEqual(d.moves.map((m) => [m.move, m.by]), [['created', 'payer'], ['ended', 'payer and recipient']])
  assert.deepEqual(d.profiles, { payer: [tutor.key.address], recipient: [student.key.address] })
  // The reviews that name it, as <chain>:<escrow>; one naming it on another chain does not.
  assert.deepEqual(d.reviews.map((r) => r.address), [`${student.key.address}/review/escrow-reverse`])
  assert.deepEqual((await twin<DealPage>(i, `/deals/${escrows.paid}.json`)).body.reviews.map((r) => r.address.split('/review/')[1]), ['escrow-paid'])
  assert.equal(d.money!.code, 'USD')
  assert.equal((await twin(i, `/deals/${address()}.json`)).status, 404)

  await i.close()
  await rpc.close()
})
