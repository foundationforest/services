// e2e: Forest end to end on devnet, against the services this repo deploys (devnet.json). Devnet only.
//
//   ../forest.sh keys records registry/client registry/artifacts escrow/client circuits/reputation
//   (cd ../forest/registry/artifacts && npm run fetch) && (cd ../forest/circuits/reputation && npm run fetch)
//   npm ci && FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
//
// Two new people, a seller and a buyer, each the way their app would do it:
//   1. a seed from 24 words, and from it the main key, the inbox key and the list secret;
//   2. setup: their test-dollar accounts and some dollars (the deploy key pays; nothing a person does
//      later needs SOL);
//   3. stamped by the issuer: a face check (the stand-in passes it), the stamp submitted, and listed;
//   4. registered: a row for each, proven against the issuer's newest snapshot and carrying its
//      signature: the seller's through the fee payer's voucher door with a voucher, free; the
//      buyer's through its at-cost door, paid in the test dollar;
//      then the seller passes the issuer's ID check (the stand-in passes it too), lands on the ID
//      list, and registers its profile again, a second row for the same main key, proven against the
//      ID list, through the voucher door with an ID-list voucher (`sponsor/10`);
//   5. each app publishes the profile's hosts record and card, with its inbox key; each card
//      declares an inbox, for senders holding a row from the devnet issuer: the seller's takes one
//      message from each, and lists a read key the seller's app made for its assistant as a reader;
//   6. an assistant connects to each through the key holder (OAuth): each app makes access keys,
//      lists them in the profile's permissions record and hands them to the key holder as grants,
//      the seller's a write, a message and a read key, the buyer's a write key; the seller's
//      assistant posts an offer with a photo; the seller's app then puts the photo's bytes on the host;
//   7. the inbox: the buyer delivers a message to the seller's inbox, sealed to its inbox key and the
//      read key, and a second one is refused (one each); the seller pulls it with a pull its main
//      key signs, and opens it;
//   8. the seller's assistant, through the key holder's tools: it pulls the seller's inbox with the
//      message key, opens the buyer's message with the read key and replies, signed by the message
//      key; the buyer sees the message key sent it; it asks the seller to pay, a message to the
//      seller's own inbox the seller's app opens; the seller revokes the message key: its pull is
//      refused at once, and once the buyer's host no longer keeps the seller's records it read, a
//      second reply is refused;
//   9. the buyer pays through the escrow, in one tap, through the fee payer;
//  10. each assistant posts a review of the other, naming the escrow;
//  11. the index shows it: both profiles, their counted rows and issuers (the seller ID-checked), the
//      offer with its photo from the host, the deal and both reviews at full weight; and not the
//      messages;
//  12. the loop proves: the seller's app finds its leaf among the index's reputation leaves, proves
//      its own rating in its market on the device (forest's circuits), writes the proof into its card
//      and publishes it again, and the index shows it.
// Everything it did goes to runs/<time>.json.

import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

import { exportWords, importWords, listSecret, mainKey, newSeed, readingKey, type MainKey, type ReadingKey } from '../forest/keys/src/index.ts'
import { type AccessKey, type Body, type Grant, b64u, base58, deliver, encodeMessage, getBlob, hex, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, pull, pullRequest, putBlob, readProfile } from '../forest/records/src/index.ts'
import { message, openMessage, readerCount } from '../forest/records/src/private.ts'
import { buildRegistration, fetchRow, issuerSigned, listRoot, marketStampOf, proveStamp, toBytes32 } from '../forest/registry/client/src/index.ts'
import * as escrow from '../forest/escrow/client/src/index.ts'
import { proofBytes, proveReputation } from '../forest/circuits/reputation/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'devnet.json'), 'utf8')) as Record<string, string>
const RPC = process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : cfg.rpc!
const ARTIFACTS = { wasm: join(here, '../forest/registry/artifacts/semaphore-32.wasm'), zkey: join(here, '../forest/registry/artifacts/semaphore-32.zkey') }
const REPUTATION = { wasm: join(here, '../forest/circuits/reputation/devnet/reputation.wasm'), zkey: join(here, '../forest/circuits/reputation/devnet/reputation.zkey') }
const DOLLAR = 1_000_000n
const REDIRECT = 'http://127.0.0.1:9/callback'

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

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const post = (url: string, body: unknown) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- The fee payer, as a person's app calls it ----

class KoraError extends Error {}
async function kora<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const { body } = await post(cfg.feePayer!, { jsonrpc: '2.0', id: 1, method, params })
  if (body.error) throw new KoraError(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

type Paid = { signature: string; charge: string; bytes: number }

/**
 * What a person's app does to send through the fee payer's at-cost door: the transaction with the
 * fee payer as payer and a payment to it in the test dollar already in place (Kora's price counts
 * it), the price asked, the payment set to exactly that, the main key signs, Kora checks, co-signs
 * and sends.
 */
async function throughAtCostDoor(signer: Keypair, instructions: TransactionInstruction[], token: escrow.Token): Promise<Paid> {
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

// ---- A person, as their app holds them ----

type Person = {
  role: 'seller' | 'buyer'
  name: string
  label: string
  profile: MainKey
  /** The main key as a Solana signer: the same key. */
  signer: Keypair
  /** The inbox key, mixed from the main key: what messages to the profile are sealed to. */
  inboxKey: ReadingKey
  stamp: bigint
  secret: Uint8Array
  /** The stamp and secret for the issuer's ID list: one more mix from the seed, under the ID list's key. */
  id: { stamp: bigint; secret: Uint8Array }
}

async function newPerson(role: Person['role'], name: string, issuer: string, idIssuer: string): Promise<Person> {
  const words = exportWords(newSeed())
  // The person keeps the words; the app asks for them, mixes what it needs, and forgets them.
  const seed = importWords(words)
  assert.equal(exportWords(seed), words, 'the words give the seed back')
  const label = `${cfg.market}/${role}`
  const profile = await mainKey(seed, label)
  assert.equal((await mainKey(importWords(words.toUpperCase().split(' ').join('  '))!, label)).address, profile.address, 'case and spacing do not matter')
  const inboxKey = await readingKey(profile.privateKey)
  const list = await listSecret(seed, issuer)
  const idList = await listSecret(seed, idIssuer)
  seed.fill(0)
  return { role, name, label, profile, signer: Keypair.fromSeed(profile.privateKey), inboxKey, stamp: list.stamp, secret: list.secret, id: { stamp: idList.stamp, secret: idList.secret } }
}

// ---- Steps ----

async function setup(people: Person[]): Promise<escrow.Token> {
  say('setup: each person’s test-dollar account, and dollars; the deploy key pays')
  const token = escrow.tokenOf(DOLLAR_MINT, (await connection.getAccountInfo(DOLLAR_MINT))!)
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
  const accounts = await setupSend(
    people.map((p) => createAssociatedTokenAccountIdempotentInstruction(deployKey.publicKey, ata(p.signer.publicKey), p.signer.publicKey, token.mint, token.program)),
    [],
  )
  const [seller, buyer] = people as [Person, Person]
  const minted = await setupSend(
    [
      createMintToCheckedInstruction(DOLLAR_MINT, ata(seller.signer.publicKey), dollarAuthority.publicKey, 5n * DOLLAR, token.decimals, [], token.program),
      createMintToCheckedInstruction(DOLLAR_MINT, ata(buyer.signer.publicKey), dollarAuthority.publicKey, 10n * DOLLAR, token.decimals, [], token.program),
    ],
    [dollarAuthority],
  )
  steps.setup = { accounts, minted, seller: '5.00', buyer: '10.00' }
  return token
}

type ListFile = { v: 1; issuer: string; stamps: string[]; snapshots: { root: string; signature: string; size: number; time: number }[] }

async function stamped(people: Person[]): Promise<ListFile> {
  say('the issuer: a face check each (the stand-in passes it), then each stamp submitted')
  for (const p of people) {
    const session = await post(`${cfg.issuer}/session`, {})
    assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
    const submitted = await post(`${cfg.issuer}/submit`, { sessionId: session.body.sessionId, stamp: p.stamp.toString() })
    assert.equal(submitted.status, 202, `submitted: ${JSON.stringify(submitted.body)}`)
  }
  say('waiting for the issuer’s batch')
  for (const p of people) {
    await waitFor('the stamp on the list', 600_000, async () => (await post(`${cfg.issuer}/status`, { stamp: p.stamp.toString() })).body.status === 'listed', 10_000)
  }
  const list = await readList('/list.json', cfg.issuerAddress!, people.map((p) => p.stamp))
  steps.list = { issuer: list.issuer, stamps: list.stamps.length, snapshot: list.snapshots.at(-1) }
  say(`both on the list: ${list.stamps.length} stamps, root ${list.snapshots.at(-1)!.root.slice(0, 12)}…`)
  return list
}

/** One of the issuer's list files, checked as an app checks it: the issuer the index trusts, the newest snapshot the whole list, its root, its signature, these stamps on it. */
async function readList(path: string, issuer: string, stamps: bigint[]): Promise<ListFile> {
  const list = (await json(`${cfg.issuer}${path}`)).body as ListFile
  assert.equal(list.issuer, issuer, 'the issuer the index trusts')
  const newest = list.snapshots.at(-1)!
  assert.equal(newest.size, list.stamps.length, 'the newest snapshot is the whole list')
  assert.equal(hex.encode(toBytes32(listRoot(list.stamps.map(BigInt)))), newest.root, 'its root is the list’s')
  assert.ok(issuerSigned({ issuer: base58.decode(list.issuer), root: hex.decode(newest.root), issuerSignature: hex.decode(newest.signature) }), 'signed by the issuer')
  for (const stamp of stamps) assert.ok(list.stamps.includes(stamp.toString()), 'each stamp is on the list')
  return list
}

/**
 * The ID check, as the seller's app does it: a session on the ID check (free on devnet), the stamp
 * for the ID list submitted, polled until listed, and the ID list read.
 */
async function idChecked(p: Person): Promise<ListFile> {
  say(`${p.role}: the ID check (the stand-in passes it), then the stamp for the ID list submitted`)
  const session = await post(`${cfg.issuer}/id/session`, {})
  assert.equal(session.status, 201, `an ID session, free on devnet: ${JSON.stringify(session.body)}`)
  const submitted = await post(`${cfg.issuer}/id/submit`, { sessionId: session.body.sessionId, stamp: p.id.stamp.toString() })
  assert.equal(submitted.status, 202, `submitted: ${JSON.stringify(submitted.body)}`)
  await waitFor('the stamp on the ID list', 600_000, async () => (await post(`${cfg.issuer}/id/status`, { stamp: p.id.stamp.toString() })).body.status === 'listed', 10_000)
  const list = await readList('/id/list.json', cfg.idIssuerAddress!, [p.id.stamp])
  steps.idList = { issuer: list.issuer, stamps: list.stamps.length, snapshot: list.snapshots.at(-1) }
  say(`${p.role}: on the ID list: ${list.stamps.length} stamps, signed by ${list.issuer}`)
  return list
}

/** Which list's stamp a row and its voucher are proven from: the list's secret, and the voucher's label. */
type Voucher = { secret: Uint8Array; label: string }

/**
 * What a person's app does to have a row paid for at the voucher door: a voucher, which is a
 * second proof from the same stamp on the list the row is proven against, under a `sponsor/` label
 * (forest's word for it), naming the same main key; the row's transaction with the fee payer as
 * payer, signed by the main key; both to the fee payer's address plus `/vouchers`. It costs the
 * person nothing: no SOL, no dollar.
 */
async function throughVoucherDoor(p: Person, register: TransactionInstruction, feePayer: PublicKey, stamps: bigint[], snapshot: ListFile['snapshots'][number], token: escrow.Token, from: Voucher): Promise<Paid> {
  const v = await proveStamp({ secret: from.secret, label: from.label, profile: p.profile.publicKey, stamps, artifacts: ARTIFACTS })
  const voucher = { proof: v.raw, root: hex.encode(toBytes32(v.root)), issuerSignature: snapshot.signature, label: from.label, marketStamp: hex.encode(toBytes32(v.marketStamp)) }
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: [register] }).compileToV0Message())
  tx.sign([p.signer])
  const wire = tx.serialize()
  const dollars = async () => (await connection.getTokenAccountBalance(escrow.associatedTokenAddress(p.signer.publicKey, token.mint, token.program))).value.amount
  const before = await dollars()
  const { status, body } = await post(`${cfg.feePayer}/vouchers`, { transaction: Buffer.from(wire).toString('base64'), voucher })
  assert.equal(status, 200, `the voucher door: ${JSON.stringify(body)}`)
  await confirm(body.signature)
  assert.equal(await connection.getBalance(p.signer.publicKey), 0, 'the person still holds no SOL')
  assert.equal(await dollars(), before, 'and paid no dollar')
  return { signature: body.signature, charge: '0', bytes: wire.length }
}

async function register(p: Person, list: ListFile, token: escrow.Token, path: 'voucher' | 'paid', from: Voucher = { secret: p.secret, label: 'sponsor/1' }) {
  const newest = list.snapshots.at(-1)!
  const stamps = list.stamps.slice(0, newest.size).map(BigInt)
  // Both doors sign with one key, which the at-cost door names.
  const payer = await kora<{ signer_address: string }>('getPayerSigner')
  const feePayer = new PublicKey(payer.signer_address)
  const registration = await buildRegistration({
    secret: from.secret,
    label: p.label,
    profile: new PublicKey(p.profile.publicKey) as never,
    // As its 32 bytes: the client checks a key against its own copy of web3.js.
    issuer: base58.decode(list.issuer) as never,
    stamps,
    issuerSignature: hex.decode(newest.signature),
    artifacts: ARTIFACTS,
    payer: feePayer as never,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    programId: REGISTRY as never,
  })
  const ix = registration.instruction as never as TransactionInstruction
  const paid = path === 'voucher' ? await throughVoucherDoor(p, ix, feePayer, stamps, newest, token, from) : await throughAtCostDoor(p.signer, [ix], token)
  const row = await fetchRow(connection as never, marketStampOf(from.secret, p.label), { programId: REGISTRY as never })
  assert.ok(row, 'the row is there')
  assert.equal(row.label, p.label)
  assert.equal(row.profile.toBase58(), p.profile.address, 'it names the profile')
  assert.equal(row.issuer.toBase58(), list.issuer, 'and the issuer')
  assert.equal(row.payer.toBase58(), payer.signer_address, 'and the fee payer as its payer')
  assert.ok(issuerSigned(row), "with the issuer's signature on its root")
  say(`${p.role}: row ${p.label} under ${list.issuer} through the fee payer's ${path === 'voucher' ? `voucher door, with the voucher ${from.label}` : 'at-cost door, paid'}, ${paid.signature}`)
  return { label: p.label, issuer: list.issuer, path, ...(path === 'voucher' ? { voucher: from.label } : {}), row: registration.row.toBase58(), ...paid }
}

/**
 * The card, as the app publishes it, with the profile's inbox key and its inbox: messages from keys
 * holding a row from the devnet issuer. The seller's takes one from each, sealed to `readers` too;
 * the buyer's takes the seller's replies, as many as come, so a reply refused in the assistant's step
 * is refused for its key alone. Returned, so the app can publish it again with a proof on it.
 */
async function publishCard(p: Person, readers: string[] = []) {
  const now = Date.now()
  const card = {
    name: p.name,
    market: cfg.market!,
    role: p.role,
    about: p.role === 'seller' ? 'Maths lessons online. A devnet test profile, made by e2e.' : 'A devnet test profile, made by e2e.',
    inboxKey: p.inboxKey.recipient,
    inbox: { senders: { issuer: cfg.issuerAddress! }, ...(p.role === 'seller' && { once: true as const }), ...(readers.length > 0 && { readers }) },
    createdAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const [outcome] = await publish([cfg.host!], [hostsRecord(p.profile, [cfg.host!], now), ownerRecord(p.profile, 'profile', card, now)])
  assert.ok(outcome!.results.every((r) => r.ok), `the host took the hosts record and the card: ${JSON.stringify(outcome)}`)
  say(`${p.role}: hosts record and card on the host, as ${p.profile.address}`)
  return card
}

/** An access key an app made, as its permissions record lists it and as its grant hands it over. */
type Made = { listed: AccessKey; key: string }

/** A write key for offers and reviews, or a message key: 32 random bytes. */
function made(scope: 'write' | 'message'): Made {
  const k = keyFromPrivate(randomBytes(32))
  return { listed: { key: k.address, scope, ...(scope === 'write' && { paths: ['offer', 'review'] }) }, key: b64u.encode(k.privateKey) }
}

/**
 * An assistant connects through the key holder: OAuth with PKCE; the page shows a link; the app
 * lists the keys it made in the permissions record, signed with the main key, and posts them to the
 * link as forest's grants; once the host shows them listed, the grant goes through. Returns an MCP
 * client holding the token.
 */
async function connect(p: Person, keys: Made[]): Promise<Client> {
  const meta = (await json(`${cfg.keyholder}/.well-known/oauth-authorization-server`)).body
  const reg = await post(meta.registration_endpoint, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'e2e assistant', grant_types: ['authorization_code', 'refresh_token'] })
  assert.equal(reg.status, 201, JSON.stringify(reg.body))
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(meta.authorization_endpoint)
  const params = {
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: randomBytes(8).toString('hex'),
    resource: `${cfg.keyholder}/mcp`,
  }
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v)
  const opened = await fetch(authorize, { redirect: 'manual' })
  assert.equal(opened.status, 303)
  const page = await (await fetch(cfg.keyholder + opened.headers.get('location')!, { redirect: 'manual' })).text()
  const link = /<code>(https:\/\/[^<]+\/connect\/[A-Za-z0-9_-]{22})<\/code>/.exec(page)![1]!

  // The app: the keys on the permissions list, then handed over.
  const now = Date.now()
  const [outcome] = await publish([cfg.host!], [permissionsRecord(p.profile, keys.map((k) => k.listed), now)])
  assert.ok(outcome!.results[0]!.ok, JSON.stringify(outcome))
  const grants: Grant[] = keys.map(({ listed, key }) => ({ key, folder: p.profile.address, scope: listed.scope as Grant['scope'], ...(listed.paths && { paths: listed.paths }), from: p.profile.address, since: now, note: 'e2e assistant' }))
  const handed = await post(link, { grants })
  assert.equal(handed.status, 200, `the key holder took the grants: ${JSON.stringify(handed.body)}`)

  const granted = await waitFor('the grant', 60_000, async () => {
    const res = await fetch(link, { redirect: 'manual' })
    return res.status === 302 ? new URL(res.headers.get('location')!) : null
  }, 2000)
  assert.equal(granted.searchParams.get('state'), params.state)
  const tokens = await json(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: granted.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier }),
  })
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body))
  const client = new Client({ name: 'e2e-assistant', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.keyholder}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.body.access_token}` } } }))
  say(`${p.role}: an assistant connected through the key holder, holding ${keys.map((k) => `a ${k.listed.scope} key`).join(', ')}, each on the profile's permissions list`)
  return client
}

/** A tool's answer, refused or not. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  return { ok: !result.isError, data: result.structuredContent as any, text: (result.content as Array<{ text: string }>).map((c) => c.text).join('\n') }
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args)
  assert.ok(result.ok, `${name}: ${result.text}`)
  return result.data
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
async function inbox(from: Person, to: Person, readKey: ReadingKey) {
  const seller = await readProfile([cfg.host!], to.profile.address, Date.now())
  const card = seller.current.get('profile')!.record.body as Body & { inboxKey: string; inbox: unknown }
  assert.deepEqual(card.inbox, { senders: { issuer: cfg.issuerAddress }, once: true, readers: [readKey.recipient] }, 'the seller’s card declares the inbox, and the read key as a reader')
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
 * The seller's assistant, through the key holder's tools, with the keys the seller's app handed
 * over. It pulls the seller's inbox (the message key) and opens the buyer's message (the read key);
 * replies to the buyer, signed by the message key for the seller and naming the seller's host, where
 * the buyer's host reads the seller's permissions; and asks the seller to pay, a message to the
 * seller's own inbox, which the seller's app pulls with its main key and opens. Then the seller
 * revokes the message key: the assistant's pulls are refused at once, and its messages once the
 * buyer's host no longer keeps the seller's records it read (`senderCacheSeconds` in devnet.json,
 * the host's setting).
 */
async function assistant(seller: Person, buyer: Person, client: Client, keys: Made[], asked: string) {
  const messageKey = keys.find((k) => k.listed.scope === 'message')!.listed.key
  const inbox = await tool(client, 'pull_inbox')
  assert.equal(inbox.messages.length, 1, 'the message key pulls the seller’s inbox')
  assert.deepEqual([inbox.messages[0].from, inbox.messages[0].opened, inbox.messages[0].body], [buyer.profile.address, true, { text: asked }], 'the buyer’s message, opened by the read key')

  // A host that could not read the seller's records, or look up a row, is the sender's to try again.
  const sent = async (name: string, args: Record<string, unknown>, what: string) => {
    const out = await waitFor(what, 60_000, async () => {
      const r = await call(client, name, args)
      return !r.ok && r.text.includes('(lookup)') ? null : r
    })
    assert.ok(out.ok, `${name}: ${out.text}`)
    return out.data
  }
  const text = 'Tuesday at six, yes. A devnet test reply, sent through the key holder by e2e.'
  const reply = await sent('send_message', { to: buyer.profile.address, text }, 'the buyer’s host to take the reply')
  const buyerPage = await pull(cfg.host!, pullRequest(buyer.profile, 0, Date.now()))
  assert.equal(buyerPage.messages.length, 1, 'one message in the buyer’s inbox')
  const got = await openMessage(buyerPage.messages[0]!.message, buyer.inboxKey.identity)
  assert.deepEqual([got.from, got.key, got.body], [seller.profile.address, messageKey, { text }], 'from the seller, sent by its message key')
  say(`seller's assistant: pulled the inbox with the message key ${messageKey}, opened the buyer's message with the read key, and replied; the buyer saw the message key sent it`)

  const ask = { amount: '1', to: buyer.profile.address, note: 'Refund the lesson. A devnet test request, made by e2e.' }
  const requested = await sent('request_payment', ask, 'the seller’s host to take the payment request')
  const own = await pull(cfg.host!, pullRequest(seller.profile, 0, Date.now()))
  const asking = own.messages.find((m) => m.message.from === seller.profile.address && m.message.key === messageKey)
  assert.ok(asking, 'the payment request is in the seller’s inbox')
  const opened = await openMessage(asking.message, seller.inboxKey.identity)
  assert.deepEqual(opened.body, { request: 'pay', ...ask }, 'the seller’s app opens the request with its inbox key')
  say('seller\'s assistant: asked the seller to pay; the seller\'s app pulled the request and opened it')

  // The seller revokes the message key, keeping the others.
  const revokedAt = Date.now()
  const [revoked] = await publish([cfg.host!], [permissionsRecord(seller.profile, keys.map((k) => (k.listed.scope === 'message' ? { key: k.listed.key, scope: 'revoked' as const } : k.listed)), revokedAt)])
  assert.ok(revoked!.results[0]!.ok, `the host took the permissions record revoking it: ${JSON.stringify(revoked)}`)
  const refusedPull = await call(client, 'pull_inbox')
  assert.ok(!refusedPull.ok && refusedPull.text.includes('(permission)'), `its pull is refused at once: ${refusedPull.text}`)
  const wait = Number(cfg.senderCacheSeconds) * 1000 + 10_000 - (Date.now() - revokedAt)
  say(`seller: the message key revoked; the assistant's pull refused at once; waiting ${Math.ceil(wait / 1000)} s for the buyer's host to read the seller's records again`)
  await sleep(wait)
  const late = await call(client, 'send_message', { to: buyer.profile.address, text: 'And Thursday? A devnet test reply, by a revoked message key.' })
  assert.ok(!late.ok && late.text.includes('(permission)'), `a reply by the revoked message key is refused: ${late.text}`)
  say('seller: a second reply through the key holder, by the revoked message key, refused (permission)')
  return {
    keys: Object.fromEntries(keys.map((k) => [k.listed.scope, k.listed.key])),
    pulled: inbox.messages.length,
    reply: { id: reply.id, bytes: Buffer.byteLength(encodeMessage(buyerPage.messages[0]!.message)), from: got.from, key: got.key, host: reply.host },
    paymentRequest: { id: requested.id, body: opened.body },
    revoked: { pull: 'permission', waitedMs: Date.now() - revokedAt, message: 'permission' },
    texts: [text, ask.note],
  }
}

async function pay(buyer: Person, seller: Person, offer: { price: { amount: string } }, token: escrow.Token) {
  const payer = await kora<{ signer_address: string }>('getPayerSigner')
  const terms = escrow.termsFor(undefined, { seller: seller.signer.publicKey, amount: BigInt(offer.price.amount) * DOLLAR })
  const args = { buyer: buyer.signer.publicKey, payer: new PublicKey(payer.signer_address), token, terms, programId: ESCROW }
  const keys = escrow.keysFor({ buyer: args.buyer, mint: token.mint, tokenProgram: token.program, terms, programId: ESCROW })
  const paid = await throughAtCostDoor(buyer.signer, escrow.payInOneTap(args), token)
  const account = escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  assert.equal(account.status, 'ended')
  assert.equal(account.outcome, 'releasedToSeller')
  assert.equal(account.seller.toBase58(), seller.profile.address)
  assert.equal(account.buyer.toBase58(), buyer.profile.address)
  say(`deal: ${keys.escrow.toBase58()}, paid and released in one tap, ${paid.signature}`)
  return { escrow: keys.escrow.toBase58(), ...paid }
}

async function indexShows(seller: Person, buyer: Person, deal: string, offerUri: string, picture: { sha256: string; mimeType: string }, messageTexts: string[]) {
  say('the index: waiting for both profiles, their rows, the offer and its photo, the deal and both reviews')
  const pictureUrl = `${cfg.host}/v1/blobs/${picture.sha256}`
  const profile = (p: Person) => json(`${cfg.index}/profiles/${p.profile.address}.json`)
  const shown = await waitFor('the index to show it all', 900_000, async () => {
    const [s, b] = await Promise.all([profile(seller), profile(buyer)])
    if (s.status !== 200 || b.status !== 200) return null
    // Each profile's counted rows, by issuer: the seller's under both lists, so ID-checked; the buyer's under the face list.
    for (const [p, v, issuers] of [[seller, s.body, [cfg.issuerAddress, cfg.idIssuerAddress]], [buyer, b.body, [cfg.issuerAddress]]] as const) {
      const counted = v.stamps.filter((x: any) => x.label === p.label && x.counted && x.issuer.name !== null)
      if (JSON.stringify(counted.map((x: any) => x.issuer.address).sort()) !== JSON.stringify([...issuers].sort())) return null
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
  const idName = shown.seller.stamps.find((x: any) => x.issuer.address === cfg.idIssuerAddress).issuer.name as string
  const checkedBy = /Checked by ([^<]*)\. How sure/.exec(page)?.[1] ?? ''
  assert.ok(checkedBy.includes(idName), `the seller’s page shows it ID-checked: checked by ${checkedBy}`)
  const bytes = await getBlob([cfg.host!], picture.sha256)
  assert.equal(bytes?.type, picture.mimeType, 'the host serves the bytes the offer names')
  const summary = (v: any) => ({
    url: `${cfg.index}/profiles/${v.address}`,
    stamps: v.stamps.map((b: any) => ({ label: b.label, counted: b.counted, issuer: b.issuer.name, row: b.row })),
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
 * The loop proves. The seller's app finds its leaf among the index's leaves by the market stamp its
 * list secret gives (it never asks the index for one leaf), proves its own rating in its market on
 * the device, puts the proof on its card and publishes the card again; the index checks the proof
 * and shows it on the seller's page.
 */
async function proves(p: Person, card: Awaited<ReturnType<typeof publishCard>>) {
  say('seller: waiting for its leaf in the index’s reputation tree, scored')
  const stamp = hex.encode(toBytes32(marketStampOf(p.secret, p.label)))
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
    profile: p.profile.publicKey,
    show: true,
    artifacts: REPUTATION,
  })
  assert.equal(hex.encode(toBytes32(proof.root)), tree.root, 'the proof is against the root the index signed')
  const entry = {
    circuit: 'reputation',
    index: tree.index,
    root: tree.root,
    time: tree.time,
    signature: tree.signature,
    score: Number(proof.score),
    label: p.label,
    proof: b64u.encode(proofBytes(proof.proof)),
  }
  const [outcome] = await publish([cfg.host!], [ownerRecord(p.profile, 'profile', { ...card, proofs: [entry] }, Date.now())])
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
}

async function main() {
  const list0 = (await json(`${cfg.issuer}/list.json`)).body as ListFile
  const idList0 = (await json(`${cfg.issuer}/id/list.json`)).body as ListFile
  const run = started.toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const seller = await newPerson('seller', `e2e teacher ${run}`, list0.issuer, idList0.issuer)
  const buyer = await newPerson('buyer', `e2e student ${run}`, list0.issuer, idList0.issuer)
  const people = [seller, buyer]
  record.people = Object.fromEntries(people.map((p) => [p.role, { profile: p.profile.address, label: p.label }]))
  say(`two people, each from 24 words: seller ${seller.profile.address}, buyer ${buyer.profile.address}`)

  const token = await setup(people)
  const list = await stamped(people)
  steps.rows = { seller: await register(seller, list, token, 'voucher'), buyer: await register(buyer, list, token, 'paid') }
  // The seller moves up: the ID check, and a second row for the same main key, against the ID list.
  const idList = await idChecked(seller)
  steps.idRow = await register(seller, idList, token, 'voucher', { secret: seller.id.secret, label: 'sponsor/10' })

  // The read key the seller's app makes for its assistant, at random (forest's records, "Access
  // keys"): listed among the seller's inbox's readers, so every message to it is sealed to it too.
  const readKey = await readingKey(randomBytes(32))
  const sellerCard = await publishCard(seller, [readKey.recipient])
  await publishCard(buyer)
  // Each app makes its assistant's keys: the seller's a write, a message and a read key; the buyer's a write key.
  const sellerKeys = [made('write'), made('message'), { listed: { key: readKey.recipient, scope: 'read' as const }, key: readKey.identity }]
  const buyerKeys = [made('write')]
  const sellerAssistant = await connect(seller, sellerKeys)
  const buyerAssistant = await connect(buyer, buyerKeys)
  const bytes = photo()
  const picture = { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', size: bytes.length }
  const offer = {
    direction: 'offer',
    description: 'One hour of maths tutoring, online. A devnet test offer, posted by an assistant through e2e.',
    price: { amount: '1', mint: DOLLAR_MINT.toBase58(), per: 'hour' },
    remote: true,
    media: [picture],
  }
  const posted = await tool(sellerAssistant, 'post_offer', { id: 'maths', offer })
  const offerUri = `${seller.profile.address}/${posted.path}`
  const view = await readProfile([cfg.host!], seller.profile.address, Date.now())
  assert.equal(view.current.get('offer/maths')!.record.by, sellerKeys[0]!.listed.key, 'the offer is signed by the write key, not the main key')
  say(`seller: offer posted by the assistant, signed by its access key: ${offerUri}`)
  // The seller's app puts the photo on the profile's hosts, after the offer that names it.
  const [put] = await putBlob(view.hosts, bytes, picture.mimeType)
  assert.ok(put!.ok, `the host took the photo: ${JSON.stringify(put)}`)
  assert.equal((await getBlob(view.hosts, picture.sha256))?.type, picture.mimeType, 'and serves it as the type the offer names')
  say(`seller: the offer's photo on the host, ${picture.size} bytes, ${picture.sha256.slice(0, 12)}…`)
  steps.records = { sellerWriteKey: sellerKeys[0]!.listed.key, buyerWriteKey: buyerKeys[0]!.listed.key, offer: offerUri, photo: picture }

  const asked = await inbox(buyer, seller, readKey)
  steps.inbox = asked
  const helped = await assistant(seller, buyer, sellerAssistant, sellerKeys, asked.text)
  steps.assistant = helped
  const deal = await pay(buyer, seller, offer, token)
  steps.deal = deal

  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const byBuyer = await tool(buyerAssistant, 'post_review', { id: 'maths', review: { subject: seller.profile.address, ratings: { overall: '10' }, text: 'Clear and patient. A devnet test review.', dealId: deal.escrow, createdAt: at } })
  const bySeller = await tool(sellerAssistant, 'post_review', { id: 'maths', review: { subject: buyer.profile.address, ratings: { overall: '10' }, text: 'On time, paid at once. A devnet test review.', dealId: deal.escrow, createdAt: at } })
  steps.reviews = [`${buyer.profile.address}/${byBuyer.path}`, `${seller.profile.address}/${bySeller.path}`]
  say('two reviews posted by the assistants, each naming the deal')
  await sellerAssistant.close()
  await buyerAssistant.close()

  await indexShows(seller, buyer, deal.escrow, offerUri, picture, [asked.text, ...helped.texts])
  say('the index shows it all')

  await proves(seller, sellerCard)
  say('the index shows the seller’s rating, proven')
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
// The RPC and MCP clients keep sockets open; the run is over either way.
process.exit(record.passed ? 0 : 1)
