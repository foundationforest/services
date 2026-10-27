// Evidence, against a stand-in RPC: `<chain>:<id>` on the chain the lists read; escrow receipts
// read from the program's own events, and direct payments read from one getTransaction each, kept
// once the chain has an answer, and asked again while it has none until a day after this index
// first saw the review, by its own clock. One payment or escrow backs one review, the earliest it
// backs. On a chain the lists do not name it is unchecked, and with no chain invalid. A pay address
// its pay key did not sign for the profile gives no evidence, and no place on a deal's page.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { VERSION, discriminator } from '@foundationforest/escrow-client'
import { base58, ownerRecord } from '@foundationforest/records'

import { ESCROW_PROGRAM } from '../src/chain.ts'
import { UNSIGNED, USED } from '../src/evidence/index.ts'
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
  return concat(discriminator('event', 'Created'), key(escrow), u8(VERSION), u64(1n), key(payer), key(recipient), u8(0), new Uint8Array(32), key(mint), key(address()), key(address()), u64(amount), noSchedule, u64(1_790_000_000n))
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
  const stranger = await profile('tutoring/student', [by])
  for (const p of [tutor, student, stranger]) await publishProfile(host.url, p)
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
  const reviews: Array<[string, string | undefined, 'with' | 'invalid' | 'without' | 'unchecked', string?]> = [
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
    // A payment that backed an earlier review backs no other.
    ['payment-reused', on(payments.paid!.signature), 'invalid', USED],
  ]
  await post(
    host.url,
    reviews.map(([id, evidence]) => at(student, `review/${id}`, { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/${id}`, ...(evidence && { evidence }) })),
  )
  // A review written two days ago, which this index first sees now, naming a payment the chain
  // still does not hold: its day runs from now.
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
  await post(host.url, [ownerRecord(student.key, 'review/payment-old', { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/old`, evidence: on(payments.old!.signature) }, twoDaysAgo)])
  reviews.push(['payment-old', payments.old!.signature, 'without'])
  // The tutor names the escrow the student's review already used; and a stranger names the
  // student's payment in a review dated before it, which takes nothing from the student's.
  await post(host.url, [at(tutor, 'review/escrow-paid', { subject: student.key.address, score: '9', evidence: on(escrows.paid) })])
  await post(host.url, [ownerRecord(stranger.key, 'review/grief', { subject: tutor.key.address, score: '1', evidence: on(payments.paid!.signature) }, Date.now() - 60_000)])

  let clock = Date.now()
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] }, rpc.url, { now: () => clock })
  const page = async (p: typeof tutor) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body
  await i.pass()
  const statusOf = (o: ProfilePage, id: string) => o.reviews.received.find((x) => x.address.endsWith(`/review/${id}`))!.evidence
  const early = await page(tutor)
  assert.deepEqual([statusOf(early, 'payment-late'), statusOf(early, 'payment-missing'), statusOf(early, 'payment-old')], ['without', 'without', 'without'])
  final = true
  clock = Date.now()
  await i.pass()
  const t = await page(tutor)
  for (const [id, , want, why] of reviews) {
    const r = t.reviews.received.find((x) => x.address.endsWith(`/review/${id}`))!
    assert.equal(r.counted, true, id)
    assert.equal(r.evidence, want, id)
    // An unchecked one says why, the chain this index does not read; a reused one, that it is used.
    assert.equal(r.evidenceWhy, want === 'unchecked' ? `this index reads no evidence on ${id === 'evm' ? 'eip155:1' : mainnet}` : why, id)
  }
  assert.equal(t.reviews.received.filter((r) => r.evidence === 'with').length, 5)
  const grief = t.reviews.received.find((r) => r.address === `${stranger.key.address}/review/grief`)!
  assert.deepEqual([grief.counted, grief.evidence, grief.evidenceWhy], [true, 'invalid', undefined])
  const s = (await page(student)).reviews.received.find((r) => r.address === `${tutor.key.address}/review/escrow-paid`)!
  assert.deepEqual([s.counted, s.evidence, s.evidenceWhy], [true, 'invalid', USED])
  // The count of raters: the student and the stranger.
  assert.equal(t.ratings.count, 2)

  // Over two passes: a payment the chain answered for asked once for each pair of pay addresses (the
  // stranger's review asks for the paid one for its own); one not on chain yet, on each pass. Each
  // escrow transaction once.
  const asks = (p: { signature: string }) => asked.filter((s) => s === p.signature).length
  for (const [name, p] of Object.entries(payments)) assert.equal(asks(p), ['missing', 'late', 'old', 'paid'].includes(name) ? 2 : 1, name)
  for (const h of history) assert.equal(asked.filter((s) => s === h.signature).length, 1)

  // The day runs from when this index first saw each review, by its clock: 23 hours on, the two
  // missing payments are still asked for; 25 hours on, they are invalid, and never asked again.
  const first = Date.now()
  for (const [hours, want, times] of [[23, 'without', 3], [25, 'invalid', 4], [26, 'invalid', 4]] as const) {
    clock = first + hours * 60 * 60 * 1000
    await i.pass()
    const o = await page(tutor)
    for (const id of ['payment-missing', 'payment-old']) assert.equal(statusOf(o, id), want, `${id}, ${hours} hours on`)
    for (const name of ['missing', 'old']) assert.equal(asks(payments[name]!), times, `${name}, ${hours} hours on`)
  }

  // The deal's page: its receipt and its moves.
  const d = (await twin<DealPage>(i, `/deals/${escrows.reverse}.json`)).body
  assert.equal(d.receipt!.payer, T)
  assert.equal(d.receipt!.outcome, 'agree')
  assert.equal(d.receipt!.toRecipient, '60')
  assert.deepEqual(d.moves.map((m) => [m.move, m.by]), [['created', 'payer'], ['ended', 'payer and recipient']])
  assert.deepEqual(d.profiles, { payer: [tutor.key.address], recipient: [student.key.address] })
  // The reviews that name it, as <chain>:<escrow>; one naming it on another chain does not.
  assert.deepEqual(d.reviews.map((r) => r.address), [`${student.key.address}/review/escrow-reverse`])
  // Both reviews that name the paid escrow, the newest first: the tutor's, which it no longer backs, and the student's.
  assert.deepEqual((await twin<DealPage>(i, `/deals/${escrows.paid}.json`)).body.reviews.map((r) => r.address), [`${tutor.key.address}/review/escrow-paid`, `${student.key.address}/review/escrow-paid`])
  assert.equal(d.money!.code, 'USD')
  assert.equal((await twin(i, `/deals/${address()}.json`)).status, 404)

  await i.close()
  await rpc.close()
})

test('evidence: a pay address its pay key did not sign for the profile gives none, and no side of a deal', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  // The impostor lists the tutor's pay addresses, with the tutor's signatures: they hold for the
  // tutor's address, not the impostor's.
  const impostor = await profile('tutoring/tutor', [by])
  await publishProfile(host.url, tutor)
  await publishProfile(host.url, student)
  await publishProfile(host.url, impostor, { pay: tutor.pay, paySig: tutor.paySig })
  const escrow = address()
  const paid = { signature: signature(), logs: logs(created(escrow, student.pay.solana, tutor.pay.solana, DOLLAR, 100n), ended(escrow, 'pay', 100n, 0n, 100n)) }
  const rpc = await startRpc((method, params) => {
    if (method === 'getSignaturesForAddress') return (params[1] as { until?: string }).until ? [] : [{ signature: paid.signature, err: null }]
    return params[0] === paid.signature ? { blockTime: 1_790_000_200, meta: { err: null, logMessages: paid.logs } } : null
  })
  // The student reviews both, naming the one escrow; the review of the impostor, dated first, would
  // take it from the tutor's if the impostor's address counted.
  const evidence = `${CHAIN}:${escrow}`
  await post(host.url, [
    ownerRecord(student.key, 'review/impostor', { subject: impostor.key.address, score: '9', offer: `${impostor.key.address}/offer/maths`, evidence }, Date.now() - 60_000),
    at(student, 'review/tutor', { subject: tutor.key.address, score: '9', offer: `${tutor.key.address}/offer/maths`, evidence }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] }, rpc.url)
  try {
    await i.pass()
    const received = async (p: typeof tutor) => (await twin<ProfilePage>(i, `/profiles/${p.key.address}.json`)).body.reviews.received[0]!
    const fake = await received(impostor)
    assert.deepEqual([fake.counted, fake.evidence, fake.evidenceWhy], [true, 'without', UNSIGNED])
    const real = await received(tutor)
    assert.deepEqual([real.counted, real.evidence, real.evidenceWhy], [true, 'with', undefined])
    const d = (await twin<DealPage>(i, `/deals/${escrow}.json`)).body
    assert.deepEqual(d.profiles, { payer: [student.key.address], recipient: [tutor.key.address] }, 'the impostor is no side of the deal')
  } finally {
    await i.close()
    await rpc.close()
  }
})
