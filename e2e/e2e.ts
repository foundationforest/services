// e2e: Forest end to end on devnet, against the services this repo deploys (devnet.json). Devnet only.
//
//   ../forest.sh keys records registry/client registry/artifacts escrow/client
//   (cd ../forest/registry/artifacts && npm run fetch)
//   npm ci && FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
//
// Two new people, a seller and a buyer, each the way their app would do it:
//   1. a seed from 24 words, and from it the profile key, the reading key and the list secret;
//   2. setup: their test-dollar accounts and some dollars (the deploy key pays; nothing a person does
//      later needs SOL);
//   3. stamped by the issuer: a face check (the stand-in passes it), the stamp submitted, and listed;
//   4. registered: a row for each, proven against the keeper's newest snapshot and carrying its
//      signature, sent through the relayer, paid in the test dollar;
//   5. each app publishes the profile's hosts record and card, with its reading key;
//   6. an assistant connects to each through connections (OAuth): the app adds the writer key it
//      shows to the profile's permissions record, and the seller's assistant posts an offer;
//   7. one private record: the buyer writes the seller a message only the two of them can open;
//   8. the buyer pays through the escrow, in one tap, through the relayer;
//   9. each assistant posts a review of the other, naming the escrow;
//  10. the index shows it: both profiles, their counted rows and keeper, the offer, the deal and both
//      reviews at full weight; and not the private message.
// Everything it did goes to runs/<time>.json.

import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

import { exportWords, importWords, listSecret, newSeed, profileKey, readingKey, type ProfileKey, type ReadingKey } from '../forest/keys/src/index.ts'
import { base58, hex, hostsRecord, ownerRecord, permissionsRecord, publish, readProfile } from '../forest/records/src/index.ts'
import { makePrivate, openPrivate } from '../forest/records/src/private.ts'
import { buildRegistration, fetchRow, keeperSigned, listRoot, marketStampOf, toBytes32 } from '../forest/registry/client/src/index.ts'
import * as escrow from '../forest/escrow/client/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'devnet.json'), 'utf8')) as Record<string, string>
const RPC = process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : cfg.rpc!
const ARTIFACTS = { wasm: join(here, '../forest/registry/artifacts/semaphore-32.wasm'), zkey: join(here, '../forest/registry/artifacts/semaphore-32.zkey') }
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

// ---- The relayer, as a person's app calls it ----

class KoraError extends Error {}
async function kora<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const { body } = await post(cfg.relayer!, { jsonrpc: '2.0', id: 1, method, params })
  if (body.error) throw new KoraError(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

type Paid = { signature: string; charge: string; bytes: number }

/**
 * What a person's app does to send through the relayer: the transaction with the relayer as payer and
 * a payment to it in the test dollar already in place (Kora's price counts it), the price asked, the
 * payment set to exactly that, the profile's key signs, Kora checks, co-signs and sends.
 */
async function throughKora(signer: Keypair, instructions: TransactionInstruction[], token: escrow.Token): Promise<Paid> {
  const payer = await kora<{ signer_address: string; payment_address: string }>('getPayerSigner')
  const relayer = new PublicKey(payer.signer_address)
  const paymentTo = escrow.associatedTokenAddress(new PublicKey(payer.payment_address), token.mint, token.program)
  const payFrom = escrow.associatedTokenAddress(signer.publicKey, token.mint, token.program)
  const pay = (amount: bigint) => escrow.transferIx({ from: payFrom, to: paymentTo, owner: signer.publicKey, mint: token.mint, amount, decimals: token.decimals, tokenProgram: token.program })
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const compile = (ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: relayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
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
  profile: ProfileKey
  /** The profile key as a Solana signer: the same key. */
  signer: Keypair
  reading: ReadingKey
  stamp: bigint
  secret: Uint8Array
}

async function newPerson(role: Person['role'], name: string, keeper: string): Promise<Person> {
  const words = exportWords(newSeed())
  // The person keeps the words; the app asks for them, mixes what it needs, and forgets them.
  const seed = importWords(words)
  assert.equal(exportWords(seed), words, 'the words give the seed back')
  const label = `${cfg.market}/${role}`
  const profile = await profileKey(seed, label)
  assert.equal((await profileKey(importWords(words.toUpperCase().split(' ').join('  '))!, label)).address, profile.address, 'case and spacing do not matter')
  const reading = await readingKey(profile.privateKey)
  const list = await listSecret(seed, keeper)
  seed.fill(0)
  return { role, name, label, profile, signer: Keypair.fromSeed(profile.privateKey), reading, stamp: list.stamp, secret: list.secret }
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

type ListFile = { v: 1; keeper: string; stamps: string[]; snapshots: { root: string; signature: string; size: number; time: number }[] }

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
  const list = (await json(`${cfg.issuer}/list.json`)).body as ListFile
  assert.equal(list.keeper, cfg.keeper, 'the keeper the index trusts')
  const newest = list.snapshots.at(-1)!
  assert.equal(newest.size, list.stamps.length, 'the newest snapshot is the whole list')
  assert.equal(hex.encode(toBytes32(listRoot(list.stamps.map(BigInt)))), newest.root, 'its root is the list’s')
  assert.ok(keeperSigned({ keeper: base58.decode(list.keeper), root: hex.decode(newest.root), keeperSignature: hex.decode(newest.signature) }), 'signed by the keeper')
  for (const p of people) assert.ok(list.stamps.includes(p.stamp.toString()), 'each stamp is on the list')
  steps.list = { keeper: list.keeper, stamps: list.stamps.length, snapshot: newest }
  say(`both on the list: ${list.stamps.length} stamps, root ${newest.root.slice(0, 12)}…`)
  return list
}

async function register(p: Person, list: ListFile, token: escrow.Token) {
  const newest = list.snapshots.at(-1)!
  const payer = await kora<{ signer_address: string }>('getPayerSigner')
  const registration = await buildRegistration({
    secret: p.secret,
    label: p.label,
    profile: new PublicKey(p.profile.publicKey) as never,
    // As its 32 bytes: the client checks a key against its own copy of web3.js.
    keeper: base58.decode(list.keeper) as never,
    stamps: list.stamps.slice(0, newest.size).map(BigInt),
    keeperSignature: hex.decode(newest.signature),
    artifacts: ARTIFACTS,
    payer: new PublicKey(payer.signer_address) as never,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    programId: REGISTRY as never,
  })
  const paid = await throughKora(p.signer, [registration.instruction as never], token)
  const row = await fetchRow(connection as never, marketStampOf(p.secret, p.label), { programId: REGISTRY as never })
  assert.ok(row, 'the row is there')
  assert.equal(row.label, p.label)
  assert.equal(row.profile.toBase58(), p.profile.address, 'it names the profile')
  assert.equal(row.keeper.toBase58(), list.keeper, 'and the keeper')
  assert.ok(keeperSigned(row), "with the keeper's signature on its root")
  say(`${p.role}: row ${p.label} through the relayer, ${paid.signature}`)
  return { label: p.label, row: registration.row.toBase58(), ...paid }
}

async function publishCard(p: Person) {
  const now = Date.now()
  const card = {
    name: p.name,
    market: cfg.market!,
    role: p.role,
    about: p.role === 'seller' ? 'Maths lessons online. A devnet test profile, made by e2e.' : 'A devnet test profile, made by e2e.',
    read: p.reading.recipient,
    createdAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const [outcome] = await publish([cfg.host!], [hostsRecord(p.profile, [cfg.host!], now), ownerRecord(p.profile, 'profile', card, now)])
  assert.ok(outcome!.results.every((r) => r.ok), `the host took the hosts record and the card: ${JSON.stringify(outcome)}`)
  say(`${p.role}: hosts record and card on the test host, as ${p.profile.address}`)
}

/**
 * An assistant connects through connections: OAuth with PKCE, the person names the profile, the
 * app adds the writer key the page shows to the permissions record, signed with the profile's key,
 * and the grant goes through. Returns an MCP client holding the token.
 */
async function connect(p: Person): Promise<{ client: Client; writer: string }> {
  const meta = (await json(`${cfg.connections}/.well-known/oauth-authorization-server`)).body
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
    resource: `${cfg.connections}/mcp`,
  }
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v)
  const page = await (await fetch(authorize, { redirect: 'manual' })).text()
  const path = /action="(\/connect\/[^"]+)"/.exec(page)![1]!
  const named = await fetch(cfg.connections + path, { method: 'POST', body: new URLSearchParams({ profile: p.profile.address }), redirect: 'manual' })
  assert.equal(named.status, 303)
  const writer = /<code>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code>/.exec(await (await fetch(cfg.connections + path, { redirect: 'manual' })).text())![1]!

  // The app: the writer key on the permissions list, for offers and reviews, for 30 days.
  const now = Date.now()
  const [outcome] = await publish([cfg.host!], [permissionsRecord(p.profile, [{ key: writer, paths: ['offer', 'review'], until: now + 30 * 86_400_000 }], now)])
  assert.ok(outcome!.results[0]!.ok, JSON.stringify(outcome))

  const granted = await waitFor('the grant', 60_000, async () => {
    const res = await fetch(cfg.connections + path, { redirect: 'manual' })
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
  await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.connections}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.body.access_token}` } } }))
  say(`${p.role}: an assistant connected, its writer key ${writer} on the profile's permissions list`)
  return { client, writer }
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  return result.structuredContent as { path: string; id: string; time: number }
}

async function privateMessage(from: Person, to: Person) {
  // The buyer's app reads the seller's card for its reading key, and makes the record for both.
  const seller = await readProfile([cfg.host!], to.profile.address, Date.now())
  const read = (seller.current.get('profile')!.record.body as { read: string }).read
  assert.equal(read, to.reading.recipient)
  const text = 'Tuesday at six works for me. A devnet test message, made by e2e.'
  const body = await makePrivate({ text }, [read, from.reading.recipient])
  const now = Date.now()
  const [outcome] = await publish([cfg.host!], [ownerRecord(from.profile, 'message/lesson', body, now)])
  assert.ok(outcome!.results[0]!.ok, JSON.stringify(outcome))
  // The seller's app reads it back from the buyer's hosts and opens it with its reading key.
  const view = await readProfile([cfg.host!], from.profile.address, Date.now())
  const opened = await openPrivate(view.current.get('message/lesson')!.record.body!, to.reading.identity)
  assert.deepEqual(opened, { text })
  say('buyer: a private message to the seller, opened by the seller’s reading key')
  return { path: `${from.profile.address}/message/lesson`, bytes: (body.private as string).length, text }
}

async function pay(buyer: Person, seller: Person, offer: { price: { amount: string } }, token: escrow.Token) {
  const payer = await kora<{ signer_address: string }>('getPayerSigner')
  const terms = escrow.termsFor(undefined, { seller: seller.signer.publicKey, amount: BigInt(offer.price.amount) * DOLLAR })
  const args = { buyer: buyer.signer.publicKey, payer: new PublicKey(payer.signer_address), token, terms, programId: ESCROW }
  const keys = escrow.keysFor({ buyer: args.buyer, mint: token.mint, tokenProgram: token.program, terms, programId: ESCROW })
  const paid = await throughKora(buyer.signer, escrow.payInOneTap(args), token)
  const account = escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  assert.equal(account.status, 'ended')
  assert.equal(account.outcome, 'releasedToSeller')
  assert.equal(account.seller.toBase58(), seller.profile.address)
  assert.equal(account.buyer.toBase58(), buyer.profile.address)
  say(`deal: ${keys.escrow.toBase58()}, paid and released in one tap, ${paid.signature}`)
  return { escrow: keys.escrow.toBase58(), ...paid }
}

async function indexShows(seller: Person, buyer: Person, deal: string, offerUri: string, privateText: string) {
  say('the index: waiting for both profiles, their rows, the offer, the deal and both reviews')
  const profile = (p: Person) => json(`${cfg.index}/profiles/${p.profile.address}.json`)
  const shown = await waitFor('the index to show it all', 900_000, async () => {
    const [s, b] = await Promise.all([profile(seller), profile(buyer)])
    if (s.status !== 200 || b.status !== 200) return null
    for (const [p, v] of [[seller, s.body], [buyer, b.body]] as const) {
      const row = v.stamps.find((x: any) => x.label === p.label)
      if (!row?.counted || row.keeper.address !== cfg.keeper) return null
      // Full evidence: the buyer opened the escrow, and the seller reviewed the deal (`oneSidedConfirmed`).
      if (v.reviews.received.length < 1 || !v.reviews.received.every((r: any) => r.counted && r.evidence.kind === 'oneSidedConfirmed' && r.evidence.weight === 1)) return null
    }
    if (!s.body.offers.some((o: any) => o.uri === offerUri)) return null
    const d = await json(`${cfg.index}/deals/${deal}.json`)
    if (d.status !== 200 || d.body.receipt?.outcome !== 'releasedToSeller' || d.body.reviews.length !== 2) return null
    return { seller: s.body, buyer: b.body, deal: d.body }
  }, 15_000)
  assert.equal(JSON.stringify(shown).includes(privateText), false, 'the private message is nowhere in the index')
  const summary = (v: any) => ({
    url: `${cfg.index}/profiles/${v.address}`,
    stamps: v.stamps.map((b: any) => ({ label: b.label, counted: b.counted, keeper: b.keeper.name, row: b.row })),
    rating: v.scores.rating?.value ?? null,
    standing: v.scores.standing?.value ?? null,
    offers: v.offers.map((o: any) => o.uri),
    reviewsReceived: v.reviews.received.map((r: any) => ({ uri: r.uri, dealId: r.dealId, counted: r.counted, evidence: r.evidence.kind, weight: r.evidence.weight })),
  })
  steps.index = {
    seller: summary(shown.seller),
    buyer: summary(shown.buyer),
    deal: { url: `${cfg.index}/deals/${deal}`, outcome: shown.deal.receipt.outcome, amount: shown.deal.receipt.amount, reviews: shown.deal.reviews.length },
  }
}

async function main() {
  const list0 = (await json(`${cfg.issuer}/list.json`)).body as ListFile
  const run = started.toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const seller = await newPerson('seller', `e2e teacher ${run}`, list0.keeper)
  const buyer = await newPerson('buyer', `e2e student ${run}`, list0.keeper)
  const people = [seller, buyer]
  record.people = Object.fromEntries(people.map((p) => [p.role, { profile: p.profile.address, label: p.label }]))
  say(`two people, each from 24 words: seller ${seller.profile.address}, buyer ${buyer.profile.address}`)

  const token = await setup(people)
  const list = await stamped(people)
  steps.rows = { seller: await register(seller, list, token), buyer: await register(buyer, list, token) }

  await publishCard(seller)
  await publishCard(buyer)
  const sellerAssistant = await connect(seller)
  const buyerAssistant = await connect(buyer)
  const offer = {
    direction: 'offer',
    description: 'One hour of maths tutoring, online. A devnet test offer, posted by an assistant through e2e.',
    price: { amount: '1', mint: DOLLAR_MINT.toBase58(), per: 'hour' },
    remote: true,
  }
  const posted = await tool(sellerAssistant.client, 'post_offer', { id: 'maths', offer })
  const offerUri = `${seller.profile.address}/${posted.path}`
  const view = await readProfile([cfg.host!], seller.profile.address, Date.now())
  assert.equal(view.current.get('offer/maths')!.record.by, sellerAssistant.writer, 'the offer is signed by the writer key, not the profile key')
  say(`seller: offer posted by the assistant, signed by its writer key: ${offerUri}`)
  steps.records = { sellerWriter: sellerAssistant.writer, buyerWriter: buyerAssistant.writer, offer: offerUri }

  steps.private = await privateMessage(buyer, seller)
  const deal = await pay(buyer, seller, offer, token)
  steps.deal = deal

  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const byBuyer = await tool(buyerAssistant.client, 'post_review', { id: 'maths', review: { subject: seller.profile.address, ratings: { overall: '10' }, text: 'Clear and patient. A devnet test review.', dealId: deal.escrow, createdAt: at } })
  const bySeller = await tool(sellerAssistant.client, 'post_review', { id: 'maths', review: { subject: buyer.profile.address, ratings: { overall: '10' }, text: 'On time, paid at once. A devnet test review.', dealId: deal.escrow, createdAt: at } })
  steps.reviews = [`${buyer.profile.address}/${byBuyer.path}`, `${seller.profile.address}/${bySeller.path}`]
  say('two reviews posted by the assistants, each naming the deal')
  await sellerAssistant.client.close()
  await buyerAssistant.client.close()

  await indexShows(seller, buyer, deal.escrow, offerUri, (steps.private as { text: string }).text)
  say('the index shows it all')
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
