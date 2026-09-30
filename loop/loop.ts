// The loop: Forest end to end on devnet, against the services this repo deploys (devnet.json), with
// the stand-in face check. Devnet only.
//
//   ../forest.sh records keys registry/client registry/artifacts escrow/v2/client
//   (cd ../forest/registry/artifacts && npm run fetch)
//   npm ci && npm run loop
//
// Needs the devnet keys forest's devnet/keys.sh derives, in FOREST_DEVNET_KEYS (default
// ~/.forest-devnet/keys): the deploy key pays for setup, the test-dollar authority mints the
// USDC-shaped dollar, and the relayer's key, which is the Open-USD-shaped dollar's issuer, mints
// that one. HELIUS_API_KEY, when set, is the RPC; otherwise devnet's public one. Chromium at
// /opt/pw-browsers/chromium-1194 (or CHROME_PATH).
//
// Two new people each run, each a fresh virtual passkey:
//   1. setup: their dollar accounts, and dollars;
//   2. each joins the issuer's list (the stand-in face check passes every session) and waits for a batch;
//      the root is checked against the list, in the signed roots file and in the issuer's memo on chain;
//   3. each registers a badge through the relayer, paying its fee in the USDC-shaped dollar;
//   4. each app writes its profile's folder on the test board; then the profile, the seller's offer, and
//      later every review, go through connections (MCP `forest_draft`): the approval page opens, one
//      tap, the virtual passkey, published;
//   5. the buyer pays on escrow v2 from the offer: in the USDC-shaped dollar in one tap; in the
//      Open-USD-shaped dollar, pay then release, two transactions from one approval, after Kora 2.0.5
//      is seen to refuse them as one;
//   6. both review each deal;
//   7. the index shows it all: both badges trusted and counted, the offer, both deals ended, four reviews
//      counted at full weight (the buyer opened each escrow, and the seller reviewed the deal).
// Everything it did is written to runs/<time>.json.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { type BrowserContext, type Page, chromium } from 'playwright-core'

import { identitySecret } from '../forest/keys/src/index.ts'
import { b64u, concat, hex, utf8 } from '../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../forest/records/src/canonical.ts'
import { publish } from '../forest/records/src/client.ts'
import { verifySignature } from '../forest/records/src/entry.ts'
import { type ProfileKey, profileKey, publicKeyFromDid, seedFromPrf } from '../forest/records/src/keys.ts'
import { folderEntry } from '../forest/records/src/write.ts'
import { buildRegistration, commitmentOf, decodeLine, listRoot } from '../forest/registry/client/src/index.ts'
import * as v2 from '../forest/escrow/v2/client/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'devnet.json'), 'utf8')) as Record<string, string>
const KEYS = process.env.FOREST_DEVNET_KEYS ?? join(homedir(), '.forest-devnet/keys')
const RPC = process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : cfg.rpc!
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const ARTIFACTS = { wasm: join(here, '../forest/registry/artifacts/semaphore-32.wasm'), zkey: join(here, '../forest/registry/artifacts/semaphore-32.zkey') }
const PAGE = `${cfg.connections}/approve`
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const ROOTS_PREFIX = concat(Uint8Array.of(0xff), utf8('forest.foundation/issuer/roots/v1\n'))
const ROOT_MEMO_LABEL = 'forest.foundation/issuer/root/v1\n'
const DOLLAR = 1_000_000n

const connection = new Connection(RPC, 'confirmed')
const keypair = (label: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${label}.json`), 'utf8'))))
const deployKey = keypair('deploy')
const dollarAuthority = keypair('test-dollar-authority')
const relayerKey = keypair('payer') // the relayer's own key: the Open-USD-shaped dollar's issuer, used here only to mint
const USDC = new PublicKey(cfg.usdcShaped!)
const OUSD = new PublicKey(cfg.openUsdShaped!)
const ESCROW_V2 = new PublicKey(cfg.escrowV2!)
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

type Paid = { signature: string; charge: string; feeToken: string; bytes: number }

/**
 * What a person's app does to send through the relayer: the transaction with the relayer as payer and
 * a payment to it in `feeToken` already in place (Kora's price counts it), the price asked, the
 * payment set to exactly that, the person's key signs, Kora checks, co-signs and sends.
 */
async function throughKora(person: Keypair, instructions: TransactionInstruction[], feeToken: v2.Token): Promise<Paid> {
  const signer = await kora<{ signer_address: string; payment_address: string }>('getPayerSigner')
  const relayer = new PublicKey(signer.signer_address)
  const paymentTo = v2.associatedTokenAddress(new PublicKey(signer.payment_address), feeToken.mint, feeToken.program)
  const payFrom = v2.associatedTokenAddress(person.publicKey, feeToken.mint, feeToken.program)
  const pay = (amount: bigint) => v2.transferIx({ from: payFrom, to: paymentTo, owner: person.publicKey, mint: feeToken.mint, amount, decimals: feeToken.decimals, tokenProgram: feeToken.program })
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const compile = (ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: relayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  const estimate = await kora<{ fee_in_token: number | null }>('estimateTransactionFee', {
    transaction: Buffer.from(compile([...instructions, pay(0n)]).serialize()).toString('base64'),
    fee_token: feeToken.mint.toBase58(),
    sig_verify: false,
  })
  assert.ok(estimate.fee_in_token !== null, 'Kora quotes in the dollar')
  const charge = BigInt(estimate.fee_in_token)
  const tx = compile([...instructions, pay(charge)])
  tx.sign([person])
  const wire = tx.serialize()
  const { signature } = await kora<{ signature: string }>('signAndSendTransaction', { transaction: Buffer.from(wire).toString('base64') })
  await confirm(signature)
  return { signature, charge: charge.toString(), feeToken: feeToken.mint.toBase58(), bytes: wire.length }
}

// ---- A person: a phone with a passkey ----

type Person = {
  role: 'seller' | 'buyer'
  name: string
  context: BrowserContext
  page: Page
  key: ProfileKey
  wallet: Keypair
  secret: Uint8Array
  commitment: bigint
}

/** A browser profile with its own virtual authenticator (PRF on): one person's phone. */
async function phone(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  })
  return { context, page }
}

/**
 * The person's first run, which is their app's job, not the page's: a passkey on the approval page's
 * origin, and its PRF output; the seed is made from it, as the app makes it.
 */
async function firstRun(page: Page): Promise<Uint8Array> {
  await page.goto(PAGE)
  const prf = await page.evaluate(async () => {
    const input = new TextEncoder().encode('forest.foundation/prf/v1')
    await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Forest' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'forest', displayName: 'Forest' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} },
      },
    })
    const got = (await navigator.credentials.get({
      publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', extensions: { prf: { eval: { first: input } } } },
    })) as PublicKeyCredential
    const first = (got.getClientExtensionResults() as { prf: { results: { first: ArrayBuffer } } }).prf.results.first
    return [...new Uint8Array(first)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })
  return seedFromPrf(hex.decode(prf))
}

async function newPerson(browser: Awaited<ReturnType<typeof chromium.launch>>, role: Person['role'], name: string): Promise<Person> {
  const { context, page } = await phone(browser)
  const seed = await firstRun(page)
  const key = profileKey(seed, 0)
  const secret = await identitySecret(seed)
  seed.fill(0)
  return { role, name, context, page, key, wallet: Keypair.fromSeed(key.secretKey), secret, commitment: commitmentOf(secret) }
}

// ---- Approvals through connections ----

/**
 * An assistant drafts through connections (`forest_draft`); connections answers with the approval
 * link; the person's phone opens it, shows the note, one tap and the passkey sign it and post it to
 * the profile's hosts; connections reads the hosts and reports it published.
 */
async function approve(person: Person, path: string, body: Record<string, unknown>): Promise<string> {
  const client = new Client(
    { name: 'forest-loop', version: '0.0.0' },
    { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { maxRounds: 3 } },
  )
  let link = ''
  client.setRequestHandler('elicitation/create', async (req) => {
    link = (req.params as { url: string }).url
    assert.ok(link.startsWith(`${PAGE}#`), `the link opens the approval page: ${link.slice(0, 80)}`)
    await person.page.goto('about:blank')
    await person.page.goto(link)
    await person.page.waitForSelector('#approve:not([hidden])', { timeout: 30_000 })
    await person.page.click('#approve')
    await person.page.waitForFunction(() => /^Done\./.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 60_000 })
    return { action: 'accept' as const }
  })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.connections}/mcp`)))
    const result = await client.callTool({ name: 'forest_draft', arguments: { profile: person.key.did, path, body } })
    const text = JSON.stringify(result)
    assert.match(text, /Published/, `connections reports ${path} published: ${text.slice(0, 300)}`)
    return link
  } finally {
    await client.close()
  }
}

// ---- Steps ----

async function setup(people: Person[]) {
  say('setup: each person’s two dollar accounts, and dollars; the relayer’s Open-USD-shaped account')
  const usdcToken = v2.tokenOf(USDC, (await connection.getAccountInfo(USDC))!)
  const ousdToken = v2.tokenOf(OUSD, (await connection.getAccountInfo(OUSD))!)
  const ata = (owner: PublicKey, t: v2.Token) => v2.associatedTokenAddress(owner, t.mint, t.program)
  const make = (owner: PublicKey, t: v2.Token) => createAssociatedTokenAccountIdempotentInstruction(deployKey.publicKey, ata(owner, t), owner, t.mint, t.program)
  const [seller, buyer] = people as [Person, Person]
  const accounts = await setupSend(
    [make(relayerKey.publicKey, ousdToken), ...people.flatMap((p) => [make(p.wallet.publicKey, usdcToken), make(p.wallet.publicKey, ousdToken)])],
    [],
  )
  const minted = await setupSend(
    [
      createMintToCheckedInstruction(USDC, ata(seller.wallet.publicKey, usdcToken), dollarAuthority.publicKey, 5n * DOLLAR, 6, [], usdcToken.program),
      createMintToCheckedInstruction(USDC, ata(buyer.wallet.publicKey, usdcToken), dollarAuthority.publicKey, 15n * DOLLAR, 6, [], usdcToken.program),
      createMintToCheckedInstruction(OUSD, ata(buyer.wallet.publicKey, ousdToken), relayerKey.publicKey, 10n * DOLLAR, 6, [], ousdToken.program),
    ],
    [dollarAuthority, relayerKey],
  )
  steps.setup = { accounts, minted, seller: { usdcShaped: '5.00' }, buyer: { usdcShaped: '15.00', openUsdShaped: '10.00' } }
  return { usdcToken, ousdToken }
}

async function joinList(people: Person[]) {
  say('the issuer: a face check each (the stand-in passes it), then each commitment submitted')
  for (const p of people) {
    const session = await post(`${cfg.issuer}/session`, {})
    assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
    const submitted = await post(`${cfg.issuer}/submit`, { sessionId: session.body.sessionId, commitment: p.commitment.toString() })
    assert.equal(submitted.status, 202, `submitted: ${JSON.stringify(submitted.body)}`)
  }
  say('waiting for the issuer’s batch (every 2 minutes on devnet)')
  for (const p of people) {
    await waitFor('the commitment on the list', 300_000, async () => (await post(`${cfg.issuer}/status`, { commitment: p.commitment.toString() })).body.status === 'listed', 10_000)
  }
  const listText = await (await fetch(`${cfg.issuer}/list.json`)).text()
  const rootsText = await (await fetch(`${cfg.issuer}/roots.json`)).text()
  const list = (parseCanonical(listText) as { commitments: string[] }).commitments.map(BigInt)
  const roots = parseCanonical(rootsText) as { issuer: string; roots: { root: string; size: number; time: number }[]; sig: string }
  assert.equal(canonical(roots), rootsText, 'the roots file is canonical text')
  assert.equal(roots.issuer, cfg.issuerKey, 'signed by the issuer the index trusts')
  const { sig, ...unsigned } = roots
  assert.ok(verifySignature(b64u.decode(sig), concat(ROOTS_PREFIX, utf8(canonical(unsigned))), publicKeyFromDid(roots.issuer)!), 'its signature verifies')
  const newest = roots.roots.at(-1)!
  const listed = list.slice(0, newest.size)
  assert.equal(newest.size, list.length, 'the newest root covers the whole list')
  assert.equal(listRoot(listed).toString(), newest.root, 'the newest root is the list’s')
  for (const p of people) assert.ok(list.includes(p.commitment), 'each commitment is on the list')
  say(`both on the list: ${list.length} members, root ${newest.root.slice(0, 12)}…`)

  say('the issuer’s memo for that root, on chain')
  const issuerAddress = new PublicKey(publicKeyFromDid(cfg.issuerKey!)!)
  const memoText = ROOT_MEMO_LABEL + canonical(newest)
  const memo = await waitFor('the root’s memo on chain', 240_000, async () => {
    for (const s of await connection.getSignaturesForAddress(issuerAddress, { limit: 25 })) {
      if (s.err) continue
      const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      const m = tx?.transaction.message
      if (!m) continue
      const keys = m.staticAccountKeys.map((k) => k.toBase58())
      for (const ix of m.compiledInstructions) {
        if (keys[ix.programIdIndex] === MEMO_PROGRAM && Buffer.from(ix.data).toString('utf8') === memoText && keys.indexOf(issuerAddress.toBase58()) < m.header.numRequiredSignatures) return s.signature
      }
    }
    return null
  }, 10_000)
  steps.list = { members: list.length, root: newest, memo }
  say(`the memo: ${memo}`)
  return list
}

async function register(p: Person, list: bigint[], usdcToken: v2.Token) {
  const label = `${cfg.market}/${p.role}`
  const signer = await kora<{ signer_address: string }>('getPayerSigner')
  const registration = await buildRegistration({
    secret: p.secret,
    label,
    profile: p.key.publicKey,
    commitments: list,
    artifacts: ARTIFACTS,
    payer: new PublicKey(signer.signer_address) as never,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    programId: new PublicKey(cfg.registry!) as never,
  })
  const paid = await throughKora(p.wallet, [registration.instruction as never], usdcToken)
  const line = decodeLine(new Uint8Array((await connection.getAccountInfo(new PublicKey(registration.line.toBase58())))!.data))
  assert.equal(line.label, label)
  assert.equal(Buffer.from(line.profile.toBytes()).toString('hex'), Buffer.from(p.key.publicKey).toString('hex'), 'the line names the profile’s key')
  say(`${p.role}: badge ${label} through the relayer, ${paid.signature}`)
  return { label, line: registration.line.toBase58(), ...paid }
}

async function folderAndProfile(p: Person) {
  const folder = folderEntry(p.key, { hosts: [cfg.board!] }, Date.now())
  const [outcome] = await publish([cfg.board!], [folder])
  assert.ok(outcome!.results[0]!.ok, `the board took the folder: ${JSON.stringify(outcome)}`)
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const body = {
    name: p.name,
    market: cfg.market!,
    role: p.role,
    about: p.role === 'seller' ? 'Maths lessons online. A devnet test profile, made by the loop.' : 'A devnet test profile, made by the loop.',
    createdAt,
  }
  const link = await approve(p, 'profile', body)
  say(`${p.role}: folder on the test board; profile approved with the passkey and published`)
  return { did: p.key.did, wallet: p.wallet.publicKey.toBase58(), approvalLink: link.split('#')[0] }
}

/** Pay in one tap in a classic dollar: one transaction. */
async function payOneTap(buyer: Person, terms: v2.Terms, token: v2.Token) {
  const signer = await kora<{ signer_address: string }>('getPayerSigner')
  const args = { buyer: buyer.wallet.publicKey, payer: new PublicKey(signer.signer_address), token, terms, programId: ESCROW_V2 }
  const keys = v2.keysFor({ buyer: args.buyer, mint: token.mint, tokenProgram: token.program, terms, programId: ESCROW_V2 })
  const paid = await throughKora(buyer.wallet, v2.payInOneTap(args), token)
  return { escrow: keys.escrow.toBase58(), transactions: [paid] }
}

/**
 * Pay in a Token-2022 dollar from one approval: Kora 2.0.5 refuses pay and release as one
 * transaction (docs/kora-issue.md), so the app sends the payment, then the release once the payment
 * is confirmed, both signed with the key the one approval unlocked.
 */
async function payThenRelease(buyer: Person, terms: v2.Terms, token: v2.Token) {
  const signer = await kora<{ signer_address: string }>('getPayerSigner')
  const args = { buyer: buyer.wallet.publicKey, payer: new PublicKey(signer.signer_address), token, terms, programId: ESCROW_V2 }
  const keys = v2.keysFor({ buyer: args.buyer, mint: token.mint, tokenProgram: token.program, terms, programId: ESCROW_V2 })
  let refusal = ''
  try {
    await throughKora(buyer.wallet, v2.payInOneTap(args), token)
    refusal = 'none: Kora took the one tap'
  } catch (err) {
    if (!(err instanceof KoraError)) throw err
    refusal = err.message
  }
  assert.match(refusal, /not found/, `Kora 2.0.5 refuses the one tap in a Token-2022 dollar: ${refusal}`)
  say(`Kora refused the one tap as one transaction, as expected: ${refusal.slice(0, 120)}`)
  const pay = await throughKora(buyer.wallet, v2.createAndFund(args), token)
  const release = await throughKora(buyer.wallet, [v2.releaseToSellerIx({ keys, programId: ESCROW_V2 })], token)
  return { escrow: keys.escrow.toBase58(), transactions: [pay, release], oneTapRefusedByKora: refusal, oneTapAsSent: 'deposit address, create, transfer_checked in, release_to_seller, and the payment to the relayer' }
}

async function checkEscrow(escrow: string, seller: Person, buyer: Person, amount: bigint) {
  const account = v2.decodeEscrow(new Uint8Array((await connection.getAccountInfo(new PublicKey(escrow)))!.data))
  assert.equal(account.status, 'ended')
  assert.equal(account.outcome, 'releasedToSeller')
  assert.equal(account.seller.toBase58(), seller.wallet.publicKey.toBase58())
  assert.equal(account.buyer.toBase58(), buyer.wallet.publicKey.toBase58())
  assert.equal(account.amount, amount)
}

async function indexShows(seller: Person, buyer: Person, deals: string[]) {
  say('the index: waiting for both profiles, badges, the offer, both deals and four reviews')
  const profileJson = (p: Person) => json(`${cfg.index}/profiles/${p.key.did}.json`)
  const shown = await waitFor('the index to show it all', 900_000, async () => {
    const [s, b] = await Promise.all([profileJson(seller), profileJson(buyer)])
    if (s.status !== 200 || b.status !== 200) return null
    for (const [p, v] of [[seller, s.body], [buyer, b.body]] as const) {
      const badge = v.badges.find((x: any) => x.scope === `${cfg.market}/${p.role}`)
      if (!badge?.counted || !badge.issuers.some((i: any) => i.key === cfg.issuerKey)) return null
      // Full evidence: the seller opened the escrow (`both`), or the buyer did and the seller reviewed
      // the deal (`oneSidedConfirmed`); here the buyer opened each from the offer, and both reviewed.
      if (v.reviews.received.length < 2 || !v.reviews.received.every((r: any) => r.counted && r.evidence.kind === 'oneSidedConfirmed' && r.evidence.weight === 1)) return null
    }
    if (!s.body.offers.length) return null
    const dealPages = await Promise.all(deals.map((d) => json(`${cfg.index}/deals/${d}.json`)))
    if (!dealPages.every((d) => d.status === 200 && d.body.receipt?.outcome === 'releasedToSeller' && d.body.reviews.length === 2)) return null
    return { seller: s.body, buyer: b.body, deals: dealPages.map((d) => d.body) }
  }, 15_000)
  const summary = (v: any) => ({
    url: `${cfg.index}/profiles/${v.did}`,
    badges: v.badges.map((b: any) => ({ scope: b.scope, counted: b.counted, issuers: b.issuers.map((i: any) => i.name), line: b.line })),
    rating: v.scores.rating?.value ?? null,
    standing: v.scores.standing?.value ?? null,
    offers: v.offers.length,
    reviewsReceived: v.reviews.received.map((r: any) => ({ uri: r.uri, dealId: r.dealId, counted: r.counted, evidence: r.evidence.kind, weight: r.evidence.weight })),
  })
  steps.index = {
    seller: summary(shown.seller),
    buyer: summary(shown.buyer),
    deals: shown.deals.map((d: any) => ({ url: `${cfg.index}/deals/${d.dealId}`, outcome: d.receipt.outcome, mint: d.receipt.mint, amount: d.receipt.amount, reviews: d.reviews.length })),
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  try {
    const run = started.toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const seller = await newPerson(browser, 'seller', `Loop teacher ${run}`)
    const buyer = await newPerson(browser, 'buyer', `Loop student ${run}`)
    const people = [seller, buyer]
    record.people = Object.fromEntries(people.map((p) => [p.role, { did: p.key.did, wallet: p.wallet.publicKey.toBase58() }]))
    say(`two people, each a virtual passkey on ${cfg.connections}: seller ${seller.key.did}, buyer ${buyer.key.did}`)

    const { usdcToken, ousdToken } = await setup(people)
    const list = await joinList(people)

    steps.badges = { seller: await register(seller, list, usdcToken), buyer: await register(buyer, list, usdcToken) }

    const profiles = { seller: await folderAndProfile(seller), buyer: await folderAndProfile(buyer) }
    const offer = {
      direction: 'offer',
      description: 'One hour of maths tutoring, online. A devnet test offer, made by the loop.',
      price: { amount: '1', mint: USDC.toBase58(), per: 'hour' },
      remote: true,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }
    await approve(seller, 'offer/maths', offer)
    say('seller: offer approved and published')
    steps.records = { ...profiles, offer: `${seller.key.did}/offer/maths` }

    // The buyer pays from the offer: its price, its (no) options, the seller its author.
    const termsOf = () => v2.termsFor(undefined, { seller: seller.wallet.publicKey, amount: 1n * DOLLAR })
    const dealA = await payOneTap(buyer, termsOf(), usdcToken)
    await checkEscrow(dealA.escrow, seller, buyer, DOLLAR)
    say(`deal 1, USDC-shaped, one tap: ${dealA.escrow}`)
    const dealB = await payThenRelease(buyer, termsOf(), ousdToken)
    await checkEscrow(dealB.escrow, seller, buyer, DOLLAR)
    say(`deal 2, Open-USD-shaped, pay then release: ${dealB.escrow}`)
    steps.deals = { usdcShaped: dealA, openUsdShaped: dealB }

    const reviewed: string[] = []
    for (const [n, deal] of [dealA, dealB].entries()) {
      const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      await approve(buyer, `review/deal${n + 1}`, { subject: seller.key.did, ratings: { overall: n ? '9' : '10' }, text: 'Clear and patient. A devnet test review.', dealId: deal.escrow, createdAt })
      await approve(seller, `review/deal${n + 1}`, { subject: buyer.key.did, ratings: { overall: '10' }, text: 'On time, paid at once. A devnet test review.', dealId: deal.escrow, createdAt })
      reviewed.push(`${buyer.key.did}/review/deal${n + 1}`, `${seller.key.did}/review/deal${n + 1}`)
    }
    steps.reviews = reviewed
    say('four reviews approved and published, each naming its deal')

    await indexShows(seller, buyer, [dealA.escrow, dealB.escrow])
    say('the index shows it all')
    record.passed = true
  } catch (err) {
    record.passed = false
    record.error = redact((err as Error).stack ?? String(err))
    throw err
  } finally {
    record.ended = new Date().toISOString()
    await browser.close()
    mkdirSync(join(here, 'runs'), { recursive: true })
    const file = join(here, 'runs', `${started.toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
    say(`the run: ${file}`)
  }
}

await main()
