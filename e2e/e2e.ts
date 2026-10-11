// e2e: Forest end to end on devnet, against the services this repo deploys (devnet.json). Devnet only.
//
//   ../standard.sh keys records registry/client escrow/client reputation/client credits
//   (cd ../mcp && npm ci)
//   (cd ../standard/reputation/circuit && npm run fetch)
//   npm ci && FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
//
// Two new people, a seller and a buyer, each the way their app would do it:
//   1. a seed from 24 words, and from it the main key, the inbox key, and the secret and note number
//      for the issuer, by the name the issuer publishes;
//   2. setup: their test-dollar accounts and some dollars, and the buyer's own address apart from its
//      profile, as a wallet app holds one, with a little SOL and a dollar (the deploy key pays;
//      nothing a profile does later needs SOL);
//   3. the issuer's face check (the stand-in passes it): a tier 1 note for each, for its note number.
//      The seller's comes with its welcome gift: its app buys the credits the issuer's gift names, at
//      the registry payer and the host, sends the buys' references with the note request, gets a
//      sponsor's ticket for each, collects each buy with its ticket and finishes the credits. The
//      buyer buys its host credits on Solana: a plain transfer from its own address to the host,
//      naming the buy's reference, then collects the buy with the transaction's signature;
//   4. registered: a row for each at the registry, from a person proof made from the note: the
//      seller's through the registry payer, with one of its ticket's credits, free, the row read on
//      chain and the credit refused once spent; the buyer's through the fee payer, paid in the test
//      dollar;
//   5. each app puts host credits in its folder's balance (the host first refuses a card from a
//      folder holding none), then publishes the profile's hosts record and card, with its inbox key;
//      each card declares an inbox, for senders holding a row from the issuer: the seller's takes one
//      message from each, and lists a read key the seller's app made for its assistant as a reader;
//   6. each app makes its assistant's access keys and lists them in the profile's permissions
//      record: the seller's a write, a message and a read key, the buyer's a write key; the
//      assistants are the CLI (../mcp), given those keys; the seller's posts an offer with a photo, and
//      the seller's app then puts the photo's bytes on the host;
//   7. the inbox: the buyer delivers a message to the seller's inbox, sealed to its inbox key and the
//      read key, and a second one is refused (one each); the seller pulls it with a pull its main
//      key signs, and opens it;
//   8. the seller's assistant, through the CLI: it opens the buyer's message (the message key and
//      the read key) and replies; the buyer sees the message key sent it; it asks the seller, through
//      the seller's own inbox, to post an offer it drafted (`request`), and the seller's app opens
//      the request. The seller makes the message key past and deletes the read key: the CLI refuses
//      both, the host refuses the past key's pull at once, and its message once the host no longer
//      keeps the seller's records it read;
//   9. the buyer pays through the escrow, in one tap, through the fee payer;
//  10. each assistant posts a review of the other, naming the escrow;
//  11. the index shows it: both profiles, their rows counted under the issuer's key, the offer with
//      its photo from the host, the deal and both reviews at full weight; and not the messages;
//  12. the loop proves: the seller's app finds its leaf among the index's reputation leaves, proves
//      its own rating in its market on the device (forest's reputation circuit), at the stamp of its
//      own row, writes the proof into its card and publishes it again, and the index shows it;
//  13. the ID check: the seller takes the issuer's second check (the stand-in passes it; free on
//      devnet), gets its note back at tier 2, proves its tier on the device, puts the proof on its
//      card beside the rating's, and the index shows it ID-checked, its row at tier 2's weight.
// Everything it did goes to runs/<time>.json.

import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, createTransferCheckedInstruction } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

import { exportWords, importWords, inboxKey, issuerSecret, mainKey, newSeed, type InboxKey, type MainKey } from '../standard/keys/src/index.ts'
import { type AccessKey, type Body, type Json, RecordError, b64u, deliver, encodeMessage, getBlob, hex, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, pull, pullRequest, putBlob, readProfile } from '../standard/records/src/index.ts'
import { message, openMessage, readerCount } from '../standard/records/src/private.ts'
import { type SignedNote, buildRegistration, fetchRow, issuerKeyBytes, noteFromJson, noteSigned, provePerson, registerIx, stampOf, toBytes32, verifyTier } from '../standard/registry/client/src/index.ts'
import { type Credit, type Service, DIRECTORY_PATH, PAYMENT_HEADER, amountOf, authorization, buy, creditList, finish, serviceOf } from '../standard/credits/src/index.ts'
import * as escrow from '../standard/escrow/client/src/index.ts'
import { proofBytes, proveReputation } from '../standard/reputation/client/src/index.ts'
import { ACTIONS, Refusal, checkArgs } from '../mcp/src/actions.ts'
import type { Context } from '../mcp/src/forest.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'devnet.json'), 'utf8')) as Record<string, string>
const RPC = process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : cfg.rpc!
const PERSON = { wasm: join(here, '../standard/registry/circuit/devnet/person.wasm'), zkey: join(here, '../standard/registry/circuit/devnet/person.zkey') }
const REPUTATION = { wasm: join(here, '../standard/reputation/circuit/devnet/reputation.wasm'), zkey: join(here, '../standard/reputation/circuit/devnet/reputation.zkey') }
const DOLLAR = 1_000_000n

/**
 * A devnet key from the devnet phrase, by the recipe in forest's devnet/deploy.sh scripts:
 * PBKDF2-HMAC-SHA256(phrase, "forest-devnet:" + label, 600,000 iterations, 32 bytes) as the ed25519 seed.
 */
function devnetKey(label: string): Keypair {
  const phrase = process.env.FOREST_DEVNET_SEED
  if (!phrase) throw new Error('FOREST_DEVNET_SEED is not set: the devnet phrase pays for setup and mints the test dollar')
  const normal = phrase.normalize('NFKD').trim().split(/\s+/).join(' ')
  return Keypair.fromSeed(pbkdf2Sync(Buffer.from(normal, 'utf8'), Buffer.from(`forest-devnet:${label}`, 'utf8'), 600_000, 32, 'sha256'))
}

const connection = new Connection(RPC, 'confirmed')
const deployKey = devnetKey('deploy')
const dollarAuthority = devnetKey('test-dollar-authority')
const DOLLAR_MINT = new PublicKey(cfg.testDollar!)
const ESCROW = new PublicKey(cfg.escrow!)
const REGISTRY = new PublicKey(cfg.registry!)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const started = new Date()
const record: Record<string, unknown> = { started: started.toISOString(), services: cfg, steps: {} }
const steps = record.steps as Record<string, unknown>
/** What each folder did at the host: the card refused unpaid, the credits spent into it, what was left. */
const hostSteps: Record<string, Record<string, unknown>> = {}
const redact = (text: string) => (process.env.HELIUS_API_KEY ? text.split(process.env.HELIUS_API_KEY).join('<key>') : text)

function say(line: string) {
  console.log(`[${((Date.now() - started.getTime()) / 1000).toFixed(0).padStart(4)} s] ${line}`)
}

async function waitFor<T>(what: string, ms: number, get: () => Promise<T | null | undefined | false>, every = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    try {
      const got = await get()
      if (got) return got
    } catch (err) {
      if (Date.now() > until) throw err
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(every)
  }
}

async function confirm(signature: string): Promise<void> {
  await waitFor(`${signature} to confirm`, 120_000, async () => {
    const status = (await connection.getSignatureStatuses([signature])).value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    return status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized'
  }, 1000)
}

/** Setup only: the deploy key pays. Nothing a person does goes through here. */
async function setupSend(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = deployKey.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(deployKey, ...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  return signature
}

/** `amount`, decimal text in whole tokens, in base units of `decimals`. */
const units = (amount: string, decimals: number): bigint => {
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole! + fraction.padEnd(decimals, '0'))
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

// ---- The fee payer, as a person's app calls it ----

class KoraError extends Error {}
/** Kora's JSON-RPC at the fee payer, or, for `getPayerSigner` only, at the registry payer. */
async function kora<T>(method: string, params: Record<string, unknown> = {}, at = cfg.feePayer!): Promise<T> {
  const { body } = await post(at, { jsonrpc: '2.0', id: 1, method, params })
  if (body.error) throw new KoraError(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

type Paid = { signature: string; charge: string; bytes: number }

/**
 * What a person's app does to send through the fee payer, at cost: the transaction with the
 * fee payer as payer and a payment to it in the test dollar already in place (Kora's price counts
 * it), the price asked, the payment set to exactly that, the main key signs, Kora checks, co-signs
 * and sends.
 */
async function throughFeePayer(signer: Keypair, instructions: TransactionInstruction[], token: escrow.Token): Promise<Paid> {
  const payer = await kora<{ signer_address: string; payment_address: string }>('getPayerSigner')
  const feePayer = new PublicKey(payer.signer_address)
  const paymentTo = escrow.associatedTokenAddress(new PublicKey(payer.payment_address), token.mint, token.program)
  const payFrom = escrow.associatedTokenAddress(signer.publicKey, token.mint, token.program)
  const pay = (amount: bigint) => escrow.transferIx({ from: payFrom, to: paymentTo, owner: signer.publicKey, mint: token.mint, amount, decimals: token.decimals, tokenProgram: token.program })
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const compile = (ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  const estimate = await kora<{ fee_in_token: number | null }>('estimateTransactionFee', {
    transaction: Buffer.from(compile([...instructions, pay(0n)]).serialize()).toString('base64'),
    fee_token: token.mint.toBase58(),
    sig_verify: false,
  })
  assert.ok(estimate.fee_in_token !== null, 'Kora quotes in the dollar')
  const charge = BigInt(estimate.fee_in_token)
  const tx = compile([...instructions, pay(charge)])
  tx.sign([signer])
  const wire = tx.serialize()
  const { signature } = await kora<{ signature: string }>('signAndSendTransaction', { transaction: Buffer.from(wire).toString('base64') })
  await confirm(signature)
  return { signature, charge: charge.toString(), bytes: wire.length }
}

// ---- The issuer, as a person's app reads it ----

/** Who the issuer is, as it publishes itself: its name, which each person's secret is mixed under, its key, and its welcome gift. */
type Issuer = { name: string; key: string; gift: Record<'registryPayer' | 'host', { origin: string; credits: number }> }

async function readIssuer(): Promise<Issuer> {
  const { status, body } = await json(`${cfg.issuer}/issuer.json`)
  assert.equal(status, 200, `the issuer says who it is: ${JSON.stringify(body)}`)
  assert.equal(body.key, cfg.issuerKey, 'with the key the index trusts')
  assert.deepEqual(Object.keys(body.gift ?? {}).sort(), ['host', 'registryPayer'], 'a welcome gift at the registry payer and the host')
  assert.equal(body.gift.registryPayer.origin, cfg.registryPayer)
  assert.equal(body.gift.host.origin, cfg.host)
  return { name: body.name, key: body.key, gift: body.gift }
}

/** A service that sells credits, from its directory, as an app reads it. */
async function serviceAt(origin: string): Promise<Service> {
  const { status, body } = await json(`${origin}${DIRECTORY_PATH}`)
  assert.equal(status, 200, `${origin} publishes its credits: ${JSON.stringify(body)}`)
  return serviceOf(origin, body)
}

/** A note as the issuer sends it: the registry client's JSON form, the one a vault keeps (`noteFromJson`). */
const noteOf = (j: unknown): SignedNote => noteFromJson(j)

// ---- A person, as their app holds them ----

type Person = {
  role: 'seller' | 'buyer'
  name: string
  label: string
  profile: MainKey
  /** The main key as a Solana signer: the same key. */
  signer: Keypair
  /** The inbox key, mixed from the main key: what messages to the profile are sealed to. */
  inboxKey: InboxKey
  /** The person's secret for the issuer, mixed from the seed under the issuer's name, and its note number. */
  secret: Uint8Array
  noteNumber: bigint
  /** The issuer's note, once the face check is done. The app keeps it as it keeps a key. */
  note?: SignedNote
  /** That note as the issuer sent it, which the ID check takes back. */
  sent?: unknown
  /** The credits its app holds, as it keeps a key: by service. */
  credits?: { registryPayer: Credit[]; host: Credit[] }
  /** The buyer's own address apart from its profile, as a wallet app holds one: what it pays the host from. */
  wallet?: Keypair
}

async function newPerson(role: Person['role'], name: string, issuer: Issuer): Promise<Person> {
  const words = exportWords(newSeed())
  // The person keeps the words; the app asks for them, mixes what it needs, and forgets them.
  const seed = importWords(words)
  assert.equal(exportWords(seed), words, 'the words give the seed back')
  const label = `${cfg.market}/${role}`
  const profile = await mainKey(seed, label)
  assert.equal((await mainKey(importWords(words.toUpperCase().split(' ').join('  '))!, label)).address, profile.address, 'case and spacing do not matter')
  const inbox = await inboxKey(profile.privateKey)
  const { secret, noteNumber } = await issuerSecret(seed, issuer.name)
  seed.fill(0)
  return { role, name, label, profile, signer: Keypair.fromSeed(profile.privateKey), inboxKey: inbox, secret, noteNumber }
}

// ---- Steps ----

async function setup(people: Person[]): Promise<escrow.Token> {
  say('setup: each person’s test-dollar account, and dollars; the buyer’s own address, with a little SOL and a dollar; the deploy key pays')
  const token = escrow.tokenOf(DOLLAR_MINT, (await connection.getAccountInfo(DOLLAR_MINT))!)
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
  const [seller, buyer] = people as [Person, Person]
  buyer.wallet = Keypair.generate()
  const accounts = await setupSend(
    [...people.map((p) => p.signer), buyer.wallet].map((k) => createAssociatedTokenAccountIdempotentInstruction(deployKey.publicKey, ata(k.publicKey), k.publicKey, token.mint, token.program)),
    [],
  )
  const minted = await setupSend(
    [
      createMintToCheckedInstruction(DOLLAR_MINT, ata(seller.signer.publicKey), dollarAuthority.publicKey, 5n * DOLLAR, token.decimals, [], token.program),
      createMintToCheckedInstruction(DOLLAR_MINT, ata(buyer.signer.publicKey), dollarAuthority.publicKey, 10n * DOLLAR, token.decimals, [], token.program),
      createMintToCheckedInstruction(DOLLAR_MINT, ata(buyer.wallet.publicKey), dollarAuthority.publicKey, DOLLAR, token.decimals, [], token.program),
      SystemProgram.transfer({ fromPubkey: deployKey.publicKey, toPubkey: buyer.wallet.publicKey, lamports: 10_000_000 }),
    ],
    [dollarAuthority],
  )
  steps.setup = { accounts, minted, seller: '5.00', buyer: '10.00', buyerWallet: { address: buyer.wallet.publicKey.toBase58(), dollars: '1.00', sol: '0.01' } }
  return token
}

/**
 * Stage 1, the face check, as the app does it: a session, the check (the stand-in passes it), then
 * the person's note number sent, and a tier 1 note back, checked (`keepNote`). The seller's comes
 * with the welcome gift: a sponsor's ticket for each of its buys, which each service takes at once.
 */
async function faceNote(p: Person, issuer: Issuer) {
  const session = await post(`${cfg.issuer}/session`, {})
  assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
  if (p.role === 'buyer') {
    const got = await post(`${cfg.issuer}/note`, { sessionId: session.body.sessionId, noteNumber: p.noteNumber.toString() })
    assert.equal(got.status, 200, `a note: ${JSON.stringify(got.body)}`)
    return keepNote(p, got.body.note)
  }
  // The gift: one buy at each service, of as many credits as the issuer's gift names there, and a ticket for each.
  const services = { registryPayer: await serviceAt(issuer.gift.registryPayer.origin), host: await serviceAt(issuer.gift.host.origin) }
  const buys = { registryPayer: await buy(services.registryPayer, issuer.gift.registryPayer.credits), host: await buy(services.host, issuer.gift.host.credits) }
  const gift = { registryPayer: buys.registryPayer.reference, host: buys.host.reference }
  const got = await post(`${cfg.issuer}/note`, { sessionId: session.body.sessionId, noteNumber: p.noteNumber.toString(), gift })
  assert.equal(got.status, 200, `a note: ${JSON.stringify(got.body)}`)
  assert.deepEqual(Object.keys(got.body.gift ?? {}).sort(), ['host', 'registryPayer'], `and a ticket for each buy: ${JSON.stringify(got.body.gift)}`)
  const kept = keepNote(p, got.body.note)

  // Collected with its ticket, at once: the service answers the blind signatures, the app finishes them.
  const collect = async (role: 'registryPayer' | 'host') => {
    const headers = { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `ticket ${got.body.gift[role]}` }
    const res = await fetch(services[role].requestUri, { method: 'POST', headers, body: buys[role].buy as Uint8Array<ArrayBuffer> })
    assert.equal(res.status, 200, `${services[role].origin} takes the ticket: ${await res.clone().text()}`)
    return finish(buys[role].pending, new Uint8Array(await res.arrayBuffer()))
  }
  p.credits = { registryPayer: await collect('registryPayer'), host: await collect('host') }
  assert.equal(p.credits.registryPayer.length, issuer.gift.registryPayer.credits)
  assert.equal(p.credits.host.length, issuer.gift.host.credits)
  say(`${p.role}: ${p.credits.registryPayer.length} registrations and ${p.credits.host.length} host credits, from the issuer's tickets, collected and finished`)
  return { ...kept, gift: { sponsor: String(got.body.gift.host).split('.')[0], registryPayer: { credits: p.credits.registryPayer.length, reference: buys.registryPayer.reference }, host: { credits: p.credits.host.length, reference: buys.host.reference } } }
}

/** A tier 1 note as the issuer sent it, checked: the issuer's signature, its key, this note number, tier 1. The run's record keeps the model and the tier, never the embedding. */
function keepNote(p: Person, sent: unknown) {
  const note = noteOf(sent)
  assert.ok(noteSigned(note), 'the issuer signed it')
  assert.equal(hex.encode(issuerKeyBytes(note.issuer)), cfg.issuerKey, 'with the key the index trusts')
  assert.equal(note.noteNumber, p.noteNumber, 'for this person’s note number')
  assert.equal(note.tier, 1n, 'at tier 1, the face check')
  p.note = note
  p.sent = sent
  say(`${p.role}: a tier 1 note from the issuer, model ${note.model}`)
  return { model: note.model, tier: note.tier.toString(), embeddingBytes: note.embedding.length }
}

/** How many of the host's credits the buyer buys: enough for its card, a message, its review and its permissions. */
const BUYER_HOST_CREDITS = 20

/**
 * The buyer's host credits, bought on Solana as a wallet app pays a pay link: a buy at the host, a
 * plain transfer from the buyer's own address to the host's naming the buy's reference, not through
 * the fee payer; then, once it is finalized, the buy collected with the transaction's signature.
 */
async function buyHostCredits(p: Person, token: escrow.Token) {
  const service = await serviceAt(cfg.host!)
  assert.equal(service.mint, token.mint.toBase58(), 'the host is paid in the classic test dollar')
  const b = await buy(service, BUYER_HOST_CREDITS)
  const wallet = p.wallet!
  const to = new PublicKey(service.address)
  const into = escrow.associatedTokenAddress(to, token.mint, token.program)
  const transfer = createTransferCheckedInstruction(escrow.associatedTokenAddress(wallet.publicKey, token.mint, token.program), token.mint, into, wallet.publicKey, units(amountOf(service.price, BUYER_HOST_CREDITS), token.decimals), token.decimals, [], token.program)
  transfer.keys.push({ pubkey: new PublicKey(b.reference), isSigner: false, isWritable: false })
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, into, to, token.mint, token.program), transfer)
  tx.feePayer = wallet.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(wallet)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  const answer = await waitFor(`${cfg.host} to find the buyer's payment finalized`, 180_000, async () => {
    const headers = { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `solana ${signature}` }
    const res = await fetch(service.requestUri, { method: 'POST', headers, body: b.buy as Uint8Array<ArrayBuffer> })
    if (res.status === 402) return null
    assert.equal(res.status, 200, `${cfg.host} answers the buy: ${await res.clone().text()}`)
    return new Uint8Array(await res.arrayBuffer())
  })
  p.credits = { registryPayer: [], host: await finish(b.pending, answer) }
  assert.equal(p.credits.host.length, BUYER_HOST_CREDITS)
  say(`${p.role}: ${BUYER_HOST_CREDITS} host credits bought on Solana from its own address, ${signature}, collected and finished`)
  return { signature, from: wallet.publicKey.toBase58(), amount: amountOf(service.price, BUYER_HOST_CREDITS), credits: BUYER_HOST_CREDITS, reference: b.reference }
}

/**
 * Every host credit of the gift into the person's folder's balance, up to 100 a request, as the app
 * spends them (the host's `/credits/spend`, each list as forest's `creditList` writes it). Before, the
 * host refuses the folder's card; `publishCard` checks that first.
 */
async function fundFolder(p: Person): Promise<{ credits: number; requests: number }> {
  let credits = 0
  let requests = 0
  while (p.credits!.host.length) {
    const some = p.credits!.host.splice(0, 100)
    const { status, body } = await post(`${cfg.host}/credits/spend`, { folder: p.profile.address, credits: creditList(some) })
    assert.equal(status, 200, `the host takes the credits: ${JSON.stringify(body)}`)
    credits = body.credits
    requests++
  }
  say(`${p.role}: its host credits in its folder in ${requests} requests; it holds ${credits}`)
  return { credits, requests }
}

/**
 * What a person's app does to have a row paid for by the registry payer: the row's transaction with
 * the registry payer as payer, signed by the main key, and one of its credits in the Authorization
 * header. It costs the person nothing more: no SOL, no dollar. The credit is spent once the row lands:
 * shown again, it is refused as spent.
 */
async function throughRegistryPayer(p: Person, register: TransactionInstruction, row: PublicKey, payer: PublicKey, token: escrow.Token): Promise<Paid & { credit: string; rowOnChain: number }> {
  const credit = p.credits!.registryPayer.shift()!
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [register] }).compileToV0Message())
  tx.sign([p.signer])
  const wire = tx.serialize()
  const dollars = async () => (await connection.getTokenAccountBalance(escrow.associatedTokenAddress(p.signer.publicKey, token.mint, token.program))).value.amount
  const before = await dollars()
  const shown = (transaction: Uint8Array = wire) => post(`${cfg.registryPayer}/register`, { transaction: Buffer.from(transaction).toString('base64') }, { authorization: authorization(credit) })
  const { status, body } = await shown()
  assert.equal(status, 200, `the registry payer: ${JSON.stringify(body)}`)
  await confirm(body.signature)
  // Signed and sent by the registry payer itself, no Kora between: the row is on chain, its rent from the registry payer.
  const account = await connection.getAccountInfo(row, 'confirmed')
  assert.ok(account, 'the row exists on chain')
  assert.ok(account.owner.equals(REGISTRY), 'written by the registry')
  assert.equal(await connection.getBalance(p.signer.publicKey), 0, 'the person still holds no SOL')
  assert.equal(await dollars(), before, 'and paid no dollar')
  // The same row again is refused before anything is held: it exists.
  assert.equal((await shown()).body?.error, 'row_exists', 'the same row again: refused, it exists')
  // The credit with another row (a stamp of nobody's, never sent) is refused once the row it paid for counts it spent.
  const another = async () => {
    const ix = registerIx({ profile: new PublicKey(p.profile.publicKey) as never, label: p.label, stamp: new Uint8Array(randomBytes(32)), issuer: p.note!.issuer, tier: 1n, proof: { a: new Uint8Array(32), b: new Uint8Array(64), c: new Uint8Array(32) }, payer: payer as never, programId: REGISTRY as never }) as never as TransactionInstruction
    const other = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash, instructions: [ix] }).compileToV0Message())
    other.sign([p.signer])
    return other.serialize()
  }
  const again = await waitFor('the registry payer to count the credit spent', 90_000, async () => {
    const r = await shown(await another())
    return r.body?.error === 'spent' ? r.body.error : null
  }, 3000)
  return { signature: body.signature, charge: '0', bytes: wire.length, credit: again, rowOnChain: account.lamports }
}

/**
 * A row at the registry, from a person proof made on the device from the note. Read back: it names
 * the profile, the issuer's key, the key that paid for it as payer, and when the program wrote it;
 * and the proof shows tier 1 against it, as a reader checks a tier a profile shows.
 */
async function register(p: Person, token: escrow.Token, path: 'credit' | 'paid') {
  // The payer each names: the registry payer's key, or the fee payer's.
  const payer = await kora<{ signer_address: string }>('getPayerSigner', {}, path === 'credit' ? cfg.registryPayer! : cfg.feePayer!)
  const feePayer = new PublicKey(payer.signer_address)
  const registration = await buildRegistration({
    secret: p.secret,
    note: p.note!,
    label: p.label,
    // The client checks a key against its own copy of web3.js; it reads only its bytes.
    profile: new PublicKey(p.profile.publicKey) as never,
    artifacts: PERSON,
    payer: feePayer as never,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    programId: REGISTRY as never,
  })
  const ix = registration.instruction as never as TransactionInstruction
  const paid = path === 'credit' ? await throughRegistryPayer(p, ix, registration.row as never as PublicKey, feePayer, token) : await throughFeePayer(p.signer, [ix], token)
  const row = await fetchRow(connection as never, registration.stamp, { programId: REGISTRY as never })
  assert.ok(row, 'the row is there')
  assert.equal(row.label, p.label)
  assert.equal(row.profile.toBase58(), p.profile.address, 'it names the profile')
  assert.equal(hex.encode(issuerKeyBytes(row.issuer)), cfg.issuerKey, 'and the issuer’s key')
  assert.equal(row.payer.toBase58(), payer.signer_address, 'and the key that paid for it as its payer')
  assert.ok(Math.abs(row.made - Date.now() / 1000) < 600, 'made now, by the chain’s clock')
  const shown = await verifyTier(connection as never, { profile: p.profile.publicKey, stamp: registration.stamp, tier: 1n, proof: registration.proof }, { programId: REGISTRY as never })
  assert.ok(shown, 'the proof shows tier 1 against the row')
  say(`${p.role}: row ${p.label} ${'credit' in paid ? 'through the registry payer, with one of its credits, spent once the row landed' : 'through the fee payer, paid'}, ${paid.signature}`)
  return { label: p.label, path, row: registration.row.toBase58(), stamp: hex.encode(toBytes32(registration.stamp)), made: row.made, ...paid }
}

/**
 * The card, as the app publishes it, with the profile's inbox key and its inbox: messages from keys
 * holding a row from the issuer, named by its key. The seller's takes one from each, sealed to
 * `readers` too; the buyer's takes the seller's replies, as many as come, so a message refused in
 * the assistant's step is refused for its key alone. Returned, so the app can publish it again.
 */
async function publishCard(p: Person, readers: string[] = []) {
  const now = Date.now()
  const card = {
    name: p.name,
    market: cfg.market!,
    role: p.role,
    about: p.role === 'seller' ? 'Maths lessons online. A devnet test profile, made by e2e.' : 'A devnet test profile, made by e2e.',
    inboxKey: p.inboxKey.recipient,
    inbox: { senders: { issuer: cfg.issuerKey! }, ...(p.role === 'seller' && { once: true as const }), ...(readers.length > 0 && { readers }) },
    createdAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  // A folder holding no credits here: its hosts record is free, its card is refused.
  const [unpaid] = await publish([cfg.host!], [hostsRecord(p.profile, [cfg.host!], now), ownerRecord(p.profile, 'profile', card, now)])
  assert.deepEqual(unpaid!.results.map((r) => r.error ?? 'ok'), ['ok', 'policy'], `the host takes the hosts record free and refuses an unpaid card: ${JSON.stringify(unpaid)}`)
  const funded = await fundFolder(p)
  const [outcome] = await publish([cfg.host!], [ownerRecord(p.profile, 'profile', card, now)])
  assert.ok(outcome!.results.every((r) => r.ok), `the host took the card: ${JSON.stringify(outcome)}`)
  say(`${p.role}: hosts record and card on the host, as ${p.profile.address}`)
  hostSteps[p.role] = { unpaidCard: 'policy', spent: funded.credits, requests: funded.requests }
  return card
}
type Card = Awaited<ReturnType<typeof publishCard>>

/** An access key an app made, as its permissions record lists it, and as the assistant is given it. */
type Made = { listed: AccessKey; key: string }

/** A write key for offers and reviews, or a message key: 32 random bytes, given in base64url as a grant writes them. */
function made(scope: 'write' | 'message'): Made {
  const k = keyFromPrivate(randomBytes(32))
  return { listed: { key: k.address, scope, ...(scope === 'write' && { paths: ['offer', 'review'] }) }, key: b64u.encode(k.privateKey) }
}

/**
 * The app lists the keys it made in the profile's permissions record, signed with the main key, and
 * gives them to the assistant: the CLI (../mcp), with the profile, the host to start from and the keys.
 */
async function assistantFor(p: Person, keys: Made[]): Promise<Context> {
  const [outcome] = await publish([cfg.host!], [permissionsRecord(p.profile, keys.map((k) => k.listed), Date.now())])
  assert.ok(outcome!.results[0]!.ok, `the host took the permissions record: ${JSON.stringify(outcome)}`)
  const given = Object.fromEntries(keys.map((k) => [k.listed.scope, k.key]))
  say(`${p.role}: an assistant given ${keys.map((k) => `a ${k.listed.scope} key`).join(', ')}, each on the profile's permissions list`)
  return { hosts: [cfg.host!], profile: p.profile.address, keys: given }
}

/**
 * One of the CLI's actions, run the way its typed door runs one (../mcp/src/main.ts): the
 * arguments checked, then the action with the assistant's context. In process, so the keys stay in
 * the run's memory and never go into an environment.
 */
async function cli(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const action = ACTIONS.find((a) => a.name === name)!
  return action.run(checkArgs(action, args), ctx)
}

/** The CLI's refusal, in its words; an action that is not refused fails the run. */
async function refusal(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    await cli(ctx, name, args)
  } catch (err) {
    if (err instanceof Refusal) return err.message
    throw err
  }
  throw new Error(`${name} was not refused`)
}

/** A 16 by 16 PNG of one colour, chosen at random, so each run's photo is new bytes with a new hash. */
function photo(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), data.length + 8)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(16, 0)
  header.writeUInt32BE(16, 4)
  header[8] = 8 // bits per sample
  header[9] = 2 // RGB
  const line = Buffer.concat([Buffer.of(0), Buffer.alloc(16 * 3, randomBytes(3))])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: 16 }, () => line)))
  return Buffer.concat([Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

/**
 * The inbox: the buyer's app reads the seller's card for its inbox, its inbox key and its readers,
 * puts a message in one envelope sealed to all of them, signs it with the buyer's main key and
 * delivers it to the seller's hosts. A second one is refused: one from each sender. The seller's app
 * pulls its inbox with a pull its main key signs, and opens the one message with its inbox key.
 */
async function inbox(from: Person, to: Person, readKey: InboxKey) {
  const seller = await readProfile([cfg.host!], to.profile.address, Date.now())
  const card = seller.current.get('profile')!.record.body as Body & { inboxKey: string; inbox: unknown }
  assert.deepEqual(card.inbox, { senders: { issuer: cfg.issuerKey }, once: true, readers: [readKey.recipient] }, 'the seller’s card declares the inbox, and the read key as a reader')
  assert.equal(card.inboxKey, to.inboxKey.recipient)
  const text = 'Tuesday at six works for me. A devnet test message, made by e2e.'
  const first = await message(from.profile, to.profile.address, { text }, Date.now(), card)
  assert.equal(readerCount(first.body), 2, 'one envelope, sealed to the seller’s inbox key and to the read key')
  // A row lookup the host could not make is the sender's to try again.
  const [taken] = await waitFor('the seller’s host to take the message', 60_000, async () => {
    const out = await deliver(seller.hosts, [first])
    return out[0]?.results[0]?.error === 'lookup' ? null : out
  })
  assert.ok(taken!.results[0]?.ok, `the seller’s host took the message: ${JSON.stringify(taken)}`)
  const second = await message(from.profile, to.profile.address, { text: 'And Thursday? A devnet test message, made by e2e.' }, Date.now(), card)
  const [refused] = await deliver(seller.hosts, [second])
  assert.equal(refused!.results[0]?.error, 'once', `a second message from the buyer is refused: ${JSON.stringify(refused)}`)

  const page = await pull(cfg.host!, pullRequest(to.profile, 0, Date.now()))
  assert.equal(page.messages.length, 1, 'one message in the seller’s inbox')
  const opened = await openMessage(page.messages[0]!.message, to.inboxKey.identity)
  assert.deepEqual([opened.from, opened.body], [from.profile.address, { text }], 'from the buyer, opened by the seller’s inbox key')
  say('buyer: a message to the seller’s inbox, a second refused (one each); the seller pulled it and opened it')
  return { to: to.profile.address, from: from.profile.address, rule: card.inbox, message: taken!.results[0]!.id, bytes: Buffer.byteLength(encodeMessage(first)), sealedTo: 2, second: 'once', pulled: page.messages.length, text }
}

/**
 * The seller's assistant, through the CLI, with the keys the seller's app made. It opens the
 * seller's inbox (`inbox`, the message key and the read key), replies to the buyer (`send`, signed by
 * the message key for the seller and naming the seller's host, where the buyer's host reads the
 * seller's permissions), and asks the seller to post an offer it drafted (`request`, a message to the
 * seller's own inbox), which the seller's app pulls with its main key and opens, and the CLI marks.
 * Then the seller makes the message key past and deletes the read key, from its permissions record
 * and from its card's readers. The CLI refuses both keys; the host refuses the past key's pull at
 * once, and its message once it no longer keeps the seller's records it read (`senderCacheSeconds`
 * in devnet.json, the host's setting). Returns the card as it now is.
 */
async function assistant(seller: Person, buyer: Person, ctx: Context, keys: Made[], card: Card, asked: string) {
  const messageKey = keys.find((k) => k.listed.scope === 'message')!
  const box = await cli(ctx, 'inbox')
  assert.equal(box.messages.length, 1, 'the message key pulls the seller’s inbox')
  assert.deepEqual([box.messages[0].from, box.messages[0].body], [buyer.profile.address, { text: asked }], 'the buyer’s message, opened by the read key')

  // A host that could not read the seller's records, or look up a row, is the sender's to try again.
  const sent = (name: string, args: Record<string, unknown>, what: string) =>
    waitFor(what, 60_000, async () => {
      try {
        return await cli(ctx, name, args)
      } catch (err) {
        if (err instanceof Refusal && err.message.includes(': lookup')) return null
        throw err
      }
    })
  const text = 'Tuesday at six, yes. A devnet test reply, sent through forest’s CLI by e2e.'
  const reply = await sent('send', { to: buyer.profile.address, text }, 'the buyer’s host to take the reply')
  const buyerPage = await pull(cfg.host!, pullRequest(buyer.profile, 0, Date.now()))
  assert.equal(buyerPage.messages.length, 1, 'one message in the buyer’s inbox')
  const got = await openMessage(buyerPage.messages[0]!.message, buyer.inboxKey.identity)
  assert.deepEqual([got.from, got.key, got.body], [seller.profile.address, messageKey.listed.key, { text }], 'from the seller, sent by its message key')
  say(`seller's assistant: opened the buyer's message with the message key ${messageKey.listed.key} and the read key, and replied; the buyer saw the message key sent it`)

  const drafted = { offer: { direction: 'offer', description: 'One hour of physics tutoring, online. A devnet test offer, drafted by an assistant through e2e.', remote: true }, id: 'physics' }
  const requested = await sent('request', { action: 'post-offer', params: drafted }, 'the seller’s host to take the request')
  const own = await pull(cfg.host!, pullRequest(seller.profile, 0, Date.now()))
  const asking = own.messages.find((m) => m.message.from === seller.profile.address && m.message.key === messageKey.listed.key)
  assert.ok(asking, 'the request is in the seller’s inbox')
  const opened = await openMessage(asking.message, seller.inboxKey.identity)
  assert.deepEqual(opened.body, { request: 'post-offer', ...drafted }, 'the seller’s app opens the request with its inbox key')
  const marked = (await cli(ctx, 'inbox')).messages.filter((m: { request?: string }) => m.request)
  assert.deepEqual(marked.map((m: { request: string }) => m.request), ['post-offer'], 'and the CLI marks it, and only it, as a request')
  say('seller\'s assistant: asked the seller to post an offer it drafted; the seller\'s app pulled the request and opened it')

  // The seller makes the message key past, keeps the write key, and deletes the read key's entry,
  // then drops it from its inbox's readers, so no message is sealed to it any more.
  const pastAt = Date.now()
  const access = keys.flatMap((k): AccessKey[] => (k.listed.scope === 'read' ? [] : k.listed.scope === 'message' ? [{ key: k.listed.key, was: 'message' }] : [k.listed]))
  const now = { ...card, inbox: { senders: card.inbox.senders, once: true as const } }
  const [changed] = await publish([cfg.host!], [permissionsRecord(seller.profile, access, pastAt), ownerRecord(seller.profile, 'profile', now, pastAt)])
  assert.ok(changed!.results.every((r) => r.ok), `the host took the permissions record and the card: ${JSON.stringify(changed)}`)

  const pastSend = await refusal(ctx, 'send', { to: buyer.profile.address, text: 'And Thursday?' })
  assert.match(pastSend, /this key is past/, 'the CLI refuses the past message key')
  const goneRead = await refusal({ ...ctx, keys: { read: ctx.keys.read! } }, 'private')
  assert.match(goneRead, /not listed/, 'and the deleted read key')
  const key = keyFromPrivate(b64u.decode(messageKey.key))
  await assert.rejects(pull(cfg.host!, pullRequest({ key, profile: seller.profile.address }, 0, Date.now())), (err: RecordError) => err.code === 'permission', 'the host refuses the past key’s pull at once')
  const wait = Number(cfg.senderCacheSeconds) * 1000 + 10_000 - (Date.now() - pastAt)
  say(`seller: the message key past and the read key deleted; the CLI refuses both, and the host the past key's pull; waiting ${Math.ceil(wait / 1000)} s for the buyer's host to read the seller's records again`)
  await sleep(wait)
  const buyerCard = (await readProfile([cfg.host!], buyer.profile.address, Date.now())).current.get('profile')!.record.body!
  const late = await message({ key, from: seller.profile.address, host: cfg.host! }, buyer.profile.address, { text: 'And Thursday? A devnet test message, by a past message key.' }, Date.now(), buyerCard)
  const [lateOut] = await waitFor('the buyer’s host to answer', 60_000, async () => {
    const out = await deliver([cfg.host!], [late])
    return out[0]?.results[0]?.error === 'lookup' ? null : out
  })
  assert.equal(lateOut!.results[0]?.error, 'permission', `a message by the past key is refused: ${JSON.stringify(lateOut)}`)
  say('seller: a message by the past key, sent without the CLI, refused by the host (permission)')
  return {
    card: now,
    result: {
      keys: Object.fromEntries(keys.map((k) => [k.listed.scope, k.listed.key])),
      pulled: box.messages.length,
      reply: { id: reply.id, bytes: Buffer.byteLength(encodeMessage(buyerPage.messages[0]!.message)), from: got.from, key: got.key, hosts: reply.hosts },
      request: { id: requested.id, body: opened.body },
      after: { cli: { send: pastSend, private: goneRead }, pull: 'permission', waitedMs: Date.now() - pastAt, message: 'permission' },
      texts: [text, drafted.offer.description],
    },
  }
}

async function pay(buyer: Person, seller: Person, offer: { price: { amount: string } }, token: escrow.Token) {
  const payer = new PublicKey((await kora<{ signer_address: string }>('getPayerSigner')).signer_address)
  const terms = escrow.termsFor(undefined, { seller: seller.signer.publicKey, amount: BigInt(offer.price.amount) * DOLLAR })
  const args = { buyer: buyer.signer.publicKey, payer, token, terms, programId: ESCROW }
  const keys = escrow.keysFor({ buyer: args.buyer, payer, mint: token.mint, tokenProgram: token.program, terms, programId: ESCROW })
  const paid = await throughFeePayer(buyer.signer, escrow.payInOneTap(args), token)
  const account = escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  assert.equal(account.status, 'ended')
  assert.equal(account.outcome, 'releasedToSeller')
  assert.equal(account.seller.toBase58(), seller.profile.address)
  assert.equal(account.buyer.toBase58(), buyer.profile.address)
  assert.ok(escrow.escrowAddress(escrow.termsOf(account), ESCROW).equals(keys.escrow), 'its address is its terms’')
  assert.ok(account.rentRecipient.equals(payer), 'its rent goes back to the fee payer, which paid it')
  say(`deal: ${keys.escrow.toBase58()}, paid and released in one tap, ${paid.signature}`)
  return { escrow: keys.escrow.toBase58(), rentTo: payer.toBase58(), ...paid }
}

async function indexShows(seller: Person, buyer: Person, deal: string, offerUri: string, picture: { sha256: string; mimeType: string }, messageTexts: string[]) {
  say('the index: waiting for both profiles, their rows, the offer and its photo, the deal and both reviews')
  const pictureUrl = `${cfg.host}/v1/blobs/${picture.sha256}`
  const profile = (p: Person) => json(`${cfg.index}/profiles/${p.profile.address}.json`)
  const shown = await waitFor('the index to show it all', 900_000, async () => {
    const [s, b] = await Promise.all([profile(seller), profile(buyer)])
    if (s.status !== 200 || b.status !== 200) return null
    for (const [p, v] of [[seller, s.body], [buyer, b.body]] as const) {
      // Its one row, counted, under the issuer's key, which the index names.
      const counted = v.stamps.filter((x: any) => x.label === p.label && x.counted && x.issuer.key === cfg.issuerKey && x.issuer.name !== null)
      if (counted.length !== 1) return null
      // Full evidence: the buyer opened the escrow, and the seller reviewed the deal (`oneSidedConfirmed`).
      if (v.reviews.received.length < 1 || !v.reviews.received.every((r: any) => r.counted && r.evidence.kind === 'oneSidedConfirmed' && r.evidence.weight === 1)) return null
    }
    // The offer, with its photo shown from the host that holds it, as the type the offer names.
    const offer = s.body.offers.find((o: any) => o.uri === offerUri)
    if (offer?.media?.[0]?.url !== pictureUrl || offer.media[0].mimeType !== picture.mimeType) return null
    const d = await json(`${cfg.index}/deals/${deal}.json`)
    if (d.status !== 200 || d.body.receipt?.outcome !== 'releasedToSeller' || d.body.reviews.length !== 2) return null
    return { seller: s.body, buyer: b.body, deal: d.body }
  }, 15_000)
  for (const text of messageTexts) assert.equal(JSON.stringify(shown).includes(text), false, 'no message is anywhere in the index')
  const page = await (await fetch(`${cfg.index}/profiles/${seller.profile.address}`)).text()
  assert.ok(page.includes(`<img src="${pictureUrl}"`), 'the seller’s page shows the photo from the host')
  const issuerName = shown.seller.stamps.find((x: any) => x.issuer.key === cfg.issuerKey).issuer.name as string
  const checkedBy = /Checked by ([^<]*)\. How sure/.exec(page)?.[1] ?? ''
  assert.ok(checkedBy.includes(issuerName), `the seller’s page names the issuer: checked by ${checkedBy}`)
  const bytes = await getBlob([cfg.host!], picture.sha256)
  assert.equal(bytes?.type, picture.mimeType, 'the host serves the bytes the offer names')
  const summary = (v: any) => ({
    url: `${cfg.index}/profiles/${v.address}`,
    stamps: v.stamps.map((b: any) => ({ label: b.label, counted: b.counted, issuer: b.issuer.name, weight: b.issuer.weight, row: b.row })),
    uniqueness: v.scores.uniqueness.map((u: any) => ({ label: u.label, value: u.value })),
    rating: v.scores.rating?.value ?? null,
    standing: v.scores.standing?.value ?? null,
    offers: v.offers.map((o: any) => o.uri),
    pictures: v.offers.flatMap((o: any) => o.media.map((m: any) => m.url)),
    reviewsReceived: v.reviews.received.map((r: any) => ({ uri: r.uri, dealId: r.dealId, counted: r.counted, evidence: r.evidence.kind, weight: r.evidence.weight })),
  })
  steps.index = {
    seller: summary(shown.seller),
    buyer: summary(shown.buyer),
    deal: { url: `${cfg.index}/deals/${deal}`, outcome: shown.deal.receipt.outcome, amount: shown.deal.receipt.amount, reviews: shown.deal.reviews.length },
  }
}

/**
 * The loop proves. The seller's app finds its leaf among the index's leaves by the stamp its secret
 * for the issuer gives under its label (it never asks the index for one leaf), proves its own rating
 * in its market on the device, puts the proof on its card and publishes the card again; the index
 * checks the proof and shows it on the seller's page.
 */
async function proves(p: Person, card: Body) {
  say('seller: waiting for its leaf in the index’s reputation tree, scored')
  const stamp = hex.encode(toBytes32(stampOf(p.secret, p.label)))
  const { tree, leaves } = await waitFor('the seller’s leaf, scored', 900_000, async () => {
    const [t, l] = await Promise.all([json(`${cfg.index}/v1/reputation`), json(`${cfg.index}/v1/reputation/leaves`)])
    // The root the index signs and the leaves it serves are read apart: the same root, or read again.
    if (t.status !== 200 || l.status !== 200 || t.body.root !== l.body.root) return null
    const mine = l.body.leaves.find((x: any) => x.stamp === stamp)
    return mine?.score === 100 && mine.count === 1 ? { tree: t.body, leaves: l.body.leaves as { stamp: string; scope: string; score: number; count: number }[] } : null
  }, 15_000)
  const proof = await proveReputation({
    secret: p.secret,
    labels: [p.label],
    leaves: leaves.map((l) => ({ stamp: BigInt(`0x${l.stamp}`), scope: BigInt(`0x${l.scope}`), score: BigInt(l.score), count: BigInt(l.count) })),
    profileLabel: p.label,
    show: true,
    artifacts: REPUTATION,
  })
  assert.equal(hex.encode(toBytes32(proof.root)), tree.root, 'the proof is against the root the index signed')
  assert.equal(hex.encode(toBytes32(proof.stamp)), stamp, 'and shows the stamp of the seller’s own row, where it lands')
  const entry = {
    circuit: 'reputation',
    index: tree.index,
    root: tree.root,
    time: tree.time,
    signature: tree.signature,
    score: Number(proof.score),
    stamp,
    label: p.label,
    proof: b64u.encode(proofBytes(proof.proof)),
  }
  const proven = { ...card, proofs: [entry] }
  const [outcome] = await publish([cfg.host!], [ownerRecord(p.profile, 'profile', proven, Date.now())])
  assert.ok(outcome!.results.every((r) => r.ok), `the host took the card with the proof: ${JSON.stringify(outcome)}`)
  say(`seller: its rating in ${cfg.market} proven on the device (${proof.score} tenths) against root ${tree.root.slice(0, 12)}…, ${leaves.length} leaves, and on its card`)

  const market = cfg.market!.charAt(0).toUpperCase() + cfg.market!.slice(1).replace(/-/g, ' ')
  const shown = await waitFor('the index to show the proof', 900_000, async () => {
    const v = await json(`${cfg.index}/profiles/${p.profile.address}.json`)
    const x = v.status === 200 ? v.body.proofs?.find((x: any) => x.root === tree.root) : null
    return x?.score === 10 && x.label === p.label ? x : null
  }, 15_000)
  const page = await (await fetch(`${cfg.index}/profiles/${p.profile.address}`)).text()
  const line = `Rated 10.0 of 10 in ${market} (per ${shown.index.name}, `
  assert.ok(page.includes(line), `the seller’s page says ${line}…`)
  steps.reputation = {
    stamp,
    root: tree.root,
    time: tree.time,
    leaves: leaves.length,
    score: Number(proof.score),
    label: p.label,
    shown: { url: `${cfg.index}/profiles/${p.profile.address}`, index: shown.index, time: shown.time },
  }
  return proven
}

/**
 * Stage 2, the ID check, as the app does it: a session on the document check (the stand-in passes
 * it; free on devnet), then the tier 1 note sent, and the same note back at tier 2, checked. Then the
 * tier shown: the app proves on the device with the tier 2 note, for the same label and main key, so
 * at the stamp of the row it already holds; checks the proof against that row as a reader does; puts
 * it on the card beside the rating's proof and publishes the card again. The index checks it and
 * shows the seller ID-checked, its row at the issuer's tier 2 weight, the rating's proof still shown.
 */
async function idChecked(p: Person, card: Body) {
  const session = await post(`${cfg.issuer}/id/session`, {})
  assert.equal(session.status, 201, `an ID session: ${JSON.stringify(session.body)}`)
  const got = await post(`${cfg.issuer}/id/note`, { sessionId: session.body.sessionId, note: p.sent })
  assert.equal(got.status, 200, `a tier 2 note: ${JSON.stringify(got.body)}`)
  const note = noteOf(got.body.note)
  assert.ok(noteSigned(note), 'the issuer signed it')
  assert.equal(hex.encode(issuerKeyBytes(note.issuer)), cfg.issuerKey, 'with the key the index trusts')
  assert.equal(note.noteNumber, p.noteNumber, 'for the same note number')
  assert.equal(note.tier, 2n, 'at tier 2, the ID check')
  assert.deepEqual([note.model, note.embedding], [p.note!.model, p.note!.embedding], 'the same note, at a higher tier')
  say(`${p.role}: a tier 2 note from the issuer's ID check, model ${note.model}`)

  const tier = await provePerson({ secret: p.secret, note, label: p.label, profile: p.profile.publicKey, artifacts: PERSON })
  const stamp = hex.encode(toBytes32(tier.stamp))
  assert.equal(stamp, hex.encode(toBytes32(stampOf(p.secret, p.label))), 'the stamp of the row it holds')
  const proof = proofBytes(tier.proof)
  const row = await verifyTier(connection as never, { profile: p.profile.publicKey, issuer: hex.decode(cfg.issuerKey), label: p.label, stamp: tier.stamp, tier: 2n, proof }, { programId: REGISTRY as never })
  assert.ok(row, 'the proof shows tier 2 against the row, as the index checks it')
  const person = { circuit: 'person', issuer: cfg.issuerKey, label: p.label, stamp, tier: '2', proof: b64u.encode(proof) }
  const proofs = [...(card.proofs as Json[]), person]
  const [outcome] = await publish([cfg.host!], [ownerRecord(p.profile, 'profile', { ...card, proofs }, Date.now())])
  assert.ok(outcome!.results.every((r) => r.ok), `the host took the card with the tier: ${JSON.stringify(outcome)}`)
  say(`${p.role}: its tier 2 proven on the device at its row's stamp ${stamp.slice(0, 12)}…, and on its card beside the rating's`)

  const rating = (steps.reputation as { root: string }).root
  const shown = await waitFor('the index to show the seller ID-checked', 900_000, async () => {
    const v = await json(`${cfg.index}/profiles/${p.profile.address}.json`)
    if (v.status !== 200) return null
    const row = v.body.stamps.find((x: any) => x.label === p.label && x.counted && x.issuer.key === cfg.issuerKey)
    const u = v.body.scores.uniqueness.find((x: any) => x.label === p.label)
    if (row?.tier !== '2' || row.badge !== 'ID-checked' || u?.value !== 0.9) return null
    return { row, uniqueness: u, rated: v.body.proofs.some((x: any) => x.root === rating) }
  }, 15_000)
  assert.ok(shown.rated, 'the rating’s proof still shows')
  const page = await (await fetch(`${cfg.index}/profiles/${p.profile.address}`)).text()
  assert.ok(page.includes('Verified real person, one per market · ID-checked'), 'the seller’s page says ID-checked')
  steps.tier = {
    note: { model: note.model, tier: note.tier.toString() },
    stamp,
    row: shown.row.row,
    shown: { url: `${cfg.index}/profiles/${p.profile.address}`, tier: shown.row.tier, badge: shown.row.badge, issuer: shown.row.issuer.name, weight: shown.row.issuer.weight, uniqueness: shown.uniqueness.value },
  }
}

async function main() {
  const issuer = await readIssuer()
  const run = started.toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const seller = await newPerson('seller', `e2e teacher ${run}`, issuer)
  const buyer = await newPerson('buyer', `e2e student ${run}`, issuer)
  const people = [seller, buyer]
  record.issuer = issuer
  record.people = Object.fromEntries(people.map((p) => [p.role, { profile: p.profile.address, label: p.label }]))
  say(`two people, each from 24 words: seller ${seller.profile.address}, buyer ${buyer.profile.address}; the issuer ${issuer.name}`)

  steps.host = hostSteps
  const token = await setup(people)
  steps.notes = { seller: await faceNote(seller, issuer), buyer: await faceNote(buyer, issuer) }
  steps.bought = { buyer: await buyHostCredits(buyer, token) }
  steps.rows = { seller: await register(seller, token, 'credit'), buyer: await register(buyer, token, 'paid') }

  // The read key the seller's app makes for its assistant, at random (forest's records, "Access
  // keys"): listed among the seller's inbox's readers, so every message to it is sealed to it too.
  const readKey = await inboxKey(randomBytes(32))
  const sellerCard = await publishCard(seller, [readKey.recipient])
  await publishCard(buyer)
  // Each app makes its assistant's keys: the seller's a write, a message and a read key; the buyer's a write key.
  const sellerKeys = [made('write'), made('message'), { listed: { key: readKey.recipient, scope: 'read' as const }, key: readKey.identity }]
  const buyerKeys = [made('write')]
  const sellerAssistant = await assistantFor(seller, sellerKeys)
  const buyerAssistant = await assistantFor(buyer, buyerKeys)
  const bytes = photo()
  const picture = { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', size: bytes.length }
  const offer = {
    direction: 'offer',
    description: 'One hour of maths tutoring, online. A devnet test offer, posted by an assistant through e2e.',
    price: { amount: '1', mint: DOLLAR_MINT.toBase58(), per: 'hour' },
    remote: true,
    media: [picture],
  }
  const posted = await cli(sellerAssistant, 'post-offer', { offer, id: 'maths' })
  const offerUri = `${seller.profile.address}/${posted.path}`
  const view = await readProfile([cfg.host!], seller.profile.address, Date.now())
  assert.equal(view.current.get('offer/maths')!.record.by, sellerKeys[0]!.listed.key, 'the offer is signed by the write key, not the main key')
  say(`seller: offer posted by the assistant, signed by its write key: ${offerUri}`)
  // The seller's app puts the photo on the profile's hosts, after the offer that names it.
  const [put] = await putBlob(view.hosts, bytes, picture.mimeType)
  assert.ok(put!.ok, `the host took the photo: ${JSON.stringify(put)}`)
  assert.equal((await getBlob(view.hosts, picture.sha256))?.type, picture.mimeType, 'and serves it as the type the offer names')
  say(`seller: the offer's photo on the host, ${picture.size} bytes, ${picture.sha256.slice(0, 12)}…`)
  steps.records = { sellerWriteKey: sellerKeys[0]!.listed.key, buyerWriteKey: buyerKeys[0]!.listed.key, offer: offerUri, photo: picture }

  const asked = await inbox(buyer, seller, readKey)
  steps.inbox = asked
  const helped = await assistant(seller, buyer, sellerAssistant, sellerKeys, sellerCard, asked.text)
  steps.assistant = helped.result
  const deal = await pay(buyer, seller, offer, token)
  steps.deal = deal

  const byBuyer = await cli(buyerAssistant, 'post-review', { id: 'maths', review: { subject: seller.profile.address, ratings: { overall: '10' }, text: 'Clear and patient. A devnet test review.', dealId: deal.escrow } })
  const bySeller = await cli(sellerAssistant, 'post-review', { id: 'maths', review: { subject: buyer.profile.address, ratings: { overall: '10' }, text: 'On time, paid at once. A devnet test review.', dealId: deal.escrow } })
  steps.reviews = [`${buyer.profile.address}/${byBuyer.path}`, `${seller.profile.address}/${bySeller.path}`]
  say('two reviews posted by the assistants through the CLI, each naming the deal')

  await indexShows(seller, buyer, deal.escrow, offerUri, picture, [asked.text, ...helped.result.texts])
  say('the index shows it all')

  const proven = await proves(seller, helped.card)
  say('the index shows the seller’s rating, proven')

  await idChecked(seller, proven)
  say('the index shows the seller ID-checked')

  // What each folder's writes took from its balance.
  for (const p of people) {
    const { body } = await json(`${cfg.host}/credits/balance/${p.profile.address}`)
    hostSteps[p.role]!.left = body.credits
  }
}

try {
  await main()
  record.passed = true
} catch (err) {
  record.passed = false
  record.error = redact((err as Error).stack ?? String(err))
  console.error(record.error)
} finally {
  record.ended = new Date().toISOString()
  mkdirSync(join(here, 'runs'), { recursive: true })
  const file = join(here, 'runs', `${started.toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  say(`the run: ${file}`)
}
// The RPC client keeps sockets open, and the proofs' workers; the run is over either way.
process.exit(record.passed ? 0 : 1)
