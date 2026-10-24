// The loop's money on the chain: the two keys it takes from the phrase, what it funds and mints
// before two people can act, a plain transfer from a wallet app, a direct payment naming its post,
// a market's schedule as the escrow takes it, and a transaction sent through the fee payer at cost,
// as a person's app sends one. Nothing a profile does goes through the phrase's keys: they fund and
// mint only.

import { pbkdf2Sync } from 'node:crypto'

import * as escrow from '@foundationforest/escrow-client'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction } from '@solana/spl-token'
import { type Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

/**
 * A key from the phrase, by the recipe in the standard's `escrows/solana/devnet/deploy.sh`: the
 * phrase NFKD, trimmed, each run of whitespace one space; PBKDF2-HMAC-SHA256 over it with the salt
 * "forest-devnet:" + label, 600,000 rounds, 32 bytes; the ed25519 key with that seed.
 */
export function keyFromPhrase(phrase: string, label: string): Keypair {
  const normal = phrase.normalize('NFKD').trim().split(/\s+/).join(' ')
  return Keypair.fromSeed(pbkdf2Sync(Buffer.from(normal, 'utf8'), Buffer.from(`forest-devnet:${label}`, 'utf8'), 600_000, 32, 'sha256'))
}

/** One whole test dollar, in base units: it has six decimals. */
export const DOLLAR = 1_000_000n

/** Decimal text in whole units, such as "2" or "0.1", in base units of a token with `decimals`; more places than that are refused. */
export function unitsOf(amount: string, decimals: number): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount)
  if (!m || (m[2] ?? '').length > decimals) throw new Error(`${amount} is not an amount of a token with ${decimals} decimals`)
  return BigInt(m[1]! + (m[2] ?? '').padEnd(decimals, '0'))
}

/** Solana's Memo program: it moves nothing, and writes its data to the transaction's log. */
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * A direct payment, as the markets manual's Direct paragraph has it: a plain transfer of `units`
 * from `from`'s token account to `to`'s, with a memo naming the post. The memo names no signer,
 * so it adds no signature to pay for.
 */
export function directPaymentIxs(p: { from: PublicKey; to: PublicKey; units: bigint; memo: string; token: escrow.Token }): TransactionInstruction[] {
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, p.token.mint, p.token.program)
  return [
    escrow.transferIx({ from: ata(p.from), to: ata(p.to), owner: p.from, mint: p.token.mint, amount: p.units, decimals: p.token.decimals, tokenProgram: p.token.program }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(p.memo, 'utf8') }),
  ]
}

/** A market's schedule, as its file writes it (the markets manual, Payment): windows relative to the deal. */
export type Template = { windows: { from: string; offset: string; payerShare: number }[]; end: 'pay' | 'refund'; arbiter: boolean }

/**
 * A market's schedule as the escrow takes it, for money that goes in at `paidAt` (unix seconds):
 * each window's `until`, its `offset` in hours or days after or before the payment. The loop's deal
 * names no start or end of its own, so a window from `dealStart` or `dealEnd` is refused, and so is
 * a schedule with an arbiter: the loop names none.
 */
export function scheduleOf(template: Template, paidAt: number): { windows: { until: number; payerShare: number }[]; end: 'pay' | 'refund' } {
  if (template.arbiter) throw new Error('this schedule names an arbiter, and the loop names none')
  const windows = template.windows.map((w) => {
    const m = /^([+-])([0-9]+)([hd])$/.exec(w.offset)
    if (w.from !== 'payment' || !m) throw new Error(`a window from ${w.from} at ${w.offset}: the loop takes only windows from payment, offset in hours or days`)
    return { until: paidAt + (m[1] === '-' ? -1 : 1) * Number(m[2]) * (m[3] === 'h' ? 3600 : 86_400), payerShare: w.payerShare }
  })
  return { windows, end: template.end }
}

/** What the loop gives before anyone acts. */
export const FUNDING = {
  /** To the student's pay address: two payments of 2 and the fee payer's charges, about 4. */
  studentDollars: 10n * DOLLAR,
  /** To each wallet app's address: ten host credits at a cent each, and more. */
  walletDollars: DOLLAR,
  /** To each wallet app's address: its fees for buying credits. */
  walletLamports: 10_000_000,
  /** To the loop's own fee payer: the deposits it fronts, about 0.004 SOL an escrow, and fees. */
  feePayerLamports: 50_000_000,
} as const

/** Who the loop funds: each one's test-dollar account, then dollars and SOL. */
export type Funding = { accounts: PublicKey[]; dollars: { owner: PublicKey; units: bigint }[]; lamports: { to: PublicKey; lamports: number }[] }

/**
 * What the loop funds: a test-dollar account for both pay addresses and each wallet; the student's
 * dollars; each wallet's dollar and SOL; and, when the fee payer is the loop's own, its test-dollar
 * account, where it is paid, and its SOL. A deployed fee payer is its operator's to fund.
 */
export function fundingFor(p: { tutorPay: PublicKey; studentPay: PublicKey; wallets: PublicKey[]; feePayer: PublicKey | null }): Funding {
  return {
    accounts: [p.tutorPay, p.studentPay, ...p.wallets, ...(p.feePayer ? [p.feePayer] : [])],
    dollars: [{ owner: p.studentPay, units: FUNDING.studentDollars }, ...p.wallets.map((owner) => ({ owner, units: FUNDING.walletDollars }))],
    lamports: [...p.wallets.map((to) => ({ to, lamports: FUNDING.walletLamports })), ...(p.feePayer ? [{ to: p.feePayer, lamports: FUNDING.feePayerLamports }] : [])],
  }
}

/**
 * The funding as two transactions' instructions: the accounts, which `payer` pays the rent of; then
 * the dollars, which `authority` mints, and the SOL, which `payer` sends. Two, so each fits.
 */
export function fundingIxs(f: Funding, keys: { payer: PublicKey; authority: PublicKey }, token: escrow.Token): { accounts: TransactionInstruction[]; money: TransactionInstruction[] } {
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
  return {
    accounts: f.accounts.map((owner) => createAssociatedTokenAccountIdempotentInstruction(keys.payer, ata(owner), owner, token.mint, token.program)),
    money: [
      ...f.dollars.map((d) => createMintToCheckedInstruction(token.mint, ata(d.owner), keys.authority, d.units, token.decimals, [], token.program)),
      ...f.lamports.map((l) => SystemProgram.transfer({ fromPubkey: keys.payer, toPubkey: l.to, lamports: l.lamports })),
    ],
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits until the transaction is confirmed; throws if it failed or never lands. Polls, so no websocket keeps Node alive. */
export async function confirm(connection: Connection, signature: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await sleep(500)
  }
  throw new Error(`${signature} was never confirmed`)
}

/** A plain transaction, paid by the first signer, sent and confirmed. */
export async function send(connection: Connection, instructions: TransactionInstruction[], signers: Keypair[]): Promise<{ signature: string; bytes: number }> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0]!.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const wire = tx.serialize()
  const signature = await connection.sendRawTransaction(wire)
  await confirm(connection, signature)
  return { signature, bytes: wire.length }
}

/**
 * What a wallet app sends to pay a credit buy: a plain transfer of `units` from its own address to
 * the service's, with the buy's reference as one more account, as Solana Pay does. It makes the
 * service's test-dollar account first if it is missing, and pays its own fee.
 */
export function payReferenceIxs(p: { from: PublicKey; to: PublicKey; reference: string; units: bigint; token: escrow.Token }): TransactionInstruction[] {
  const into = escrow.associatedTokenAddress(p.to, p.token.mint, p.token.program)
  const transfer = escrow.transferIx({ from: escrow.associatedTokenAddress(p.from, p.token.mint, p.token.program), to: into, owner: p.from, mint: p.token.mint, amount: p.units, decimals: p.token.decimals, tokenProgram: p.token.program })
  transfer.keys.push({ pubkey: new PublicKey(p.reference), isSigner: false, isWritable: false })
  return [createAssociatedTokenAccountIdempotentInstruction(p.from, into, p.to, p.token.mint, p.token.program), transfer]
}

/** Kora refused, in its words. */
export class KoraError extends Error {}

/** Kora's JSON-RPC at the fee payer's address. */
export async function kora<T>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } }
  if (body.error) throw new KoraError(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

/** A transaction sent through the fee payer: its signature, what the person paid it in base units, and its size. */
export type Paid = { signature: string; charge: string; bytes: number }

/**
 * What a person's app does to send through the fee payer at cost (fee-payer/README.md, Paying at
 * cost): the transaction with the fee payer as payer and a dollar transfer to it already in place,
 * since Kora's price counts its signature; the price asked; the transfer set to exactly that; the
 * person's key signs; Kora checks, co-signs and sends.
 */
export async function throughFeePayer(connection: Connection, url: string, signer: Keypair, instructions: TransactionInstruction[], token: escrow.Token): Promise<Paid> {
  const payer = await kora<{ signer_address: string; payment_address: string }>(url, 'getPayerSigner')
  const feePayer = new PublicKey(payer.signer_address)
  const paymentTo = escrow.associatedTokenAddress(new PublicKey(payer.payment_address), token.mint, token.program)
  const from = escrow.associatedTokenAddress(signer.publicKey, token.mint, token.program)
  const pay = (amount: bigint) => escrow.transferIx({ from, to: paymentTo, owner: signer.publicKey, mint: token.mint, amount, decimals: token.decimals, tokenProgram: token.program })
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const compile = (ixs: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  const estimate = await kora<{ fee_in_token: number | null }>(url, 'estimateTransactionFee', {
    transaction: Buffer.from(compile([...instructions, pay(0n)]).serialize()).toString('base64'),
    fee_token: token.mint.toBase58(),
    sig_verify: false,
  })
  if (estimate.fee_in_token === null) throw new KoraError('the fee payer quotes no price in this dollar')
  const charge = BigInt(estimate.fee_in_token)
  const tx = compile([...instructions, pay(charge)])
  tx.sign([signer])
  const wire = tx.serialize()
  const { signature } = await kora<{ signature: string }>(url, 'signAndSendTransaction', { transaction: Buffer.from(wire).toString('base64') })
  await confirm(connection, signature)
  return { signature, charge: charge.toString(), bytes: wire.length }
}
