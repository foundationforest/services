// The loop's money on the chain: the key it takes from the phrase, what it funds before two people
// can act and sweeps back from its own fee payer when the run ends, a plain transfer from a wallet
// app, a direct payment, and a transaction sent through the fee payer at cost, as a person's app
// sends one. The dollar is Circle's USDC on the loop's
// chain, which the phrase's deploy key holds, filled from Circle's faucet; the loop mints nothing.
// Nothing a profile does goes through the phrase's key: it funds, and takes back.

import { pbkdf2Sync } from 'node:crypto'

import * as escrow from '@foundationforest/escrow-client'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { type Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

/**
 * A key from the phrase, by the recipe in the standard's `escrows/solana/devnet/deploy.sh`: the
 * phrase NFKD, trimmed, each run of whitespace one space; PBKDF2-HMAC-SHA256 over it with the salt
 * "forest-devnet:" + label, 600,000 rounds, 32 bytes; the ed25519 key with that seed.
 */
export function keyFromPhrase(phrase: string, label: string): Keypair {
  const normal = phrase.normalize('NFKD').trim().split(/\s+/).join(' ')
  return Keypair.fromSeed(pbkdf2Sync(Buffer.from(normal, 'utf8'), Buffer.from(`forest-devnet:${label}`, 'utf8'), 600_000, 32, 'sha256'))
}

/** One whole dollar, in base units: USDC has six decimals. */
export const DOLLAR = 1_000_000n

/** Decimal text in whole units, such as "2" or "0.1", in base units of a token with `decimals`; more places than that are refused. */
export function unitsOf(amount: string, decimals: number): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount)
  if (!m || (m[2] ?? '').length > decimals) throw new Error(`${amount} is not an amount of a token with ${decimals} decimals`)
  return BigInt(m[1]! + (m[2] ?? '').padEnd(decimals, '0'))
}

/** A direct payment: a plain transfer of `units` from `from`'s token account to `to`'s. */
export function directPaymentIxs(p: { from: PublicKey; to: PublicKey; units: bigint; token: escrow.Token }): TransactionInstruction[] {
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, p.token.mint, p.token.program)
  return [escrow.transferIx({ from: ata(p.from), to: ata(p.to), owner: p.from, mint: p.token.mint, amount: p.units, decimals: p.token.decimals, tokenProgram: p.token.program })]
}

/** What the loop gives before anyone acts: 5 dollars in all, and SOL. */
export const FUNDING = {
  /**
   * To the student's pay address: its payment of 2 and the fee payer's charge for it, 0.10 at
   * Kora's mock price of ten base units a lamport (fee-payer/README.md), with room for that price
   * to move.
   */
  studentDollars: 3n * DOLLAR,
  /** To each wallet app's address: ten host credits at a cent each, and more. */
  walletDollars: DOLLAR,
  /** To each wallet app's address: its fees for buying credits. */
  walletLamports: 10_000_000,
  /** To the loop's own fee payer: the fees it pays, swept back when the run ends. */
  feePayerLamports: 50_000_000,
} as const

/** Who the loop funds: each one's dollar account, then dollars and SOL. */
export type Funding = { accounts: PublicKey[]; dollars: { owner: PublicKey; units: bigint }[]; lamports: { to: PublicKey; lamports: number }[] }

/**
 * What the loop funds: a dollar account for both pay addresses and each wallet; the student's
 * dollars; each wallet's dollar and SOL; and, when the fee payer is the loop's own, its dollar
 * account, where it is paid, and its SOL. A deployed fee payer is its operator's to fund.
 */
export function fundingFor(p: { tutorPay: PublicKey; studentPay: PublicKey; wallets: PublicKey[]; feePayer: PublicKey | null }): Funding {
  return {
    accounts: [p.tutorPay, p.studentPay, ...p.wallets, ...(p.feePayer ? [p.feePayer] : [])],
    dollars: [{ owner: p.studentPay, units: FUNDING.studentDollars }, ...p.wallets.map((owner) => ({ owner, units: FUNDING.walletDollars }))],
    lamports: [...p.wallets.map((to) => ({ to, lamports: FUNDING.walletLamports })), ...(p.feePayer ? [{ to: p.feePayer, lamports: FUNDING.feePayerLamports }] : [])],
  }
}

/** How many base units of the dollar the funding moves, all from the payer's own account. */
export const dollarsOf = (f: Funding): bigint => f.dollars.reduce((sum, d) => sum + d.units, 0n)

/**
 * The funding as two transactions' instructions, all by `payer`: the accounts, which it pays the rent
 * of; then the dollars, each a plain transfer from its own dollar account, and the SOL. Two, so each
 * fits.
 */
export function fundingIxs(f: Funding, payer: PublicKey, token: escrow.Token): { accounts: TransactionInstruction[]; money: TransactionInstruction[] } {
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
  return {
    accounts: f.accounts.map((owner) => createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner), owner, token.mint, token.program)),
    money: [
      ...f.dollars.map((d) => escrow.transferIx({ from: ata(payer), to: ata(d.owner), owner: payer, mint: token.mint, amount: d.units, decimals: token.decimals, tokenProgram: token.program })),
      ...f.lamports.map((l) => SystemProgram.transfer({ fromPubkey: payer, toPubkey: l.to, lamports: l.lamports })),
    ],
  }
}

/**
 * What the loop's own fee payer `from` holds when the run ends, swept back to the deploy key `to`,
 * which gave it: all its `dollars`, its dollar account closed with that account's rent, then all its
 * `lamports`. `dollars` is null when it has no dollar account. Sent with `to` as payer, so nothing is
 * left on `from`.
 */
export function sweepIxs(p: { from: PublicKey; to: PublicKey; dollars: bigint | null; lamports: number; token: escrow.Token }): TransactionInstruction[] {
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, p.token.mint, p.token.program)
  const dollars =
    p.dollars === null
      ? []
      : [
          ...(p.dollars > 0n ? [escrow.transferIx({ from: ata(p.from), to: ata(p.to), owner: p.from, mint: p.token.mint, amount: p.dollars, decimals: p.token.decimals, tokenProgram: p.token.program })] : []),
          createCloseAccountInstruction(ata(p.from), p.to, p.from, [], p.token.program),
        ]
  return [...dollars, ...(p.lamports > 0 ? [SystemProgram.transfer({ fromPubkey: p.from, toPubkey: p.to, lamports: p.lamports })] : [])]
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
 * service's dollar account first if it is missing, and pays its own fee.
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
