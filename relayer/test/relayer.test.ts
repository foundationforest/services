// The fee payer, run locally: Kora (installed by ../build.sh, started by ../run.sh) in front of a
// local validator with both Forest programs loaded. A wallet that holds no SOL registers once,
// pays for two escrows and closes a third it never funded, paying for everything in a test dollar;
// each storage deposit is charged to it once, and every one that comes back comes back to it. Kora
// refuses what it must refuse.
//
//   npm run test:local
//
// Needs `solana-test-validator` on the PATH, both programs built (`cargo build-sbf` in
// registry/program and in escrow/program), the registry's proving files (`npm run fetch` in
// registry/artifacts), both clients' dependencies (`npm ci` in registry/client and escrow/client)
// and Kora (`./build.sh`). If any is missing the test says which and skips.
//
// The test dollar is a six-decimal mint planted at USDC's address, because that is the address the
// registry charges its 0.25 in and the one kora.toml accepts payment in. Kora runs on a copy of
// kora.toml with one line changed: prices from Kora's own mock ("Mock") instead of Jupiter. The mock
// values any mint but two at 0.001 SOL per whole token, so here one base unit of the test dollar
// buys one lamport. The rules are the file's own.
//
// Everything here polls `getSignatureStatuses` rather than calling `confirmTransaction`, which
// opens a websocket subscription that keeps Node alive long after the test has passed.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import {
  FOUNDATION_ISSUER_PLACEHOLDER_SEED,
  PROGRAM_ID as REGISTRY_ID,
  TREASURY_PLACEHOLDER_SEED,
  USDC_FEE,
  USDC_MINT,
  buildRegistration,
  commitmentOf,
  initIx,
  insertIdentityIx,
  usedCodeAddress,
} from '../../registry/client/src/index.ts'
import {
  PROGRAM_ID as ESCROW_ID,
  closeUnfundedIx,
  createAndFund,
  decodeEscrow,
  keysFor,
  payInOneTap,
  releaseToSellerIx,
  sweepRentIx,
  termsFor,
} from '../../escrow/client/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const registrySo = join(root, 'registry/program/target/deploy/forest_registry.so')
const escrowSo = join(root, 'escrow/program/target/deploy/forest_escrow.so')
const artifacts = {
  wasm: join(root, 'registry/artifacts/semaphore-32.wasm'),
  zkey: join(root, 'registry/artifacts/semaphore-32.zkey'),
}
const kora = join(here, '../.kora/bin/kora')
const RPC = 'http://127.0.0.1:8899'
const KORA_PORT = 8080
const KORA_URL = `http://127.0.0.1:${KORA_PORT}`
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MARKET = 'online-tutors'
const DID = 'did:plc:wece24yzukt4pj6hqvmb2fn4'
const START_DOLLARS = 100_000_000n

// Made before the validator starts: it is the planted test dollar's mint authority, and it pays for
// everything that is not the person's (the programs' setup, the token accounts the person already
// holds when this starts, the fee payer's first SOL).
const setup = Keypair.generate()
// The fee payer's own key. Written to a file outside the repo; Kora reads the file's path from
// FOREST_FEEPAYER_KEY.
const feePayer = Keypair.generate()
// The person: one wallet, never given a lamport.
const person = Keypair.generate()
const seller = Keypair.generate()
const treasury = Keypair.fromSeed(TREASURY_PLACEHOLDER_SEED)
const issuer = Keypair.fromSeed(FOUNDATION_ISSUER_PLACEHOLDER_SEED)

const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(USDC_MINT, owner)
const personTokens = ata(person.publicKey)
const feePayerTokens = ata(feePayer.publicKey)
const sellerTokens = ata(seller.publicKey)
const treasuryTokens = ata(treasury.publicKey)

function missing(): string | null {
  if (!existsSync(registrySo)) return `no program at ${registrySo}; run \`cargo build-sbf\` in registry/program`
  if (!existsSync(escrowSo)) return `no program at ${escrowSo}; run \`cargo build-sbf\` in escrow/program`
  if (!existsSync(artifacts.zkey)) return 'no proving files; run `npm run fetch` in registry/artifacts'
  if (!existsSync(join(root, 'registry/client/node_modules'))) return 'run `npm ci` in registry/client'
  if (!existsSync(join(root, 'escrow/client/node_modules'))) return 'run `npm ci` in escrow/client'
  if (!existsSync(kora)) return 'no Kora; run ./build.sh in feepayer'
  return null
}

/** A classic SPL Token mint in the validator's `--account` JSON form: six decimals, authority `setup`. */
function testDollarJson(): string {
  const data = Buffer.alloc(MINT_SIZE)
  data.writeUInt32LE(1, 0) // mint_authority: Some
  setup.publicKey.toBuffer().copy(data, 4)
  data.writeBigUInt64LE(0n, 36) // supply
  data[44] = 6 // decimals
  data[45] = 1 // is_initialized
  return JSON.stringify({
    pubkey: USDC_MINT.toBase58(),
    account: {
      lamports: 1_461_600,
      data: [data.toString('base64'), 'base64'],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: MINT_SIZE,
    },
  })
}

let validator: ChildProcess | undefined
let koraProcess: ChildProcess | undefined
let work: string | undefined
let ledger: string | undefined
let connection: Connection
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

async function confirm(signature: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return
    await sleep(250)
  }
  throw new Error(`${signature} was never confirmed`)
}

/** Setup only: `setup` pays. Nothing the person does goes through here. */
async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  return signature
}

class KoraError extends Error {}

/** One JSON-RPC call to Kora, as a product's page would make it. */
async function koraCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(KORA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } }
  if (body.error) throw new KoraError(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

type Estimate = { fee_in_lamports: number; fee_in_token: number | null; signer_pubkey: string; payment_address: string }

function compile(instructions: TransactionInstruction[], blockhash: string): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  )
}

/** The payment: a plain token transfer from the person to the fee payer, of what Kora quoted. */
const payment = (amount: bigint) => createTransferInstruction(personTokens, feePayerTokens, person.publicKey, amount)

type Paid = { signature: string; estimate: Estimate; charge: bigint; wire: number; networkFee: number; units: number }

/**
 * What a person's device does: build the transaction with the fee payer as its payer, ask Kora
 * what it costs in the dollar token, add one transfer of exactly that, sign with the person's
 * keys, and hand it to Kora, which checks it, co-signs and sends it. `shortBy` pays less than the
 * quote, to see Kora refuse.
 */
async function throughKora(instructions: TransactionInstruction[], shortBy = 0n): Promise<Paid> {
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const estimate = await koraCall<Estimate>('estimateTransactionFee', {
    transaction: b64(compile(instructions, blockhash).serialize()),
    fee_token: USDC_MINT.toBase58(),
    sig_verify: false,
  })
  assert.ok(estimate.fee_in_token !== null, 'Kora quotes in the dollar token')
  const charge = BigInt(estimate.fee_in_token) - shortBy
  const paid = compile([...instructions, payment(charge)], blockhash)
  paid.sign([person])
  const wire = paid.serialize()
  const { signature } = await koraCall<{ signature: string }>('signAndSendTransaction', { transaction: b64(wire) })
  await confirm(signature)
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  assert.ok(tx?.meta, 'it landed')
  return { signature, estimate, charge, wire: wire.length, networkFee: tx.meta.fee, units: tx.meta.computeUnitsConsumed ?? 0 }
}

/** Kora must refuse these before signing: nothing lands, and nothing moves. */
async function refused(instructions: TransactionInstruction[], pay: bigint, pattern: RegExp): Promise<string> {
  const before = await balances()
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const tx = compile(pay > 0n ? [...instructions, payment(pay)] : instructions, blockhash)
  tx.sign([person])
  let message = ''
  await assert.rejects(
    koraCall('signAndSendTransaction', { transaction: b64(tx.serialize()) }),
    (err: Error) => {
      message = err.message
      return err instanceof KoraError && pattern.test(err.message)
    },
  )
  assert.deepEqual(await balances(), before, 'nothing moved')
  return message
}

async function balances() {
  return {
    personSol: await connection.getBalance(person.publicKey),
    personTokens: (await getAccount(connection, personTokens)).amount,
    feePayerSol: await connection.getBalance(feePayer.publicKey),
    feePayerTokens: (await getAccount(connection, feePayerTokens)).amount,
  }
}

const koraLog: string[] = []

before(
  async () => {
    if (missing()) return
    work = mkdtempSync(join(tmpdir(), 'forest-feepayer-'))
    ledger = join(work, 'ledger')
    const dollarJson = join(work, 'test-dollar.json')
    writeFileSync(dollarJson, testDollarJson())
    validator = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledger,
        '--bpf-program', REGISTRY_ID.toBase58(), registrySo,
        '--bpf-program', ESCROW_ID.toBase58(), escrowSo,
        '--account', USDC_MINT.toBase58(), dollarJson,
      ],
      { stdio: 'ignore' },
    )
    validator.on('error', () => {
      validator = undefined
    })
    connection = new Connection(RPC, 'confirmed')
    for (let i = 0; i < 90 && validator; i++) {
      try {
        await connection.getVersion()
        break
      } catch {
        await sleep(1000)
      }
    }
    if (!validator) return

    // The fee payer's key: a file outside the repo, read by Kora through FOREST_FEEPAYER_KEY.
    const keyFile = join(work, 'fee-payer.json')
    writeFileSync(keyFile, JSON.stringify(Array.from(feePayer.secretKey)), { mode: 0o600 })
    // kora.toml with one line changed, checked to appear exactly once.
    const config = readFileSync(join(here, '../kora.toml'), 'utf8')
    const line = 'price_source = "Jupiter"'
    assert.equal(config.split(line).length - 1, 1, `kora.toml has exactly one ${line}`)
    const mockConfig = join(work, 'kora.toml')
    writeFileSync(mockConfig, config.replace(line, 'price_source = "Mock"'))

    const log = createWriteStream(join(work, 'kora.log'))
    koraProcess = spawn('bash', [join(here, '../run.sh')], {
      env: { ...process.env, FOREST_FEEPAYER_KEY: keyFile, RPC_URL: RPC, KORA_CONFIG: mockConfig, PORT: String(KORA_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [koraProcess.stdout!, koraProcess.stderr!]) {
      stream.on('data', (chunk: Buffer) => {
        log.write(chunk)
        koraLog.push(chunk.toString())
      })
    }
    koraProcess.on('exit', () => {
      koraProcess = undefined
    })
    for (let i = 0; i < 60 && koraProcess; i++) {
      try {
        await koraCall('getPayerSigner')
        return
      } catch {
        await sleep(500)
      }
    }
  },
  { timeout: 180_000 },
)

after(() => {
  koraProcess?.kill('SIGKILL')
  validator?.kill('SIGKILL')
  if (work) rmSync(work, { recursive: true, force: true })
})

test('a wallet with no SOL registers, pays for two escrows and closes a third through Kora, in a test dollar; every refund comes back to it', { timeout: 600_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')
  if (!koraProcess) return t.skip(`Kora did not start:\n${koraLog.join('').slice(-2000)}`)

  const signer = await koraCall<{ signer_address: string; payment_address: string }>('getPayerSigner')
  assert.equal(signer.signer_address, feePayer.publicKey.toBase58(), 'Kora signs with the key the file holds')
  assert.equal(signer.payment_address, feePayer.publicKey.toBase58(), 'and is paid to its own token account')

  // Setup, which the person pays nothing of: SOL for `setup` and the fee payer; token accounts for
  // the person, the seller, the fee payer and the treasury; the registry's `init` and four humans on
  // list 0, Alice among them. The person gets 100 test dollars, because the mock prices one at
  // about a tenth of a real dollar's worth of SOL.
  await confirm(await connection.requestAirdrop(setup.publicKey, 100 * LAMPORTS_PER_SOL))
  await confirm(await connection.requestAirdrop(feePayer.publicKey, LAMPORTS_PER_SOL))
  await send(
    [
      ...[person, seller, feePayer, treasury].map((k) =>
        createAssociatedTokenAccountIdempotentInstruction(setup.publicKey, ata(k.publicKey), k.publicKey, USDC_MINT),
      ),
      createMintToInstruction(USDC_MINT, personTokens, setup.publicKey, START_DOLLARS),
    ],
    [setup],
  )
  await send([initIx({ payer: setup.publicKey })], [setup])
  // Alice's secret is the one keys/ pins; the other three are anyone.
  const alice = Buffer.from('54684ed3bd15671b1a07bd8ed840a049c60ce847afd7d8da73b4f71cc6884d85', 'hex')
  const leaves = [1, 2, 3].map((n) => commitmentOf(Buffer.alloc(32, n)))
  leaves.splice(1, 0, commitmentOf(alice))
  for (const commitment of leaves) {
    await send([insertIdentityIx({ issuer: issuer.publicKey, listIndex: 0, commitment })], [setup, issuer])
  }

  const start = await balances()
  assert.equal(start.personSol, 0, 'the person holds no SOL')
  assert.equal(start.personTokens, START_DOLLARS)
  const rent = {
    code: await connection.getMinimumBalanceForRentExemption(9),
    escrow: 0,
    deposit: await connection.getMinimumBalanceForRentExemption(165),
  }

  // ---- Refusals ----
  const refusals: Record<string, string> = {
    // A program that is not on the list, at the top level.
    memo: await refused(
      [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: person.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('hello') })],
      1_000_000n,
      /not in the allowed list/,
    ),
    // The compute budget program is not on the list either: a priority fee is the fee payer's cost.
    computeBudget: await refused([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })], 1_000_000n, /not in the allowed list/),
    // The fee payer's SOL, sent anywhere.
    solOut: await refused(
      [SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: person.publicKey, lamports: 1_000_000 })],
      1_000_000n,
      /[Ff]ee payer cannot/,
    ),
    // Anything unpaid.
    unpaid: await refused([createTransferInstruction(personTokens, sellerTokens, person.publicKey, 1n)], 0n, /[Pp]ayment/),
  }

  // ---- The registration ----
  // The fee payer is the payer: the network fee and the code account's storage deposit. The
  // profile's wallet (here the person's one wallet) signs and pays the 25 cents. No compute budget
  // instruction: a registration fits the default limit, and the program is not on Kora's list.
  const registration = await buildRegistration({
    secret: alice,
    market: MARKET,
    did: DID,
    listIndex: 0,
    leaves,
    artifacts,
    accounts: {
      payer: feePayer.publicKey,
      profileWallet: person.publicKey,
      feeAuthority: person.publicKey,
      feeTokens: personTokens,
      treasuryTokens,
    },
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    computeUnitLimit: null,
  })

  // Paying only the network fee is refused: Kora counts the storage deposit the registry program
  // makes inside the transaction, and the code stays unused.
  await assert.rejects(throughKora([registration.instruction], BigInt(rent.code)), (err: Error) => {
    refusals.depositUnpaid = err.message
    return err instanceof KoraError && /[Ii]nsufficient/.test(err.message)
  })
  assert.equal(await connection.getAccountInfo(usedCodeAddress(registration.code)), null, 'the code is still unused')

  const beforeRegistration = await balances()
  const reg = await throughKora([registration.instruction])
  const afterRegistration = await balances()
  assert.ok(await connection.getAccountInfo(usedCodeAddress(registration.code)), 'the badge exists')
  assert.equal(afterRegistration.personSol, 0, 'the person still holds no SOL')
  assert.equal(
    afterRegistration.personTokens,
    beforeRegistration.personTokens - USDC_FEE - reg.charge,
    'the person paid 0.25 to the treasury and the quote to the fee payer, nothing else',
  )
  assert.equal((await getAccount(connection, treasuryTokens)).amount, USDC_FEE)
  assert.equal(afterRegistration.feePayerTokens - beforeRegistration.feePayerTokens, reg.charge)
  const regSpent = beforeRegistration.feePayerSol - afterRegistration.feePayerSol
  assert.equal(regSpent, reg.networkFee + rent.code, "the fee payer's SOL: the network fee and the code account")
  assert.equal(BigInt(reg.estimate.fee_in_lamports), BigInt(reg.networkFee + rent.code) + 50n, 'the quote: exactly that, plus the 50 lamports Kora adds for the payment instruction')
  assert.ok(reg.charge >= BigInt(regSpent), 'the fee payer paid for nobody')
  assert.ok(reg.wire < 1232, 'the paid registration fits one transaction')

  // The fee payer now holds what the registration paid it. A transaction that pays it and takes
  // that back out of its token account, under the signature it adds as payer, is refused.
  refusals.tokensOut = await refused(
    [createTransferInstruction(feePayerTokens, personTokens, feePayer.publicKey, reg.charge)],
    reg.charge,
    /[Ff]ee payer cannot/,
  )

  // ---- An escrow: pay (the deposit address, create, the money in), then release, each through Kora ----
  // The seller's post sets no options. The person opens each escrow, so its address is the
  // person's and every storage deposit that comes back comes back to the person: the fee payer
  // fronts each one in SOL and charges the person for it in the test dollar, once.
  const deal = (amount: bigint) => {
    const terms = termsFor(undefined, { seller: seller.publicKey, amount })
    const keys = keysFor({ buyer: person.publicKey, mint: USDC_MINT, terms })
    const args = { buyer: person.publicKey, payer: feePayer.publicKey, mint: USDC_MINT, terms }
    return { keys, pay: createAndFund(args), oneTap: payInOneTap(args), release: releaseToSellerIx({ keys }) }
  }

  const first = deal(2_000_000n)
  const beforePay = await balances()
  // Kora refuses the pay step when only the escrow program makes the deposit address. Kora 2.0.5
  // looks up the destination of every token transfer before it signs, and accepts one that does not
  // exist yet only when the same transaction makes it with a top-level associated-token-account
  // instruction; one the escrow program makes inside its own call is invisible to it ("Account ...
  // not found"). So the client makes it first, and `create` finds it made.
  const [, create, fund] = first.pay
  await assert.rejects(throughKora([create, fund]), (err: Error) => {
    refusals.depositMadeInsideProgram = err.message
    return err instanceof KoraError && /not found/.test(err.message)
  })
  const pay = await throughKora(first.pay)
  const afterPay = await balances()
  rent.escrow = await connection.getBalance(first.keys.escrow)
  assert.equal(await connection.getBalance(first.keys.vault), rent.deposit)
  const account = decodeEscrow(new Uint8Array((await connection.getAccountInfo(first.keys.escrow))!.data))
  assert.equal(account.rentRecipient.toBase58(), person.publicKey.toBase58(), 'the program records the person, who opened it, as where rent goes back')
  const paySpent = beforePay.feePayerSol - afterPay.feePayerSol
  assert.equal(paySpent, pay.networkFee + rent.escrow + rent.deposit, "the fee payer's SOL: the network fee, the escrow and its deposit address")
  assert.equal(pay.charge, BigInt(paySpent) + 50n, 'charged once for each, plus the 50 lamports Kora adds for the payment instruction')
  assert.equal(afterPay.personTokens, beforePay.personTokens - 2_000_000n - pay.charge)
  assert.equal(afterPay.personSol, 0)

  const release = await throughKora([first.release])
  const afterRelease = await balances()
  assert.equal((await getAccount(connection, sellerTokens)).amount, 2_000_000n, 'the seller is paid, at its standard account')
  assert.equal(await connection.getAccountInfo(first.keys.vault), null, 'the deposit address is closed')
  // The deposit address's storage deposit, which the person paid for when the escrow was made,
  // comes back to the person. The fee payer gets nothing back.
  assert.equal(afterRelease.personSol, rent.deposit, 'the deposit comes back to the person')
  const releaseSpent = afterPay.feePayerSol - afterRelease.feePayerSol
  assert.equal(releaseSpent, release.networkFee, 'the fee payer pays the network fee and gets nothing back')
  assert.equal(release.charge, BigInt(release.networkFee) + 50n, 'and Kora charges the release its network fee only')

  // ---- A second escrow in one tap: the deposit address, create, pay and release in one transaction ----
  const second = deal(1_000_000n)
  const beforeTap = await balances()
  const tap = await throughKora(second.oneTap)
  const afterTap = await balances()
  assert.equal((await getAccount(connection, sellerTokens)).amount, 3_000_000n)
  const tapSpent = beforeTap.feePayerSol - afterTap.feePayerSol
  assert.equal(tapSpent, tap.networkFee + rent.escrow + rent.deposit, 'the fee payer fronts the receipt and the deposit address, and gets neither back')
  assert.equal(tap.charge, BigInt(tapSpent) + 50n, 'charged once for each: nothing over but the 50 lamports for the payment instruction')
  assert.equal(afterTap.personSol - beforeTap.personSol, rent.deposit, "the deposit address's rent back to the person, in the same transaction")

  // ---- A third escrow, never funded, closed by the person: both storage deposits back to it ----
  const third = deal(500_000n)
  const [openDeposit, openCreate] = third.pay
  const beforeOpen = await balances()
  const open = await throughKora([openDeposit, openCreate])
  const afterOpen = await balances()
  const openSpent = beforeOpen.feePayerSol - afterOpen.feePayerSol
  assert.equal(openSpent, open.networkFee + rent.escrow + rent.deposit)
  assert.equal(open.charge, BigInt(openSpent) + 50n, 'charged once for each')
  const close = await throughKora([closeUnfundedIx({ keys: third.keys, closer: person.publicKey })])
  const afterClose = await balances()
  assert.equal(await connection.getAccountInfo(third.keys.escrow), null, 'the escrow is gone')
  assert.equal(await connection.getAccountInfo(third.keys.vault), null, 'and its deposit address')
  assert.equal(afterClose.personSol - afterOpen.personSol, rent.escrow + rent.deposit, 'both storage deposits back to the person')
  assert.equal(afterOpen.feePayerSol - afterClose.feePayerSol, close.networkFee, 'the fee payer gets nothing back')
  assert.equal(close.charge, BigInt(close.networkFee) + 50n)

  // ---- SOL sent to a receipt, swept: to the person ----
  // A sweep needs no signature, so anyone sends it; here `setup` does. (Through Kora, the person
  // would sign only the payment, and `throughKora` asks for its quote before adding the payment, so
  // the quote would be one signature short.)
  await send([SystemProgram.transfer({ fromPubkey: setup.publicKey, toPubkey: first.keys.escrow, lamports: 1_000_000 })], [setup])
  const beforeSweep = await balances()
  await send([sweepRentIx({ escrow: first.keys.escrow, rentRecipient: person.publicKey })], [setup])
  const afterSweep = await balances()
  assert.equal(afterSweep.personSol - beforeSweep.personSol, 1_000_000, 'to the person, who opened the escrow')
  assert.equal(await connection.getBalance(first.keys.escrow), rent.escrow, 'the receipt keeps exactly its minimum')

  const end = await balances()
  const refunded = 3 * rent.deposit + rent.escrow + 1_000_000 // release, one tap, close (both), sweep
  assert.equal(end.personSol, refunded, 'the person was never given a lamport but its own refunds')
  const lamports = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} lamports`
  console.log('\n== the fee payer, Kora 2.0.5, on a local validator ==')
  console.log(`   rent here: code account ${lamports(rent.code)}, escrow account ${lamports(rent.escrow)}, deposit address ${lamports(rent.deposit)}`)
  console.log(`   registration: ${reg.wire} bytes, ${reg.units} units, network fee ${lamports(reg.networkFee)}; charged ${reg.charge} test-dollar units (${lamports(reg.estimate.fee_in_lamports)}); fee payer spent ${lamports(regSpent)}`)
  console.log(`   escrow, pay: ${pay.wire} bytes, ${pay.units} units; charged ${pay.charge} units; fee payer spent ${lamports(paySpent)}`)
  console.log(`   escrow, release: ${release.wire} bytes, ${release.units} units; charged ${release.charge} units; fee payer spent ${lamports(releaseSpent)}; the deposit address's rent went to the person`)
  console.log(`   escrow, one tap: ${tap.wire} bytes, ${tap.units} units; charged ${tap.charge} units; fee payer spent ${lamports(tapSpent)}; charged over that: ${tap.charge - BigInt(tapSpent)} units`)
  console.log(`   escrow, opened and closed unfunded: charged ${open.charge} + ${close.charge} units; both storage deposits went to the person`)
  console.log(`   person: ${START_DOLLARS - end.personTokens} test-dollar units spent in all; ${lamports(end.personSol)} of storage deposits and a swept tip came back to it, never to the fee payer`)
  console.log('   refused:')
  for (const [name, message] of Object.entries(refusals)) console.log(`     ${name}: ${message.slice(0, 160)}`)
  console.log()
})
