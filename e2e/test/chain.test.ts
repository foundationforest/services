// What the loop funds before anyone acts and sweeps back from its own fee payer, the key it takes
// from the phrase, and the direct payment (chain.ts), checked with no chain: the recipe against
// PBKDF2 made by Web Crypto and the ed25519 key made by node:crypto, and each instruction decoded by
// the token program's own decoders.

import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { test } from 'node:test'

import * as escrow from '@foundationforest/escrow-client'
import { decodeCloseAccountInstruction, decodeTransferCheckedInstruction } from '@solana/spl-token'
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type TransactionInstruction } from '@solana/web3.js'

import { DOLLAR, FUNDING, directPaymentIxs, dollarsOf, fundingFor, fundingIxs, keyFromPhrase, payReferenceIxs, sweepIxs, unitsOf } from '../chain.ts'

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
      { to: ata(studentPay).toBase58(), units: 3n * DOLLAR },
      { to: ata(w1).toBase58(), units: DOLLAR },
      { to: ata(w2).toBase58(), units: DOLLAR },
    ].map((m) => ({ from: ata(payer).toBase58(), ...m, owner: payer.toBase58(), mint: token.mint.toBase58(), decimals: 6 })),
    'plain transfers from the deploy key’s own dollars: 3 to the student, 1 to each wallet; the tutor gets paid, not funded; nothing minted',
  )
  assert.equal(dollarsOf(plan), 5n * DOLLAR, 'a run moves 5 dollars')
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

test('the sweep: all the fee payer’s dollars, its dollar account closed, then all its SOL, each back to the deploy key', () => {
  const [from, to] = [key(), key()]
  const [move, close, sol] = sweepIxs({ from, to, dollars: 37_536_400n, lamports: 46_255_640, token })
  const t = decodeTransferCheckedInstruction(move!, token.program)
  assert.deepEqual([t.keys.source.pubkey, t.keys.destination.pubkey, t.keys.owner.pubkey].map((k) => k.toBase58()), [ata(from), ata(to), from].map((k) => k.toBase58()))
  assert.deepEqual([t.data.amount, t.data.decimals], [37_536_400n, 6], 'every dollar')
  const c = decodeCloseAccountInstruction(close!, token.program)
  assert.deepEqual([c.keys.account.pubkey, c.keys.destination.pubkey, c.keys.authority.pubkey].map((k) => k.toBase58()), [ata(from), to, from].map((k) => k.toBase58()), 'its rent to the deploy key')
  const s = SystemInstruction.decodeTransfer(sol!)
  assert.deepEqual([s.fromPubkey.toBase58(), s.toPubkey.toBase58(), Number(s.lamports)], [from.toBase58(), to.toBase58(), 46_255_640], 'every lamport')
  assert.deepEqual(sweepIxs({ from, to, dollars: 0n, lamports: 0, token }).map((ix) => ix.programId.toBase58()), [token.program.toBase58()], 'an empty dollar account is still closed')
  assert.deepEqual(sweepIxs({ from, to, dollars: null, lamports: 5000, token }).map((ix) => ix.programId.toBase58()), [SystemProgram.programId.toBase58()], 'no dollar account: only the SOL')
  assert.deepEqual(sweepIxs({ from, to, dollars: null, lamports: 0, token }), [], 'nothing held, nothing sent')
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
