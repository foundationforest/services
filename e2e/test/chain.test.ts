// What the loop funds before anyone acts, the key it takes from the phrase, the direct payment and
// the market's schedule (chain.ts), checked with no chain: the recipe against PBKDF2 made by Web
// Crypto and the ed25519 key made by node:crypto, each instruction decoded by the token program's
// own decoders, and the schedule from the market file at MARKETS, as the escrow's client takes it.

import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as escrow from '@foundationforest/escrow-client'
import { decodeTransferCheckedInstruction } from '@solana/spl-token'
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type TransactionInstruction } from '@solana/web3.js'

import { DOLLAR, FUNDING, type Template, directPaymentIxs, dollarsOf, fundingFor, fundingIxs, keyFromPhrase, payReferenceIxs, scheduleOf, unitsOf } from '../chain.ts'

const token: escrow.Token = { mint: new PublicKey('J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'), program: escrow.TOKEN_PROGRAM_ID, decimals: 6 }
const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
const key = () => Keypair.generate().publicKey

test('a key from the phrase: PBKDF2-HMAC-SHA256 under forest-devnet:<label>, 600,000 rounds, as an ed25519 seed', async () => {
  const phrase = 'one two three café'
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('forest-devnet:deploy'), iterations: 600_000 },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']),
    256,
  )
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(bits)])
  const pub = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
  const made = keyFromPhrase(phrase, 'deploy')
  assert.deepEqual(Buffer.from(made.publicKey.toBytes()), pub)
  assert.ok(keyFromPhrase('  one   two\nthree café ', 'deploy').publicKey.equals(made.publicKey), 'spacing and composed or decomposed letters do not matter')
  assert.ok(!keyFromPhrase(phrase, 'payer').publicKey.equals(made.publicKey), 'each label its own key')
})

/** The funding's instructions, decoded: each account made, each dollar transfer, each SOL transfer. */
function decoded(ixs: { accounts: TransactionInstruction[]; money: TransactionInstruction[] }) {
  const accounts = ixs.accounts.map((ix) => {
    assert.ok(ix.programId.equals(escrow.ASSOCIATED_TOKEN_PROGRAM_ID))
    assert.deepEqual([...ix.data], [1], 'made only if missing')
    return { payer: ix.keys[0]!.pubkey.toBase58(), account: ix.keys[1]!.pubkey.toBase58(), owner: ix.keys[2]!.pubkey.toBase58(), mint: ix.keys[3]!.pubkey.toBase58() }
  })
  const dollars = ixs.money.filter((ix) => ix.programId.equals(token.program)).map((ix) => {
    const t = decodeTransferCheckedInstruction(ix, token.program)
    return { from: t.keys.source.pubkey.toBase58(), to: t.keys.destination.pubkey.toBase58(), owner: t.keys.owner.pubkey.toBase58(), mint: t.keys.mint.pubkey.toBase58(), units: t.data.amount, decimals: t.data.decimals }
  })
  const sol = ixs.money.filter((ix) => ix.programId.equals(SystemProgram.programId)).map((ix) => {
    const t = SystemInstruction.decodeTransfer(ix)
    return { from: t.fromPubkey.toBase58(), to: t.toPubkey.toBase58(), lamports: Number(t.lamports) }
  })
  assert.equal(dollars.length + sol.length, ixs.money.length, 'nothing else moves')
  return { accounts, dollars, sol }
}

test('with the loop’s own fee payer: each dollar account, the student’s dollars, each wallet’s dollar and SOL, and the fee payer’s SOL, all from the deploy key', () => {
  const [tutorPay, studentPay, w1, w2, feePayer, payer] = [key(), key(), key(), key(), key(), key()]
  const plan = fundingFor({ tutorPay, studentPay, wallets: [w1, w2], feePayer })
  const got = decoded(fundingIxs(plan, payer, token))
  assert.deepEqual(
    got.accounts,
    [tutorPay, studentPay, w1, w2, feePayer].map((o) => ({ payer: payer.toBase58(), account: ata(o).toBase58(), owner: o.toBase58(), mint: token.mint.toBase58() })),
    'both pay addresses, both wallets and the fee payer, the deploy key paying',
  )
  assert.deepEqual(
    got.dollars,
    [
      { to: ata(studentPay).toBase58(), units: 42n * DOLLAR },
      { to: ata(w1).toBase58(), units: DOLLAR },
      { to: ata(w2).toBase58(), units: DOLLAR },
    ].map((m) => ({ from: ata(payer).toBase58(), ...m, owner: payer.toBase58(), mint: token.mint.toBase58(), decimals: 6 })),
    'plain transfers from the deploy key’s own dollars: 42 to the student, 1 to each wallet; the tutor gets paid, not funded; nothing minted',
  )
  assert.equal(dollarsOf(plan), 44n * DOLLAR, 'a run moves 44 dollars')
  assert.deepEqual(got.sol, [
    { from: payer.toBase58(), to: w1.toBase58(), lamports: FUNDING.walletLamports },
    { from: payer.toBase58(), to: w2.toBase58(), lamports: FUNDING.walletLamports },
    { from: payer.toBase58(), to: feePayer.toBase58(), lamports: FUNDING.feePayerLamports },
  ])
})

test('with a deployed fee payer: nothing for it, which its operator funds', () => {
  const [tutorPay, studentPay, w1, w2, payer] = [key(), key(), key(), key(), key()]
  const got = decoded(fundingIxs(fundingFor({ tutorPay, studentPay, wallets: [w1, w2], feePayer: null }), payer, token))
  assert.deepEqual(got.accounts.map((a) => a.owner), [tutorPay, studentPay, w1, w2].map((k) => k.toBase58()))
  assert.deepEqual(got.sol.map((s) => s.to), [w1, w2].map((k) => k.toBase58()))
})

test('a credit buy paid from a wallet: the service’s account made if missing, then the transfer naming the buy’s reference', () => {
  const [from, to] = [key(), key()]
  const reference = key().toBase58()
  const [make, transfer] = payReferenceIxs({ from, to, reference, units: 100_000n, token })
  assert.ok(make!.programId.equals(escrow.ASSOCIATED_TOKEN_PROGRAM_ID) && make!.keys[0]!.pubkey.equals(from) && make!.keys[2]!.pubkey.equals(to), 'the wallet pays to make it')
  const t = decodeTransferCheckedInstruction({ ...transfer!, keys: transfer!.keys.slice(0, 4) }, token.program)
  assert.deepEqual([t.keys.source.pubkey, t.keys.destination.pubkey, t.keys.owner.pubkey].map((k) => k.toBase58()), [ata(from), ata(to), from].map((k) => k.toBase58()))
  assert.deepEqual([t.data.amount, t.data.decimals], [100_000n, 6])
  assert.deepEqual(transfer!.keys.at(-1), { pubkey: new PublicKey(reference), isSigner: false, isWritable: false }, 'the reference, as one more account')
})

test('a direct payment: one plain transfer, and nothing else', () => {
  const [from, to] = [key(), key()]
  const ixs = directPaymentIxs({ from, to, units: 2n * DOLLAR, token })
  assert.equal(ixs.length, 1)
  const t = decodeTransferCheckedInstruction(ixs[0]!, token.program)
  assert.deepEqual([t.keys.source.pubkey, t.keys.destination.pubkey, t.keys.owner.pubkey].map((k) => k.toBase58()), [ata(from), ata(to), from].map((k) => k.toBase58()))
  assert.deepEqual([t.data.amount, t.data.decimals], [2n * DOLLAR, 6])
})

test('dollars as base units: whole and decimal text, never more places than the token has', () => {
  assert.equal(unitsOf('2', 6), 2_000_000n)
  assert.equal(unitsOf('0.1', 6), 100_000n)
  assert.equal(unitsOf('12.000001', 6), 12_000_001n)
  for (const bad of ['0.0000001', '-1', '1e3', '01', '', '2.']) assert.throws(() => unitsOf(bad, 6), /not an amount/, bad)
})

test("the market's session schedule as the escrow takes it: one window, seven days from payment, then pay", () => {
  const tutoring = JSON.parse(readFileSync(new URL('../../markets/markets/tutoring.json', import.meta.url), 'utf8')) as { payment: { session: Template } }
  const paidAt = 1_790_000_000
  const schedule = scheduleOf(tutoring.payment.session, paidAt)
  assert.deepEqual(schedule, { windows: [{ until: paidAt + 7 * 86_400, payerShare: 0 }], end: 'pay' })
  const terms = escrow.termsFor({ schedule }, { recipient: key(), amount: 2n * DOLLAR })
  assert.deepEqual(terms.schedule, { windows: [{ until: BigInt(paidAt + 7 * 86_400), payerShare: 0 }], end: 'pay' }, 'the escrow client takes it')
  assert.equal(terms.arbiter, null)
  assert.deepEqual(scheduleOf({ windows: [{ from: 'payment', offset: '-24h', payerShare: 10_000 }], end: 'refund', arbiter: false }, paidAt).windows, [{ until: paidAt - 86_400, payerShare: 10_000 }])
  assert.throws(() => scheduleOf({ windows: [{ from: 'dealStart', offset: '-24h', payerShare: 10_000 }], end: 'pay', arbiter: false }, paidAt), /only windows from payment/)
  assert.throws(() => scheduleOf({ windows: [{ from: 'payment', offset: '+3w', payerShare: 0 }], end: 'pay', arbiter: false }, paidAt), /hours or days/)
  assert.throws(() => scheduleOf({ ...tutoring.payment.session, arbiter: true }, paidAt), /arbiter/)
})
