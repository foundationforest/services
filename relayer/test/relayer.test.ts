// The relayer, run locally: Kora (installed by ../build.sh, started by ../run.sh) in front of a
// local validator with the registry and the escrow loaded. A wallet that holds no SOL writes a
// registry row, pays for escrows (one in Open USD, a Token-2022 dollar, which Kora takes in two steps
// but not in one tap) and closes one it never funded, paying for everything in a test dollar; each
// storage deposit is charged to it once. Every deposit address's rent comes back to it; what Solana's
// storage price cuts free goes back to whoever fronted the deposit, which for a row and an escrow is
// the relayer. Kora refuses what it must refuse.
//
//   npm run test:local
//
// Needs `solana-test-validator` on the PATH, the two programs built (`cargo build-sbf --arch v3` in
// forest/registry/program and forest/escrow/program), the registry's proving files (`npm run fetch`
// in forest/registry/artifacts), the two clients' dependencies (`../forest.sh registry/client
// escrow/client`) and Kora (`./build.sh`). If any is missing the test says which and skips.
//
// The programs run here at the ids in their source, as a local build has them. Kora runs on a copy
// of kora.toml with exactly these lines changed: its two Forest programs from their devnet ids to
// those, and prices from Kora's own mock ("Mock") instead of Jupiter. The rules are the file's own.
// The test dollar is a six-decimal mint planted at USDC's address, one of the tokens kora.toml
// accepts payment in. The mock values any mint but two at 0.001 SOL per whole token, so here one
// base unit of the test dollar buys one lamport.
//
// The rent cuts cannot be made on a local validator. A gift of SOL to an account stands in for
// them: it is what the account then holds above its minimum, exactly as a cut would leave it.
//
// Everything here polls `getSignatureStatuses` rather than calling `confirmTransaction`, which
// opens a websocket subscription that keeps Node alive long after the test has passed.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createPrivateKey, randomBytes, sign as edSign } from 'node:crypto'
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

import { PROGRAM_ID as REGISTRY_ID, buildRegistration, decodeRow, listRoot, refundIx, rowSpace, stampOf, toBytes32 } from '../../forest/registry/client/src/index.ts'
import * as escrow from '../../forest/escrow/client/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const forest = join(here, '../../forest')
const registrySo = join(forest, 'registry/program/target/deploy/forest_registry.so')
const escrowSo = join(forest, 'escrow/program/target/deploy/forest_escrow.so')
/** The two Forest programs' devnet ids, as kora.toml names them. */
const DEVNET = { registry: '5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC', escrow: 'FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8' }
const artifacts = {
  wasm: join(forest, 'registry/artifacts/semaphore-32.wasm'),
  zkey: join(forest, 'registry/artifacts/semaphore-32.zkey'),
}
const kora = join(here, '../.kora/bin/kora')
const RPC = 'http://127.0.0.1:8899'
const KORA_PORT = 8080
const KORA_URL = `http://127.0.0.1:${KORA_PORT}`
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
/** Open USD, a Token-2022 dollar with eight extensions, planted from its mainnet account (below). */
const OPEN_USD = new PublicKey('ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const LABEL = 'online-tutors/seller'
const START_DOLLARS = 100_000_000n
const GIFT = 1_000_000

// Made before the validator starts: it is the planted test dollar's mint authority, and it pays for
// everything that is not the person's (the token accounts the person already holds when this
// starts, the relayer's first SOL, the gifts that stand in for the rent cuts).
const setup = Keypair.generate()
// The relayer's own key. Written to a file outside the repo; Kora reads the file's path from
// FOREST_RELAYER_KEY.
const relayer = Keypair.generate()
// The person: one profile key, never given a lamport. It signs its row and its payments.
const person = Keypair.generate()
// A keeper, and the root of its list signed with its key, as the issuer publishes it.
const keeper = Keypair.generate()
const seller = Keypair.generate()

const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(USDC_MINT, owner)
const personTokens = ata(person.publicKey)
const relayerTokens = ata(relayer.publicKey)
const sellerTokens = ata(seller.publicKey)

function missing(): string | null {
  if (!existsSync(registrySo)) return `no program at ${registrySo}; run \`cargo build-sbf --arch v3\` in forest/registry/program`
  if (!existsSync(escrowSo)) return `no program at ${escrowSo}; run \`cargo build-sbf --arch v3\` in forest/escrow/program`
  if (!existsSync(artifacts.zkey)) return 'no proving files; run `npm run fetch` in forest/registry/artifacts'
  if (!existsSync(join(forest, 'registry/client/node_modules'))) return 'run `npm ci` in registry/client'
  if (!existsSync(join(forest, 'escrow/client/node_modules'))) return 'run `npm ci` in escrow/client'
  if (!existsSync(kora)) return 'no Kora; run ./build.sh in relayer'
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

/**
 * Open USD's mint account as mainnet held it, from forest's own record of it (the escrow's tests
 * embed it), with only its mint authority swapped for `setup` so the test can mint. All eight of its
 * extensions stay as mainnet has them.
 */
function openUsdJson(): string {
  const source = readFileSync(join(forest, 'escrow/program/tests-litesvm/src/token_2022.rs'), 'utf8')
  const data = Buffer.from(/OPEN_USD_MAINNET: &str = "([^"]+)"/.exec(source)![1], 'base64')
  data.writeUInt32LE(1, 0) // mint_authority: Some
  setup.publicKey.toBuffer().copy(data, 4)
  data.writeBigUInt64LE(0n, 36) // supply
  return JSON.stringify({
    pubkey: OPEN_USD.toBase58(),
    account: { lamports: 10_000_000, data: [data.toString('base64'), 'base64'], owner: TOKEN_2022.toBase58(), executable: false, rentEpoch: 0, space: data.length },
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
    new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  )
}

/** The payment: a plain token transfer from the person to the relayer, of what Kora quoted. */
const payment = (amount: bigint) => createTransferInstruction(personTokens, relayerTokens, person.publicKey, amount)

type Paid = { signature: string; estimate: Estimate; charge: bigint; wire: number; networkFee: number; units: number }

/**
 * What a person's device does: build the transaction with the relayer as its payer and a
 * placeholder transfer to it, ask Kora what that costs in the dollar token, set the transfer to
 * exactly that, sign with the person's keys, and hand it to Kora, which checks it, co-signs and
 * sends it. The quote is asked with the transfer in place because the transfer brings the person's
 * signature, and the network fee is per signature: a registration has no other. `shortBy` pays
 * less than the quote, to see Kora refuse.
 */
async function throughKora(instructions: TransactionInstruction[], shortBy = 0n): Promise<Paid> {
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const estimate = await koraCall<Estimate>('estimateTransactionFee', {
    transaction: b64(compile([...instructions, payment(0n)], blockhash).serialize()),
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
    relayerSol: await connection.getBalance(relayer.publicKey),
    relayerTokens: (await getAccount(connection, relayerTokens)).amount,
  }
}

const koraLog: string[] = []

before(
  async () => {
    if (missing()) return
    work = mkdtempSync(join(tmpdir(), 'forest-relayer-'))
    ledger = join(work, 'ledger')
    const dollarJson = join(work, 'test-dollar.json')
    writeFileSync(dollarJson, testDollarJson())
    const openUsd = join(work, 'open-usd.json')
    writeFileSync(openUsd, openUsdJson())
    validator = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledger,
        '--bpf-program', REGISTRY_ID.toBase58(), registrySo,
        '--bpf-program', escrow.PROGRAM_ID.toBase58(), escrowSo,
        '--account', USDC_MINT.toBase58(), dollarJson,
        '--account', OPEN_USD.toBase58(), openUsd,
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

    // The relayer's key: a file outside the repo, read by Kora through FOREST_RELAYER_KEY.
    const keyFile = join(work, 'relayer.json')
    writeFileSync(keyFile, JSON.stringify(Array.from(relayer.secretKey)), { mode: 0o600 })
    // kora.toml with three lines changed, each checked to appear exactly once.
    let config = readFileSync(join(here, '../kora.toml'), 'utf8')
    for (const [from, to] of [
      ['price_source = "Jupiter"', 'price_source = "Mock"'],
      [DEVNET.registry, REGISTRY_ID.toBase58()],
      [DEVNET.escrow, escrow.PROGRAM_ID.toBase58()],
    ] as const) {
      assert.equal(config.split(from).length - 1, 1, `kora.toml has exactly one ${from}`)
      config = config.replace(from, to)
    }
    const mockConfig = join(work, 'kora.toml')
    writeFileSync(mockConfig, config)

    const log = createWriteStream(join(work, 'kora.log'))
    koraProcess = spawn('bash', [join(here, '../run.sh')], {
      env: { ...process.env, FOREST_RELAYER_KEY: keyFile, RPC_URL: RPC, KORA_CONFIG: mockConfig, PORT: String(KORA_PORT) },
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

test('a wallet with no SOL writes a row, pays for escrows (one in Open USD) and closes one through Kora, in a test dollar', { timeout: 600_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')
  if (!koraProcess) return t.skip(`Kora did not start:\n${koraLog.join('').slice(-2000)}`)

  const signer = await koraCall<{ signer_address: string; payment_address: string }>('getPayerSigner')
  assert.equal(signer.signer_address, relayer.publicKey.toBase58(), 'Kora signs with the key the file holds')
  assert.equal(signer.payment_address, relayer.publicKey.toBase58(), 'and is paid to its own token account')

  // Setup, which the person pays nothing of: SOL for `setup` and the relayer; token accounts for
  // the person, the seller and the relayer. The person gets 100 test dollars, because the mock
  // prices one at about a tenth of a real dollar's worth of SOL.
  await confirm(await connection.requestAirdrop(setup.publicKey, 100 * LAMPORTS_PER_SOL))
  await confirm(await connection.requestAirdrop(relayer.publicKey, LAMPORTS_PER_SOL))
  await send(
    [
      ...[person, seller, relayer].map((k) =>
        createAssociatedTokenAccountIdempotentInstruction(setup.publicKey, ata(k.publicKey), k.publicKey, USDC_MINT),
      ),
      createMintToInstruction(USDC_MINT, personTokens, setup.publicKey, START_DOLLARS),
    ],
    [setup],
  )

  // The person's secret for the keeper's list, and the keeper's list with their stamp in it, its root
  // signed with the keeper's key as the issuer signs a snapshot (issuer/README.md).
  const secret = new Uint8Array(randomBytes(32))
  const others = (n: number) => Array.from({ length: n }, () => stampOf(new Uint8Array(randomBytes(32))))
  const stamps = [...others(2), stampOf(secret), ...others(1)]
  const keeperKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), keeper.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
  const keeperSignature = new Uint8Array(edSign(null, toBytes32(listRoot(stamps)), keeperKey))

  const start = await balances()
  assert.equal(start.personSol, 0, 'the person holds no SOL')
  assert.equal(start.personTokens, START_DOLLARS)
  const labelBytes = new TextEncoder().encode(LABEL).length
  const rent = {
    row: await connection.getMinimumBalanceForRentExemption(rowSpace(labelBytes)),
    escrow: 0,
    deposit: await connection.getMinimumBalanceForRentExemption(165),
    depositT22: 0,
  }

  // ---- Refusals ----
  const refusals: Record<string, string> = {
    // A program that is not on the list, at the top level.
    memo: await refused(
      [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: person.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('hello') })],
      1_000_000n,
      /not in the allowed list/,
    ),
    // The compute budget program is not on the list either: a priority fee is the relayer's cost.
    computeBudget: await refused([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })], 1_000_000n, /not in the allowed list/),
    // The relayer's SOL, sent anywhere.
    solOut: await refused(
      [SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: person.publicKey, lamports: 1_000_000 })],
      1_000_000n,
      /[Ff]ee payer cannot/,
    ),
    // Anything unpaid.
    unpaid: await refused([createTransferInstruction(personTokens, sellerTokens, person.publicKey, 1n)], 0n, /[Pp]ayment/),
  }

  // ---- A registry row ----
  // One transaction: `register`. The relayer is the payer: the network fee and the row's storage
  // deposit, and it is recorded in the row. The profile's key signs the row and the payment to the
  // relayer. A row never grows, so nothing after this asks the relayer for SOL.
  const registration = await buildRegistration({
    secret,
    label: LABEL,
    profile: person.publicKey as never,
    keeper: keeper.publicKey.toBytes() as never,
    stamps,
    keeperSignature,
    artifacts,
    payer: relayer.publicKey as never,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  const register = registration.instruction as never as TransactionInstruction
  const rowAddress = new PublicKey(registration.row.toBase58())

  // Paying only the network fee is refused: Kora counts the storage deposit the registry program
  // makes inside the transaction, and no row is written.
  await assert.rejects(throughKora([register], BigInt(rent.row)), (err: Error) => {
    refusals.depositUnpaid = err.message
    return err instanceof KoraError && /[Ii]nsufficient/.test(err.message)
  })
  assert.equal(await connection.getAccountInfo(rowAddress), null, 'no row yet')

  const beforeRow = await balances()
  const reg = await throughKora([register])
  const afterRow = await balances()
  const row = decodeRow(new Uint8Array((await connection.getAccountInfo(rowAddress))!.data))
  assert.equal(row.profile.toBase58(), person.publicKey.toBase58(), "the row names the person's profile")
  assert.equal(row.keeper.toBase58(), keeper.publicKey.toBase58(), 'and the keeper')
  assert.equal(row.payer.toBase58(), relayer.publicKey.toBase58(), 'and records the relayer as its payer')
  assert.equal(row.label, LABEL)
  assert.equal(afterRow.personSol, 0, 'the person still holds no SOL')
  assert.equal(afterRow.personTokens, beforeRow.personTokens - reg.charge, 'the person paid the quote and nothing else: no fee')
  assert.equal(afterRow.relayerTokens - beforeRow.relayerTokens, reg.charge)
  const rowSpent = beforeRow.relayerSol - afterRow.relayerSol
  assert.equal(rowSpent, reg.networkFee + rent.row, "the relayer's SOL: the network fee and the row")
  assert.equal(BigInt(reg.estimate.fee_in_lamports), BigInt(rowSpent), 'the quote: exactly that')
  assert.equal(reg.charge, BigInt(rowSpent), 'and the charge')
  assert.ok(reg.wire < 1232, 'the paid registration fits one transaction')

  // The relayer now holds what the registration paid it. A transaction that pays it and takes
  // that back out of its token account, under the signature it adds as payer, is refused.
  refusals.tokensOut = await refused(
    [createTransferInstruction(relayerTokens, personTokens, relayer.publicKey, reg.charge)],
    reg.charge,
    /[Ff]ee payer cannot/,
  )

  // What the rent cuts free on a row goes back to its payer, the relayer. Anyone may send `refund`.
  await send([SystemProgram.transfer({ fromPubkey: setup.publicKey, toPubkey: rowAddress, lamports: GIFT })], [setup])
  const beforeRefund = await balances()
  await send([refundIx({ row: rowAddress as never, payer: relayer.publicKey as never }) as never], [setup])
  const afterRefund = await balances()
  assert.equal(afterRefund.relayerSol - beforeRefund.relayerSol, GIFT, "a row's refund goes to the relayer, which fronted its deposit")
  assert.equal(await connection.getBalance(rowAddress), rent.row, 'the row keeps exactly its minimum')

  // ---- The escrow: pay (the deposit address, create, the money in), then release, each through Kora ----
  // The seller's offer sets no options. The person opens each escrow, so the deposit address's rent
  // comes back to the person; the relayer fronts each deposit in SOL and charges the person for it
  // in the test dollar, once, and is recorded as the escrow's payer.
  const tokenOf = async (mint: PublicKey) => escrow.tokenOf(mint, (await connection.getAccountInfo(mint))!)
  const dollar = await tokenOf(USDC_MINT)
  const deal = (amount: bigint, token = dollar) => {
    const terms = escrow.termsFor(undefined, { seller: seller.publicKey, amount })
    const keys = escrow.keysFor({ buyer: person.publicKey, mint: token.mint, tokenProgram: token.program, terms })
    const args = { buyer: person.publicKey, payer: relayer.publicKey, token, terms }
    return { keys, pay: escrow.createAndFund(args), oneTap: escrow.payInOneTap(args), release: escrow.releaseToSellerIx({ keys }) }
  }

  const first = deal(1_500_000n)
  // Kora refuses the pay step when only the escrow program makes the deposit address. Kora 2.0.5
  // looks up the destination of every token transfer before it signs, and accepts one that does not
  // exist yet only when the same transaction makes it with a top-level associated-token-account
  // instruction; one the escrow program makes inside its own call is invisible to it ("Account ...
  // not found"). So the client makes it first, and `create` finds it made.
  const [, create, fund] = first.pay
  await assert.rejects(throughKora([create!, fund!]), (err: Error) => {
    refusals.depositMadeInsideProgram = err.message
    return err instanceof KoraError && /not found/.test(err.message)
  })
  const beforePay = await balances()
  const pay = await throughKora(first.pay)
  const afterPay = await balances()
  rent.escrow = await connection.getBalance(first.keys.escrow)
  assert.equal(await connection.getBalance(first.keys.vault), rent.deposit)
  const account = escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(first.keys.escrow))!.data))
  assert.equal(account.rentRecipient.toBase58(), person.publicKey.toBase58(), "the deposit address's rent goes back to the person, who opened it")
  assert.equal(account.payer.toBase58(), relayer.publicKey.toBase58(), 'and the relayer, which fronted the rent, is recorded as its payer')
  const paySpent = beforePay.relayerSol - afterPay.relayerSol
  assert.equal(paySpent, pay.networkFee + rent.escrow + rent.deposit, "the relayer's SOL: the network fee, the escrow and its deposit address")
  assert.equal(pay.charge, BigInt(paySpent), 'charged once for each, and nothing over')
  assert.equal(afterPay.personTokens, beforePay.personTokens - 1_500_000n - pay.charge)
  assert.equal(afterPay.personSol, 0)

  const release = await throughKora([first.release])
  const afterRelease = await balances()
  assert.equal((await getAccount(connection, sellerTokens)).amount, 1_500_000n, 'the seller is paid, at its standard account')
  assert.equal(await connection.getAccountInfo(first.keys.vault), null, 'the deposit address is closed')
  assert.equal(afterRelease.personSol, rent.deposit, 'the deposit comes back to the person')
  const releaseSpent = afterPay.relayerSol - afterRelease.relayerSol
  assert.equal(releaseSpent, release.networkFee, 'the relayer pays the network fee and gets nothing back')
  assert.equal(release.charge, BigInt(release.networkFee), 'and Kora charges the release its network fee only')

  // ---- In one tap: the deposit address, create, pay and release in one transaction ----
  const second = deal(500_000n)
  const beforeTap = await balances()
  const tap = await throughKora(second.oneTap)
  const afterTap = await balances()
  assert.equal((await getAccount(connection, sellerTokens)).amount, 2_000_000n)
  const tapSpent = beforeTap.relayerSol - afterTap.relayerSol
  assert.equal(tapSpent, tap.networkFee + rent.escrow + rent.deposit, 'the relayer fronts the receipt and the deposit address')
  assert.equal(tap.charge, BigInt(tapSpent), 'charged once for each, and nothing over')
  assert.equal(afterTap.personSol - beforeTap.personSol, rent.deposit, "the deposit address's rent back to the person, in the same transaction")

  // ---- Never funded, closed by the person: both storage deposits back to it, who opened it ----
  const third = deal(500_000n)
  const [openDeposit, openCreate] = third.pay
  const beforeOpen = await balances()
  const open = await throughKora([openDeposit!, openCreate!])
  const afterOpen = await balances()
  const openSpent = beforeOpen.relayerSol - afterOpen.relayerSol
  assert.equal(openSpent, open.networkFee + rent.escrow + rent.deposit)
  assert.equal(open.charge, BigInt(openSpent), 'charged once for each')
  const close = await throughKora([escrow.closeUnfundedIx({ keys: third.keys, closer: person.publicKey })])
  const afterClose = await balances()
  assert.equal(await connection.getAccountInfo(third.keys.escrow), null, 'the escrow is gone')
  assert.equal(await connection.getAccountInfo(third.keys.vault), null, 'and its deposit address')
  assert.equal(afterClose.personSol - afterOpen.personSol, rent.escrow + rent.deposit, 'both storage deposits back to the person')
  assert.equal(afterOpen.relayerSol - afterClose.relayerSol, close.networkFee, 'the relayer gets nothing back')
  assert.equal(close.charge, BigInt(close.networkFee))

  // ---- A receipt's sweep: to the relayer, which fronted its rent. Anyone sends it ----
  await send([SystemProgram.transfer({ fromPubkey: setup.publicKey, toPubkey: first.keys.escrow, lamports: GIFT })], [setup])
  const beforeSweep = await balances()
  await send([escrow.sweepRentIx({ escrow: first.keys.escrow, payer: relayer.publicKey })], [setup])
  const afterSweep = await balances()
  assert.equal(afterSweep.relayerSol - beforeSweep.relayerSol, GIFT, "to the relayer, which fronted the escrow's rent")
  assert.equal(afterSweep.personSol, beforeSweep.personSol, 'not to the person')
  assert.equal(await connection.getBalance(first.keys.escrow), rent.escrow, 'the receipt keeps exactly its minimum')

  // ---- In a Token-2022 dollar: Open USD, paid then released, through Kora ----
  // The escrow calls Token-2022, which kora.toml allows; the relayer is still paid in the test
  // dollar. The person and the seller hold Open USD accounts already.
  const openUsd = await tokenOf(OPEN_USD)
  assert.equal(openUsd.program.toBase58(), TOKEN_2022.toBase58())
  const ousd = (owner: PublicKey) => getAssociatedTokenAddressSync(OPEN_USD, owner, false, TOKEN_2022)
  await send(
    [
      ...[person, seller].map((k) => createAssociatedTokenAccountIdempotentInstruction(setup.publicKey, ousd(k.publicKey), k.publicKey, OPEN_USD, TOKEN_2022)),
      createMintToInstruction(OPEN_USD, ousd(person.publicKey), setup.publicKey, 10_000_000n, [], TOKEN_2022),
    ],
    [setup],
  )
  const fourth = deal(2_000_000n, openUsd)
  // In one tap, Kora 2.0.5 refuses: for a Token-2022 transfer whose destination exists (here the
  // escrow's payout to the seller, inside its own call), it reads the source, the deposit address
  // the same transaction makes, and finds none. Nothing lands.
  refusals.oneTapInToken2022 = await refused(fourth.oneTap, 1_000_000n, /not found/)
  const beforePayT22 = await balances()
  const payT22 = await throughKora(fourth.pay)
  const afterPayT22 = await balances()
  const payT22Spent = beforePayT22.relayerSol - afterPayT22.relayerSol
  rent.depositT22 = await connection.getBalance(fourth.keys.vault)
  assert.ok(rent.depositT22 > rent.deposit, "Open USD's deposit account is larger than a classic one: its extensions")
  assert.equal(payT22Spent, payT22.networkFee + rent.escrow + rent.depositT22, "the relayer's SOL: the network fee, the escrow and the Open USD deposit address")
  assert.equal(payT22.charge, BigInt(payT22Spent), 'charged once for each, in the test dollar')
  const releaseT22 = await throughKora([fourth.release])
  const afterReleaseT22 = await balances()
  assert.equal((await getAccount(connection, ousd(seller.publicKey), 'confirmed', TOKEN_2022)).amount, 2_000_000n, 'the seller holds the two Open USD')
  assert.equal(afterReleaseT22.personSol - afterPayT22.personSol, rent.depositT22, "the deposit address's rent back to the person")
  assert.equal(releaseT22.charge, BigInt(releaseT22.networkFee))

  const end = await balances()
  const refunded = 3 * rent.deposit + rent.escrow + rent.depositT22 // release, one tap, close (both), Open USD release
  assert.equal(end.personSol, refunded, 'the person was never given a lamport but its own refunds')
  const lamports = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} lamports`
  console.log('\n== the relayer, Kora 2.0.5, on a local validator ==')
  console.log(`   rent here: row ${lamports(rent.row)}, escrow ${lamports(rent.escrow)}, deposit address ${lamports(rent.deposit)}`)
  console.log(`   registry row: ${reg.wire} bytes, ${reg.units} units, network fee ${lamports(reg.networkFee)}; charged ${reg.charge} test-dollar units; relayer spent ${lamports(rowSpent)}`)
  console.log(`   escrow, pay: ${pay.wire} bytes, ${pay.units} units; charged ${pay.charge} units; relayer spent ${lamports(paySpent)}`)
  console.log(`   escrow, release: ${release.wire} bytes, ${release.units} units; charged ${release.charge} units; relayer spent ${lamports(releaseSpent)}`)
  console.log(`   escrow, one tap: ${tap.wire} bytes, ${tap.units} units; charged ${tap.charge} units; relayer spent ${lamports(tapSpent)}`)
  console.log(`   escrow, opened and closed unfunded: charged ${open.charge} + ${close.charge} units`)
  console.log(`   escrow in Open USD (Token-2022), pay: ${payT22.wire} bytes, ${payT22.units} units; charged ${payT22.charge} units; relayer spent ${lamports(payT22Spent)}; its deposit address ${lamports(rent.depositT22)}`)
  console.log(`   escrow in Open USD, release: ${releaseT22.wire} bytes, ${releaseT22.units} units; charged ${releaseT22.charge} units`)
  console.log(`   person: ${START_DOLLARS - end.personTokens} test-dollar units spent in all; ${lamports(end.personSol)} of storage deposits came back to it`)
  console.log(`   relayer: ${lamports(2 * GIFT)} came back to it, a row's refund and a receipt's sweep`)
  console.log('   refused:')
  for (const [name, message] of Object.entries(refusals)) console.log(`     ${name}: ${message.slice(0, 160)}`)
  console.log()
})
