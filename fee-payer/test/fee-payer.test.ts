// The fee payer, run locally: Kora (installed by ../build.sh, started by ../run.sh) in front of a
// local validator with the escrow loaded. run.sh makes the fee payer's key at the first start. A
// person whose key never held a lamport opens an escrow with a schedule and pays into it, paying the
// fee payer in a test dollar what the transaction cost it, and nothing more. Kora refuses a program
// not on its list, and any transfer out of the fee payer's own accounts.
//
//   npm run test:local
//
// Needs `solana-test-validator` on the PATH, the escrow built (`cargo build-sbf --arch v3` in
// standard/escrows/solana/program), the standard installed and built (`./standard.sh` at the repo
// root) and Kora (`./build.sh`). If one is missing the test says which and skips.
//
// The escrow runs here at the id in its source, as a local build has it. Kora runs on a copy of
// kora.toml with exactly these lines changed: the escrow's address to that id, and prices from
// Kora's own mock ("Mock") instead of Jupiter. Everything else is the file's own. The test dollar is
// a six-decimal mint planted at USDC's address, one of the tokens kora.toml takes payment in. The
// mock values it at 0.001 SOL per whole token, so here one base unit of the test dollar buys one
// lamport.
//
// Everything here polls `getSignatureStatuses` rather than calling `confirmTransaction`, which
// opens a websocket subscription that keeps Node alive long after the test has passed.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

import * as escrow from '@foundationforest/escrow-client'

const here = dirname(fileURLToPath(import.meta.url))
const escrowSo = join(here, '../../standard/escrows/solana/program/target/deploy/forest_escrow.so')
/** The escrow's address, as kora.toml names it. */
const ESCROW_IN_KORA_TOML = 'FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8'
const kora = join(here, '../.kora/bin/kora')
const RPC = 'http://127.0.0.1:8899'
const KORA_PORT = 8080
const KORA_URL = `http://127.0.0.1:${KORA_PORT}`
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const START_DOLLARS = 100_000_000n
/** What the fee payer holds in the test dollar before the tests, standing in for what it collected earlier. */
const COLLECTED = 1_000_000n
/** A payment well above any price here, so a refusal is about what the transaction does. */
const PLENTY = 1_000_000n

// Made before the validator starts: it is the planted test dollar's mint authority, and it pays for
// everything that is not the person's (the token accounts the person already holds when this starts,
// the fee payer's first SOL).
const setup = Keypair.generate()
// The person: one key, never given a lamport. It opens the escrow as its payer and pays the fee payer.
const person = Keypair.generate()
const recipient = Keypair.generate()

const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(USDC_MINT, owner)
const personTokens = ata(person.publicKey)

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
let keyFile = ''
let connection: Connection
/** The fee payer's key, as Kora reports it. */
let feePayer: PublicKey
let feePayerTokens: PublicKey
/** Everything run.sh and Kora wrote to stdout and stderr. */
const output: string[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function missing(): string | null {
  if (!existsSync(escrowSo)) return `no program at ${escrowSo}; run \`cargo build-sbf --arch v3\` in standard/escrows/solana/program`
  if (!existsSync(kora)) return 'no Kora; run ./build.sh in fee-payer'
  if (!validator) return 'solana-test-validator did not start (is it on the PATH?)'
  if (!koraProcess || !feePayer) return `Kora did not start:\n${output.join('').slice(-2000)}`
  return null
}

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

/** One JSON-RPC call to Kora, as a person's app would make it. */
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
    new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  )
}

/** The payment: a plain token transfer from the person to the fee payer, of what Kora quoted. */
const payment = (amount: bigint) => createTransferInstruction(personTokens, feePayerTokens, person.publicKey, amount)

type Paid = { signature: string; estimate: Estimate; charge: bigint; wire: number; networkFee: number; units: number }

/**
 * What a person's device does: build the transaction with the fee payer as its payer and a
 * placeholder transfer to it, ask Kora what that costs in the test dollar, set the transfer to
 * exactly that, sign with the person's key, and hand it to Kora, which checks it, co-signs and
 * sends it. The quote is asked with the transfer in place because the network fee is per signature,
 * and the transfer is signed by the person. `shortBy` pays less than the quote, to see Kora refuse.
 */
async function throughKora(instructions: TransactionInstruction[], shortBy = 0n): Promise<Paid> {
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const estimate = await koraCall<Estimate>('estimateTransactionFee', {
    transaction: b64(compile([...instructions, payment(0n)], blockhash).serialize()),
    fee_token: USDC_MINT.toBase58(),
    sig_verify: false,
  })
  assert.ok(estimate.fee_in_token !== null, 'Kora quotes in the test dollar')
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

async function balances() {
  return {
    personSol: await connection.getBalance(person.publicKey),
    personTokens: (await getAccount(connection, personTokens)).amount,
    feePayerSol: await connection.getBalance(feePayer),
    feePayerTokens: (await getAccount(connection, feePayerTokens)).amount,
  }
}

/** Kora must refuse these before signing: nothing lands, and nothing moves. */
async function refused(instructions: TransactionInstruction[], pattern: RegExp): Promise<string> {
  const start = await balances()
  const tx = compile([...instructions, payment(PLENTY)], (await connection.getLatestBlockhash('confirmed')).blockhash)
  tx.sign([person])
  let message = ''
  await assert.rejects(koraCall('signAndSendTransaction', { transaction: b64(tx.serialize()) }), (err: Error) => {
    message = err.message
    return err instanceof KoraError && pattern.test(err.message)
  })
  assert.deepEqual(await balances(), start, 'nothing moved')
  return message
}

before(
  async () => {
    if (!existsSync(escrowSo) || !existsSync(kora)) return
    work = mkdtempSync(join(tmpdir(), 'forest-fee-payer-'))
    const dollarJson = join(work, 'test-dollar.json')
    writeFileSync(dollarJson, testDollarJson())
    validator = spawn(
      'solana-test-validator',
      ['--reset', '--quiet', '--ledger', join(work, 'ledger'), '--bpf-program', escrow.PROGRAM_ID.toBase58(), escrowSo, '--account', USDC_MINT.toBase58(), dollarJson],
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

    // kora.toml with two lines changed, each checked to appear exactly once.
    let config = readFileSync(join(here, '../kora.toml'), 'utf8')
    for (const [from, to] of [
      ['price_source = "Jupiter"', 'price_source = "Mock"'],
      [ESCROW_IN_KORA_TOML, escrow.PROGRAM_ID.toBase58()],
    ] as const) {
      assert.equal(config.split(from).length - 1, 1, `kora.toml has exactly one ${from}`)
      config = config.replace(from, to)
    }
    const mockConfig = join(work, 'kora.toml')
    writeFileSync(mockConfig, config)

    // The volume, empty: run.sh makes the key there.
    keyFile = join(work, 'volume/fee-payer-keypair.json')
    koraProcess = spawn('bash', [join(here, '../run.sh')], {
      env: { ...process.env, KEY_PATH: keyFile, RPC_URL: RPC, KORA_CONFIG: mockConfig, PORT: String(KORA_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [koraProcess.stdout!, koraProcess.stderr!]) stream.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    koraProcess.on('exit', () => {
      koraProcess = undefined
    })
    for (let i = 0; i < 60 && koraProcess && !feePayer; i++) {
      try {
        feePayer = new PublicKey((await koraCall<{ signer_address: string }>('getPayerSigner')).signer_address)
      } catch {
        await sleep(500)
      }
    }
    if (!feePayer) return
    feePayerTokens = ata(feePayer)

    // Setup, which the person pays nothing of: SOL for `setup` and the fee payer; token accounts for
    // the person, the recipient and the fee payer, which needs one for each token it is paid in. The
    // person gets 100 test dollars; the fee payer holds what it collected earlier.
    await confirm(await connection.requestAirdrop(setup.publicKey, 100 * LAMPORTS_PER_SOL))
    await confirm(await connection.requestAirdrop(feePayer, LAMPORTS_PER_SOL))
    await send(
      [
        ...[person.publicKey, recipient.publicKey, feePayer].map((k) => createAssociatedTokenAccountIdempotentInstruction(setup.publicKey, ata(k), k, USDC_MINT)),
        createMintToInstruction(USDC_MINT, personTokens, setup.publicKey, START_DOLLARS),
        createMintToInstruction(USDC_MINT, feePayerTokens, setup.publicKey, COLLECTED),
      ],
      [setup],
    )
  },
  { timeout: 180_000 },
)

after(() => {
  koraProcess?.kill('SIGKILL')
  validator?.kill('SIGKILL')
  if (work) rmSync(work, { recursive: true, force: true })
})

test("run.sh makes the fee payer's key at its first start: mode 0600, its address printed once, never the key", (t) => {
  const why = missing()
  if (why) return t.skip(why)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'only its owner reads it')
  const secret = Uint8Array.from(JSON.parse(readFileSync(keyFile, 'utf8')) as number[])
  const key = Keypair.fromSecretKey(secret) // checks the public half against the seed
  assert.equal(key.publicKey.toBase58(), feePayer.toBase58(), 'Kora signs with the key the file holds')
  const all = output.join('')
  assert.deepEqual([...all.matchAll(/fee payer address (\w+)/g)].map((m) => m[1]), [feePayer.toBase58()], 'its address, printed once')
  for (const form of [JSON.stringify([...secret]), JSON.stringify([...secret.subarray(0, 32)]).slice(1, -1), Buffer.from(secret.subarray(0, 32)).toString('hex'), Buffer.from(secret).toString('base64')]) {
    assert.ok(!all.includes(form), 'the key appears nowhere in what it printed')
  }
})

test('an escrow with a schedule, paid into in the test dollar, is co-signed and charged at cost', { timeout: 120_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  const amount = 1_500_000n
  // An offer's options, as an app reads them: paid in a week unless stopped.
  const week = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  const terms = escrow.termsFor({ schedule: { windows: [{ until: week, payerShare: 0 }], end: 'pay' } }, { recipient: recipient.publicKey, amount })
  const token = escrow.tokenOf(USDC_MINT, (await connection.getAccountInfo(USDC_MINT))!)
  // The deposit address made, `create` with the fee payer fronting the rent, the money in, the mark.
  const open = escrow.createAndFund({ payer: person.publicKey, sponsor: feePayer, token, terms })
  const keys = escrow.keysFor({ payer: person.publicKey, sponsor: feePayer, mint: USDC_MINT, terms })

  // One unit short is refused: Kora counts every deposit, those the escrow makes inside its own call
  // included, and nothing lands.
  const start = await balances()
  await assert.rejects(throughKora(open, 1n), (err: Error) => err instanceof KoraError && /[Ii]nsufficient/.test(err.message))
  assert.equal(await connection.getAccountInfo(keys.escrow), null, 'no escrow')
  assert.deepEqual(await balances(), start, 'nothing moved')

  const paid = await throughKora(open)
  const end = await balances()
  const account = escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  assert.equal(account.status, 'funded', 'opened, paid into and marked')
  assert.deepEqual(account.schedule, terms.schedule, 'with the schedule')
  assert.ok(account.payer.equals(person.publicKey), 'the person is its payer')
  assert.ok(account.sponsor.equals(feePayer), 'the fee payer fronted the rent, so every rent goes back to it')
  assert.equal((await getAccount(connection, keys.vault)).amount, amount, 'the money is in the deposit address')

  const rent = { escrow: await connection.getBalance(keys.escrow), deposit: await connection.getBalance(keys.vault) }
  assert.equal(rent.escrow, await connection.getMinimumBalanceForRentExemption(8 + escrow.ESCROW_LEN))
  assert.equal(rent.deposit, await connection.getMinimumBalanceForRentExemption(165))
  const spent = start.feePayerSol - end.feePayerSol
  assert.equal(spent, paid.networkFee + rent.escrow + rent.deposit, "the fee payer's SOL: the network fee, the escrow's account and its deposit address")
  assert.equal(BigInt(paid.estimate.fee_in_lamports), BigInt(spent), 'the quote: exactly that')
  assert.equal(paid.charge, BigInt(spent), 'the charge: exactly that, one test-dollar unit a lamport')
  assert.equal(end.feePayerTokens - start.feePayerTokens, paid.charge, 'paid to the fee payer')
  assert.equal(end.personTokens, start.personTokens - amount - paid.charge, 'the person paid the amount and the charge, and nothing else')
  assert.equal(end.personSol, 0, 'the person still holds no SOL')
  assert.ok(paid.wire <= 1232, 'it fits one transaction')
  console.log(
    `opening the escrow: ${paid.wire} bytes, ${paid.units} units; network fee ${paid.networkFee}, escrow ${rent.escrow}, deposit address ${rent.deposit} lamports; charged ${paid.charge} test-dollar units`,
  )
})

test('a transaction calling a program not on the list is refused', { timeout: 60_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  // The compute budget program: a priority fee is the fee payer's cost.
  console.log(await refused([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })], /not in the allowed list/))
})

test("a transfer out of the fee payer's own account is refused", { timeout: 60_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  // Its SOL, sent anywhere.
  console.log(await refused([SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: person.publicKey, lamports: 1_000_000 })], /[Ff]ee payer cannot/))
  // The dollars it collected, under the signature it adds as payer.
  console.log(await refused([createTransferInstruction(feePayerTokens, personTokens, feePayer, COLLECTED)], /[Ff]ee payer cannot/))
})
