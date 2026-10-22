// Evidence, against a stand-in RPC: escrow receipts read from the program's own events, and direct
// payments read from one getTransaction each, asked once.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { discriminator } from '@foundationforest/escrow-client'
import { base58 } from '@foundationforest/records'

import { ESCROW_PROGRAM } from '../src/chain.ts'
import type { DealPage } from '../src/pages/deal.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
import { at, DOLLAR, index, issuer, post, profile, publishProfile, startHost, startRpc, twin } from './world.ts'

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

const by = issuer()
let host: Awaited<ReturnType<typeof startHost>>
before(async () => {
  host = await startHost()
})
after(() => host.close())

test('evidence: an escrow or a payment between the two profiles, in either direction, in a listed mint, counts', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  for (const p of [tutor, student]) await publishProfile(host.url, p)
  const [T, S] = [tutor.pay, student.pay]
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
  }
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
    return p?.meta ? { blockTime: 1_790_000_200, meta: p.meta } : null
  })

  // One review for each, by the student of the tutor, each about its own post so each counts.
  const reviews: Array<[string, string | undefined, 'with' | 'invalid' | 'without']> = [
    ['escrow-paid', escrows.paid, 'with'],
    ['escrow-refunded', escrows.refunded, 'invalid'],
    ['escrow-others', escrows.others, 'invalid'],
    ['escrow-reverse', escrows.reverse, 'with'],
    ['escrow-other-mint', escrows.otherMint, 'invalid'],
    ['escrow-open', escrows.open, 'invalid'],
    ['escrow-unknown', address(), 'invalid'],
    ['payment-paid', payments.paid!.signature, 'with'],
    ['payment-reverse', payments.reverse!.signature, 'with'],
    ['payment-other-mint', payments.otherMint!.signature, 'invalid'],
    ['payment-others', payments.others!.signature, 'invalid'],
    ['payment-failed', payments.failed!.signature, 'invalid'],
    ['payment-missing', payments.missing!.signature, 'invalid'],
    ['not-evidence', 'a receipt, I promise', 'invalid'],
    ['none', undefined, 'without'],
  ]
  await post(
    host.url,
    reviews.map(([id, evidence]) => at(student, `review/${id}`, { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/${id}`, ...(evidence && { evidence }) })),
  )

  const i = await index({ hosts: [host.url], keys: [{ key: by.key, issuer: by.name, label: 'face check', points: 1 }] }, rpc.url)
  await i.pass()
  await i.pass()
  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  for (const [id, , want] of reviews) {
    const r = t.reviews.received.find((x) => x.address.endsWith(`/review/${id}`))!
    assert.equal(r.counted, true, id)
    assert.equal(r.evidence, want, id)
  }
  assert.equal(t.rating.withPayment, 4)
  assert.equal(t.rating.reviews, reviews.length)

  // Each payment was asked for once, over two passes; each escrow transaction once.
  for (const p of Object.values(payments)) assert.equal(asked.filter((s) => s === p.signature).length, 1)
  for (const h of history) assert.equal(asked.filter((s) => s === h.signature).length, 1)

  // The deal's page: its receipt and its moves.
  const d = (await twin<DealPage>(i, `/deals/${escrows.reverse}.json`)).body
  assert.equal(d.receipt!.payer, T)
  assert.equal(d.receipt!.outcome, 'agree')
  assert.equal(d.receipt!.toRecipient, '60')
  assert.deepEqual(d.moves.map((m) => [m.move, m.by]), [['created', 'payer'], ['ended', 'payer and recipient']])
  assert.deepEqual(d.profiles, { payer: [tutor.key.address], recipient: [student.key.address] })
  assert.equal(d.money!.code, 'USD')
  assert.equal((await twin(i, `/deals/${address()}.json`)).status, 404)

  await i.close()
  await rpc.close()
})
