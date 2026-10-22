// What the loop funds and mints before anyone acts, and the two keys it takes from the phrase
// (chain.ts), checked with no chain: the recipe against PBKDF2 made by Web Crypto and the ed25519 key
// made by node:crypto, and each instruction decoded by the token program's own decoders.

import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { test } from 'node:test'

import * as escrow from '@foundationforest/escrow-client'
import { decodeMintToCheckedInstruction, decodeTransferCheckedInstruction } from '@solana/spl-token'
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type TransactionInstruction } from '@solana/web3.js'

import { DOLLAR, FUNDING, fundingFor, fundingIxs, keyFromPhrase, payReferenceIxs } from '../chain.ts'

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
  assert.ok(!keyFromPhrase(phrase, 'test-dollar-authority').publicKey.equals(made.publicKey), 'each label its own key')
})

/** The funding's instructions, decoded: each account made, each mint, each SOL transfer. */
function decoded(ixs: { accounts: TransactionInstruction[]; money: TransactionInstruction[] }) {
  const accounts = ixs.accounts.map((ix) => {
    assert.ok(ix.programId.equals(escrow.ASSOCIATED_TOKEN_PROGRAM_ID))
    assert.deepEqual([...ix.data], [1], 'made only if missing')
    return { payer: ix.keys[0]!.pubkey.toBase58(), account: ix.keys[1]!.pubkey.toBase58(), owner: ix.keys[2]!.pubkey.toBase58(), mint: ix.keys[3]!.pubkey.toBase58() }
  })
  const mints = ixs.money.filter((ix) => ix.programId.equals(token.program)).map((ix) => {
    const m = decodeMintToCheckedInstruction(ix, token.program)
    return { to: m.keys.destination.pubkey.toBase58(), authority: m.keys.authority.pubkey.toBase58(), mint: m.keys.mint.pubkey.toBase58(), units: m.data.amount, decimals: m.data.decimals }
  })
  const sol = ixs.money.filter((ix) => ix.programId.equals(SystemProgram.programId)).map((ix) => {
    const t = SystemInstruction.decodeTransfer(ix)
    return { from: t.fromPubkey.toBase58(), to: t.toPubkey.toBase58(), lamports: Number(t.lamports) }
  })
  assert.equal(mints.length + sol.length, ixs.money.length, 'nothing else moves')
  return { accounts, mints, sol }
}

test('with the loop’s own fee payer: each test-dollar account, the student’s dollars, each wallet’s dollar and SOL, and the fee payer’s SOL', () => {
  const [tutorPay, studentPay, w1, w2, feePayer, payer, authority] = [key(), key(), key(), key(), key(), key(), key()]
  const got = decoded(fundingIxs(fundingFor({ tutorPay, studentPay, wallets: [w1, w2], feePayer }), { payer, authority }, token))
  assert.deepEqual(
    got.accounts,
    [tutorPay, studentPay, w1, w2, feePayer].map((o) => ({ payer: payer.toBase58(), account: ata(o).toBase58(), owner: o.toBase58(), mint: token.mint.toBase58() })),
    'both pay addresses, both wallets and the fee payer, the deploy key paying',
  )
  assert.deepEqual(
    got.mints,
    [
      { to: ata(studentPay).toBase58(), units: 10n * DOLLAR },
      { to: ata(w1).toBase58(), units: DOLLAR },
      { to: ata(w2).toBase58(), units: DOLLAR },
    ].map((m) => ({ ...m, authority: authority.toBase58(), mint: token.mint.toBase58(), decimals: 6 })),
    'the test dollar’s authority mints: 10 to the student, 1 to each wallet; the tutor gets paid, not minted',
  )
  assert.deepEqual(got.sol, [
    { from: payer.toBase58(), to: w1.toBase58(), lamports: FUNDING.walletLamports },
    { from: payer.toBase58(), to: w2.toBase58(), lamports: FUNDING.walletLamports },
    { from: payer.toBase58(), to: feePayer.toBase58(), lamports: FUNDING.feePayerLamports },
  ])
})

test('with a deployed fee payer: nothing for it, which its operator funds', () => {
  const [tutorPay, studentPay, w1, w2, payer, authority] = [key(), key(), key(), key(), key(), key()]
  const got = decoded(fundingIxs(fundingFor({ tutorPay, studentPay, wallets: [w1, w2], feePayer: null }), { payer, authority }, token))
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
