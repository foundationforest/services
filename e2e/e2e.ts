// The loop: Forest end to end. Two people from two seeds, a tutor and a student. Each one's device is
// the reference signer (mcp/test/signer.ts), unchanged: it holds the seed, keeps each profile's
// rules, signs, publishes, and answers the mcp's relay. What it has no method for, the device does
// here with the standard's pieces: the stamp kept on the device, the stamp proof on the profile
// record, the escrow. Each person's AI is the MCP SDK's own client (mcp/test/setup.ts),
// logging in through the loop's connect page and calling the mcp's tools. Against the host and fee
// payer services.json names, or the loop's own copies on loopback, with the loop's own verifier,
// index and mcp (services.ts); the chain is remote, through RPC_URL, or services.json's rpc.
//
//   ../standard.sh && (cd ../standard/proofs/reputation/circuit && npm run fetch)
//   (cd ../verifier && npm ci) && (cd ../host && npm ci) && (cd ../index && npm ci) && (cd ../mcp && npm ci)
//   ../fee-payer/build.sh                    # Kora, for the loop's own fee payer
//   npm ci && FOREST_DEVNET_SEED='<the phrase>' [RPC_URL=<an RPC>] npm run e2e [-- <services.json>]
//
//    1. keys: a seed each, and from it the profile's address and pay { solana, evm }, and the stamp
//       number at the loop verifier; the tutor's second profile, sports-coaching/coach;
//    2. funding: the phrase's deploy key makes each dollar account and sends SOL, and sends dollars
//       from its own USDC: the student's pay address, each wallet app's, and the loop's own fee payer;
//    3. stamps: the loop verifier's face check (its stand-in Didit passes it), a stamp for each,
//       kept on the person's device, then asked back from the verifier by its stamp number;
//    4. credits: each wallet app buys 10 of the host's credits for USDC;
//    5. profiles: credits into the folder, the signer adds the profile, and the device writes its
//       profile record again with a real stamp proof;
//    6. logins: each AI logs in through the connect page, where the person's signer makes the
//       connection and writes its rule into the profile's folder: post, message and pay within $5 a
//       day, and for the tutor read;
//    7. mcp: the tutor's AI posts an offer; the student's finds it and messages; the tutor's reads the
//       inbox and replies by number; the student's reads its inbox, outside its rule, so it needs
//       the person's yes, which the loop gives;
//    8. the deal, paid twice through the fee payer at cost: a direct payment, a plain transfer asked
//       for by the student's AI, whose answer says only done; and an escrow, version 4, on the
//       market's session schedule, paid out early;
//    9. reviews, each naming its evidence as <CAIP-2 chain>:<id>: the student's AI names the offer,
//       and its signer fills in the direct payment; the tutor's AI may not name the escrow, so the
//       tutor's app writes that review;
//   10. the loop index counts it all: both profiles, the offer, both reviews with their payments,
//       and what each profile shows (ratings, trust, uniqueness, pickiness) as its own ranking
//       makes them, signed, the deal; no message anywhere;
//   11. the trust carried: the tutor's device finds its leaf by its tag, proves its trust onto its
//       coach profile, and the index shows the proof;
//   12. addresses: no answer either AI received holds one of its own person's addresses;
//   13. balances: what each folder's credits came to.
// Then, passed or failed, what the loop started stops, and the loop's own fee payer's USDC and SOL go
// back to the deploy key. Everything it did goes to runs/<time>.json, whether it passed or not.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as escrow from '@foundationforest/escrow-client'
import { type PayAddresses, checkBytes, mainKey, newSeed, payAddresses, payKey, seedScalar, tagOf, unpackSignature, verifierScalarOf, verifierSecret } from '@foundationforest/keys'
import { type Body, b64u, hex, nextTime, ownerRecord, proofsOf, publish, readProfile, stampCheck } from '@foundationforest/records'
import { RULE_PREFIX, readerCount } from '@foundationforest/records/private'
import { buildTree, checkReputation, proofBytes as reputationBytes, proveReputation, signedBytes } from '@foundationforest/reputation'
import { type SignedStamp, checkStamp, proofBytes as stampBytes, proveStamp, stampFromJson, stampSigned, toBytes32 } from '@foundationforest/stamp'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

import { type Credit, DIRECTORY_PATH, PAYMENT_HEADER, amountOf, buy, creditList, finish, serviceOf } from '../host/client/client.ts'
import { hundredth, tenth } from '../index/src/pass.ts'
import { type Numbers, pickinessWord, rank, uniqueness } from '../index/src/rank.ts'
import { aiApp, logIn } from '../mcp/test/setup.ts'
import { type Choice, type PayWith, Signer } from '../mcp/test/signer.ts'
import { DOLLAR, type Paid, type Template, directPaymentIxs, dollarsOf, fundingFor, fundingIxs, keyFromPhrase, kora, payReferenceIxs, scheduleOf, send, sweepIxs, throughFeePayer, unitsOf } from './chain.ts'
import { type RunRecord, checkRecord, holdsNone } from './record.ts'
import { FACE_CONFIDENCE, type Running, VERIFIER_NAME, readServices, startServices } from './services.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const servicesFile = process.argv[2] ? resolve(process.argv[2]) : join(here, 'services.json')
const cfg = readServices(servicesFile)
const rpcUrl = process.env.RPC_URL || cfg.rpc
// The stamp circuit's files keep the names it was set up with.
const STAMP_FILES = { wasm: join(repo, 'standard/proofs/stamp/circuit/setup/note.wasm'), zkey: join(repo, 'standard/proofs/stamp/circuit/setup/note.zkey') }
const REPUTATION_FILES = { wasm: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.wasm'), zkey: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.zkey') }
/** The market the two people deal in, as the directory at MARKETS holds it. */
const MARKET = JSON.parse(readFileSync(join(repo, 'markets/markets', `${cfg.market}.json`), 'utf8')) as { payment: { [name: string]: Template } }
/** The market's schedule the escrow runs on. */
const SCHEDULE = 'session'
/** The tutor's second profile, where it carries its trust: another market, from the same seed. */
const COACH = 'sports-coaching/coach'
/** How many of the host's credits each person buys: about a dollar of writes a hundred times over. */
const CREDITS = 10
/** What the tutor's offer asks an hour, and what each payment of the deal is. */
const PRICE = 2n * DOLLAR
/** What each person lets their AI pay: the direct payment is within it. */
const LIMIT = { amount: '5', currency: 'USD', per: 'day' }
/** Where each signer's approval links point: the person's app, which the loop stands in for, so nothing fetches it. */
const APP = 'https://app.e2e-loop.invalid'
/** How long to wait for the index to show what was done. */
const INDEX_WAIT = 15 * 60_000
/** The numbers the loop index ranks by: its own, from index/config. */
const SCORING = JSON.parse(readFileSync(join(repo, 'index/config/scoring.json'), 'utf8')) as Numbers & { evidence: { [kind: string]: number } }

/** What must never reach the record or the log: the phrase, the RPC's URL when RPC_URL gave it, and each key, credit and login the run makes. */
const secrets: string[] = [process.env.FOREST_DEVNET_SEED ?? '', process.env.RPC_URL ?? '']
const redact = (text: string) => (process.env.RPC_URL ? text.split(process.env.RPC_URL).join('<RPC_URL>') : text)
const started = new Date()
const say = (line: string) => console.log(`[${((Date.now() - started.getTime()) / 1000).toFixed(0).padStart(4)} s] ${redact(line)}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const pin = (file: string) => readFileSync(join(repo, file), 'utf8').trim()
const where = (origin: string | null) => origin ?? 'loopback'

const record = {
  started: started.toISOString(),
  ended: '',
  passed: false,
  commits: { services: git('rev-parse', 'HEAD'), standard: pin('STANDARD'), markets: pin('MARKETS') },
  services: { verifier: 'loopback', host: where(cfg.host), feePayer: where(cfg.feePayer), index: 'loopback', mcp: 'loopback' },
  checked: [],
  chain: { rpc: process.env.RPC_URL ? 'RPC_URL' : cfg.rpc, escrow: cfg.escrow, testDollar: cfg.testDollar, market: cfg.market },
  steps: {},
} as RunRecord
const steps = record.steps as { [step: string]: { [key: string]: unknown } }

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

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const post = (url: string, body: unknown) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- A person's AI ----

/** A tool refused, in its words. */
class Refused extends Error {}

/** A person's AI: the MCP SDK's client on the mcp, logged in as the person let it, and every answer it got. */
class AI {
  readonly answers: string[] = []
  private readonly c: Awaited<ReturnType<typeof aiApp>>
  constructor(c: Awaited<ReturnType<typeof aiApp>>) {
    this.c = c
  }

  /** One tool, as a chat calls it: its answer, or its refusal, in its words. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = (await this.c.client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> }
    const text = r.content[0]?.text ?? ''
    this.answers.push(text)
    if (r.isError) throw new Refused(`${name}: ${text}`)
    return JSON.parse(text)
  }

  /** One tool the person's signer did. */
  async done(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const out = await this.call(name, args)
    assert.equal(out.status, 'done', `${name}: ${JSON.stringify(out)}`)
    return out
  }

  close = () => this.c.client.close()
}

/**
 * The connect page: a stand-in for the Forest app's, where the person whose turn it is chooses what
 * their AI may do, and their signer makes the connection and sends the browser back. One mcp sends
 * every login to one page, and the two people log in one after the other.
 */
async function connectPage(): Promise<{ url: string; at: { signer: Signer; choice: Choice } | null; close: () => void }> {
  const page: { url: string; at: { signer: Signer; choice: Choice } | null; close: () => void } = { url: '', at: null, close: () => server.close() }
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    if (!page.at) return void res.writeHead(409).end('nobody is at the connect page')
    page.at.signer.connect(q.get('connector')!, q.get('request')!, page.at.choice).then(
      (to) => res.writeHead(302, { location: to }).end(),
      (err: Error) => res.writeHead(500).end(err.message),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  page.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connect`
  return page
}

// ---- A person, as their device holds them ----

type Person = {
  role: 'tutor' | 'student'
  label: string
  /** The seed, which the device keeps behind its unlock; here, in memory for the run. */
  seed: Uint8Array
  scalar: bigint
  /** The profile's address, and its pay addresses. */
  address: string
  pay: PayAddresses
  /** The profile's Solana pay key: what pays the escrow. */
  payKey: Keypair
  stampNumber: bigint
  /** An address of its own apart from its profiles, as a wallet app holds one: what buys credits. */
  wallet: Keypair
  stamp?: SignedStamp
  credits: Credit[]
  signer?: Signer
  ai?: AI
}

async function person(role: Person['role']): Promise<Person> {
  const seed = newSeed()
  const label = `${cfg.market}/${role}`
  const solana = await payKey(seed, label, 'solana')
  const evm = await payKey(seed, label, 'evm')
  const wallet = Keypair.generate()
  secrets.push(hex.encode(seed), b64u.encode(seed), b64u.encode(solana.privateKey), hex.encode(evm.privateKey), b64u.encode(wallet.secretKey.subarray(0, 32)))
  return {
    role,
    label,
    seed,
    scalar: await seedScalar(seed),
    address: (await mainKey(seed, label)).address,
    pay: await payAddresses(seed, label),
    payKey: Keypair.fromSeed(solana.privateKey),
    stampNumber: (await verifierSecret(seed, VERIFIER_NAME)).stampNumber,
    wallet,
    credits: [],
  }
}

// ---- The steps ----

let services: Running | undefined
let page: Awaited<ReturnType<typeof connectPage>> | undefined
const people: Person[] = []
/** What the loop's own fee payer holds, swept back to the deploy key: set once it runs, sent when the run ends. */
let sweepBack: (() => Promise<NonNullable<RunRecord['sweep']>>) | undefined

/**
 * The face check, as the app does it: a session, the check (the stand-in passes it), the stamp
 * number sent, and a stamp back, checked. The app keeps it on the device, as safely as a key.
 */
async function faceStamp(p: Person) {
  const verifier = services!.verifier
  const session = await post(`${verifier.url}/face/session`, {})
  assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
  const got = await post(`${verifier.url}/face/stamp`, { sessionId: session.body.sessionId, stampNumber: p.stampNumber.toString() })
  assert.equal(got.status, 200, `a stamp: ${JSON.stringify(got.body)}`)
  const stamp = stampFromJson(got.body.stamp)
  assert.ok(stampSigned(stamp), 'the verifier signed it')
  assert.equal(stamp.verifier, verifier.keys.face, 'with its face key, which the loop index lists')
  assert.equal(stamp.stampNumber, p.stampNumber, 'for this person’s stamp number')
  p.stamp = stamp
  // A device that lost its stamp asks for it again by its stamp number: the same stamp comes back.
  const back = await post(`${verifier.url}/stamp`, { stampNumber: p.stampNumber.toString() })
  assert.equal(back.status, 200, `the stamp asked back: ${JSON.stringify(back.body)}`)
  const own = (x: SignedStamp) => ({ stampNumber: x.stampNumber, facts: x.facts, verifier: x.verifier, signature: x.signature })
  assert.deepEqual(own(stampFromJson(back.body.face)), own(stamp), 'asked back by its stamp number, it is the one signed')
  say(`${p.role}: a stamp from the loop verifier's face check, kept on the device, and the same asked back by its stamp number`)
  return { verifier: stamp.verifier, model: String(got.body.stamp.model), askedBack: 'same' }
}

/**
 * Credits bought for USDC, as a wallet app pays a buy: the host's directory read, a buy
 * made, a plain transfer from the wallet naming the buy's reference, the buy collected once the host
 * finds the payment final, and the credits finished.
 */
async function buyCredits(p: Person, token: escrow.Token, connection: Connection) {
  const host = services!.host
  const directory = await json(`${host}${DIRECTORY_PATH}`)
  assert.equal(directory.status, 200, `${host} publishes its credits`)
  const service = serviceOf(host, directory.body)
  if (!service.address || !service.mint) throw new Error(`${host} sells its credits only for its sponsors' tickets, and the loop pays in a dollar`)
  assert.equal(service.mint, token.mint.toBase58(), `${host} is paid in USDC, the loop's dollar`)
  const b = await buy(service, CREDITS)
  const amount = amountOf(service.price, CREDITS)
  const paid = await send(connection, payReferenceIxs({ from: p.wallet.publicKey, to: new PublicKey(service.address), reference: b.reference, units: unitsOf(amount, token.decimals), token }), [p.wallet])
  const answer = await waitFor(`${host} to find the payment final`, 180_000, async () => {
    const res = await fetch(service.requestUri, { method: 'POST', headers: { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `solana ${paid.signature}` }, body: b.buy as Uint8Array<ArrayBuffer> })
    if (res.status === 402) return null
    assert.equal(res.status, 200, `${host} answers the buy: ${await res.clone().text()}`)
    return new Uint8Array(await res.arrayBuffer())
  })
  p.credits = await finish(b.pending, answer)
  assert.equal(p.credits.length, CREDITS)
  secrets.push(...p.credits.map((c) => c.credit))
  say(`${p.role}: ${CREDITS} credits bought from its wallet, ${paid.signature}`)
  return { signature: paid.signature, amount, credits: CREDITS, reference: b.reference }
}

/** `n` of the person's credits spent into `folder`'s balance at the host. */
async function spend(p: Person, folder: string, n: number): Promise<number> {
  const got = await post(`${services!.host}/credits/spend`, { folder, credits: creditList(p.credits.splice(0, n)) })
  assert.equal(got.status, 200, `the host takes the credits: ${JSON.stringify(got.body)}`)
  return got.body.credits
}

/**
 * A profile of the person's, as their device makes it: the signer adds it (its hosts record and its
 * profile record), then the device writes its profile record again with a stamp proof
 * made on the device, and `more` proofs after it. Read back as any reader reads it, its stamp proof
 * checked as any reader checks it. Its folder holds credits first: the signer does not ask whether
 * the host took what it published.
 */
async function profile(p: Person, label: string, more: Body[] = []) {
  const host = services!.host
  const address = await p.signer!.addProfile(label)
  const view = await readProfile([host], address, Date.now(), { post: true })
  const body = view.current.get('profile')?.record.body
  assert.ok(body, `the host took ${label}'s profile record`)
  const r = await proveStamp({ seedScalar: p.scalar, verifierName: VERIFIER_NAME, stamp: p.stamp!, label, artifacts: STAMP_FILES })
  assert.equal(r.address, address, 'the stamp proof is for this profile')
  const proof = { circuit: 'stamp', verifier: r.verifier, verifierName: VERIFIER_NAME, label, tag: hex.encode(toBytes32(r.tag)), proof: b64u.encode(stampBytes(r.proof)) }
  const main = await mainKey(p.seed, label)
  const [out] = await publish([host], [ownerRecord(main, 'profile', { ...body, proofs: [proof, ...more] }, nextTime(Date.now(), view, 'profile'))])
  assert.ok(out!.results[0]?.ok, `the host takes the profile record with its proofs: ${JSON.stringify(out)}`)

  const shown = (await readProfile([host], address, Date.now(), { post: true })).current.get('profile')!.record.body!
  assert.deepEqual(shown.pay, { ...(await payAddresses(p.seed, label)) }, 'its pay addresses, solana and evm')
  assert.ok(typeof shown.inboxKey === 'string' && shown.inbox, 'its inbox key and its inbox')
  const check = stampCheck(proofsOf(shown).find((x) => x.circuit === 'stamp'), address)
  assert.ok(check && (await checkStamp(check)), 'its stamp proof checks')
  return { address, tag: proof.tag }
}

/**
 * A person's AI logs in: its first relayed call gets the challenge, the person's browser goes
 * through the connect page, where they choose, and the code becomes a login. Their signer is open
 * on the mcp, so the connection is registered as it is made.
 */
async function logInAs(p: Person, choice: Exclude<Choice, 'no'>) {
  const mcp = services!.mcp
  await p.signer!.open(mcp)
  const c = await aiApp(mcp)
  page!.at = { signer: p.signer!, choice }
  try {
    await logIn(c)
  } finally {
    page!.at = null
  }
  const token = c.app.tokens()?.access_token
  if (token) secrets.push(token)
  p.ai = new AI(c)
  const [market, role] = p.label.split('/')
  assert.deepEqual((await p.ai.done('profiles')).profiles, [{ market, role }], 'it may act for this profile, named by its market and role')
  // The rule, read back from the host as any of the person's signers reads it: one, in the profile's
  // folder, encrypted to the profile's own inbox key alone, for this connection, with what they chose.
  const view = await readProfile([services!.host], p.address, Date.now(), { post: true })
  const held = [...view.current].filter(([path, { record }]) => path.startsWith(RULE_PREFIX) && record.body)
  assert.deepEqual(held.map(([, { record }]) => readerCount(record.body as { private: string })), [1], 'one rule in the folder, for the profile alone')
  const [rule] = await p.signer!.rules(p.label)
  const who = rule!.who as { connector: string; key: string }
  secrets.push(who.key)
  assert.equal(who.connector, mcp, 'for this mcp')
  assert.deepEqual([rule!.can, rule!.limit], [choice.can, choice.limit], 'what the person chose')
  say(`${p.role}: its AI logged in, and may ${choice.can.join(', ')} as ${p.label}, paying up to ${LIMIT.amount} ${LIMIT.currency} a ${LIMIT.per}`)
  return { profiles: choice.profiles as string[], can: choice.can, limit: `${LIMIT.amount} ${LIMIT.currency} a ${LIMIT.per}` }
}

async function main() {
  const phrase = process.env.FOREST_DEVNET_SEED
  if (!phrase) throw new Error('FOREST_DEVNET_SEED is not set: the phrase’s deploy key funds the run')
  const connection = new Connection(rpcUrl, 'confirmed')
  const deploy = keyFromPhrase(phrase, 'deploy')
  const mint = new PublicKey(cfg.testDollar)
  const ESCROW = new PublicKey(cfg.escrow)
  const token = escrow.tokenOf(mint, (await connection.getAccountInfo(mint))!)
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)
  // The chain in CAIP-2 form, as a review's evidence names it: Solana's is the first 32 characters of its genesis hash.
  const chain = `solana:${(await connection.getGenesisHash()).slice(0, 32)}`

  say('the services: the loop’s own verifier, index and mcp, and the host and fee payer as services.json names them or our own')
  page = await connectPage()
  services = await startServices(cfg, { rpcUrl, payTo: deploy.publicKey.toBase58(), appUrl: page.url, say, redact })
  const s = services
  record.checked = s.checked
  record.loop = { verifier: { name: s.verifier.name, face: s.verifier.keys.face, id: s.verifier.keys.id }, index: s.index.address }
  say(`verifier ${s.verifier.url}, host ${s.host}, fee payer ${s.feePayer}, index ${s.index.url} (${s.index.address}), mcp ${s.mcp}`)

  // When the run ends, whatever happened, the loop's own fee payer gives back to the deploy key what
  // it holds: what the loop gave it, and what it was paid. Its key signs, as its operator's would;
  // the deploy key pays the fee, so nothing is left on it.
  if (s.ownFeePayerKey) {
    const key = Keypair.fromSecretKey(s.ownFeePayerKey)
    assert.equal(key.publicKey.toBase58(), s.ownFeePayer, 'the key the fee payer signs with')
    secrets.push(b64u.encode(key.secretKey.subarray(0, 32)), hex.encode(key.secretKey.subarray(0, 32)))
    sweepBack = async () => {
      const account = await connection.getAccountInfo(ata(key.publicKey))
      const dollars = account ? BigInt((await connection.getTokenAccountBalance(ata(key.publicKey))).value.amount) : null
      const lamports = await connection.getBalance(key.publicKey)
      const back = { dollars: (dollars ?? 0n).toString(), lamports: lamports + (account?.lamports ?? 0) }
      const ixs = sweepIxs({ from: key.publicKey, to: deploy.publicKey, dollars, lamports, token })
      return ixs.length ? { signature: (await send(connection, ixs, [deploy, key])).signature, ...back } : back
    }
  }

  // A payment the signer makes when the person's AI asks it to pay: a direct payment, a plain
  // transfer from the profile's pay key, through the fee payer at cost.
  const payments: Paid[] = []
  const payWith: PayWith = async ({ from, to, amount }) => {
    const signer = Keypair.fromSeed(from.privateKey)
    const paid = await throughFeePayer(connection, s.feePayer, signer, directPaymentIxs({ from: signer.publicKey, to: new PublicKey(to), units: unitsOf(amount, token.decimals), token }), token)
    payments.push(paid)
    return `${chain}:${paid.signature}`
  }

  // 1. Keys.
  const tutor = await person('tutor')
  const student = await person('student')
  people.push(tutor, student)
  const coach = { address: (await mainKey(tutor.seed, COACH)).address, pay: await payAddresses(tutor.seed, COACH) }
  steps.keys = {
    tutor: { label: tutor.label, profile: tutor.address, pay: tutor.pay },
    student: { label: student.label, profile: student.address, pay: student.pay },
    coach: { label: COACH, profile: coach.address, pay: coach.pay },
  }
  say(`two people, each from a seed: tutor ${tutor.address}, student ${student.address}`)

  // 2. Funding.
  const tutorPay = new PublicKey(tutor.pay.solana)
  const studentPay = new PublicKey(student.pay.solana)
  const ownFeePayer = s.ownFeePayer ? new PublicKey(s.ownFeePayer) : null
  const plan = fundingFor({ tutorPay, studentPay, wallets: [tutor.wallet.publicKey, student.wallet.publicKey], feePayer: ownFeePayer })
  const holds = await connection.getTokenAccountBalance(ata(deploy.publicKey)).then((b) => BigInt(b.value.amount), () => 0n)
  if (holds < dollarsOf(plan)) {
    throw new Error(`the deploy key ${deploy.publicKey.toBase58()} holds ${Number(holds) / 1e6} USDC, and a run moves ${Number(dollarsOf(plan)) / 1e6}: fill it from Circle's faucet, https://faucet.circle.com`)
  }
  const funding = fundingIxs(plan, deploy.publicKey, token)
  const accounts = await send(connection, funding.accounts, [deploy])
  const money = await send(connection, funding.money, [deploy])
  steps.funding = { accounts: accounts.signature, money: money.signature, wallets: { tutor: tutor.wallet.publicKey.toBase58(), student: student.wallet.publicKey.toBase58() }, feePayer: s.ownFeePayer }
  say(`funded from the deploy key's own USDC, ${Number(dollarsOf(plan)) / 1e6} in all: each dollar account, the student’s dollars, each wallet’s dollar and SOL, and our own fee payer’s SOL`)

  // 3. Stamps.
  steps.stamps = { tutor: await faceStamp(tutor), student: await faceStamp(student) }

  // 4. Credits.
  steps.credits = { tutor: await buyCredits(tutor, token, connection), student: await buyCredits(student, token, connection) }

  // 5. Profiles. The tutor keeps four credits for its coach profile.
  const profiles: { [role: string]: unknown } = {}
  for (const [p, n] of [[tutor, CREDITS - 4], [student, CREDITS]] as const) {
    p.signer = new Signer({ seed: p.seed, hosts: [s.host], appUrl: APP, payWith })
    const spent = await spend(p, p.address, n)
    const made = await profile(p, p.label)
    profiles[p.role] = { profile: made.address, tag: made.tag, spent, stampProof: 'checks' }
    say(`${p.role}: its profile on the host, ${made.address}, with a stamp proof and pay { solana, evm }`)
  }
  steps.profiles = profiles

  // 6. Logins: what each person lets their AI do. The tutor's AI reads the tutor's inbox; the
  // student's may not read, so its one read waits for the student's yes.
  const choice = (p: Person, can: string[]): Exclude<Choice, 'no'> => ({ profiles: [p.label], can, limit: LIMIT })
  steps.logins = { tutor: await logInAs(tutor, choice(tutor, ['post', 'message', 'read', 'pay'])), student: await logInAs(student, choice(student, ['post', 'message', 'pay'])) }

  // 7. mcp: every call through the AI's own client.
  const [market, tutorRole] = tutor.label.split('/') as [string, string]
  const studentRole = student.label.split('/')[1]!
  const read = await tutor.ai!.call('market', { market })
  assert.ok(read.kinds.includes('offer') && read.market.offer.price, 'the tutor’s AI reads what an offer holds')
  const offer = {
    description: 'Maths for secondary school, one hour online. A test offer, posted by an AI through mcp by e2e.',
    price: { amount: (PRICE / DOLLAR).toString(), currency: 'USD', per: 'hour' },
    payment: ['direct', SCHEDULE],
    subjects: ['maths'],
    levels: ['secondary'],
    place: { online: true },
  }
  const posted = await tutor.ai!.done('post', { market, role: tutorRole, kind: 'offer', id: 'maths', body: offer })
  assert.deepEqual([posted.kind, posted.id], ['offer', 'maths'])
  const offerAddress = `${tutor.address}/offer/maths`
  // A record is in a reader's view only when the profile's main key signed it.
  assert.equal((await readProfile([s.host], tutor.address, Date.now())).current.get('offer/maths')?.record.body?.description, offer.description, 'on the host, signed by the tutor’s main key')
  say(`mcp: the tutor's AI posted ${offerAddress}`)

  const found = await waitFor('the offer in the index’s search, through the mcp', INDEX_WAIT, async () => {
    const out = await student.ai!.call('search', { filters: { q: 'maths', market, role: tutorRole } })
    return (out.index.answer.results as Array<{ profile: string; post: { address: string } }> | undefined)?.find((r) => r.post.address === offerAddress)
  })
  const text = 'Is Tuesday at six free? A test message, sent through mcp by e2e.'
  await student.ai!.done('message', { market, role: studentRole, to: found.profile, text })
  say('mcp: the student’s AI found the offer in the index’s search, and messaged the tutor')

  const box = await tutor.ai!.done('inbox', { market, role: tutorRole })
  const asked = (box.messages as Array<{ number: number; from: string; text?: string }>).find((m) => m.text === text)
  assert.ok(asked, 'the tutor’s AI reads the message')
  assert.equal(asked.from, student.address, 'from the student’s profile')
  const replyText = 'Tuesday at six, yes. A test reply, sent through mcp by e2e.'
  await tutor.ai!.done('reply', { number: asked.number, text: replyText })
  say(`mcp: the tutor's AI read it, as number ${asked.number}, and replied by that number`)

  const outside = await student.ai!.call('inbox', { market, role: studentRole })
  assert.equal(outside.status, 'needs approval', 'reading is not in what the student let its AI do')
  assert.match(outside.link, /^https:\/\//)
  const yes = await student.signer!.approve(outside.link)
  assert.equal(yes.status, 'done', 'the student said yes')
  const replied = ((yes as { result: Body }).result.messages as Array<{ from: string; text?: string }>).find((m) => m.text === replyText)
  assert.equal(replied?.from, tutor.address, 'and the tutor’s reply is there')
  steps.mcp = { offer: offerAddress, found: { profile: found.profile }, message: { number: asked.number }, reply: 'done', approval: { tool: 'inbox', why: outside.why, approved: yes.status } }
  say('mcp: the student’s AI asked to read its inbox, outside its rule; it needed the student’s yes, and the loop gave it')

  // 8. The deal, paid twice, each through the fee payer at cost. The AI's answer says only done: the
  // payment is the signer's to know, and to name in a review.
  const balance = async (owner: PublicKey) => BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount)
  const before = await balance(tutorPay)
  const pay = await student.ai!.done('pay', { offer: offerAddress, role: studentRole, amount: (PRICE / DOLLAR).toString() })
  assert.deepEqual(pay, { status: 'done' }, 'the AI is told only that it is done')
  assert.equal(payments.length, 1, 'one payment, made by the student’s signer')
  const direct = payments[0]!
  const directEvidence = `${chain}:${direct.signature}`
  assert.equal(await balance(tutorPay), before + PRICE, 'the tutor got the direct payment')
  say(`deal: the student's AI paid ${PRICE / DOLLAR} USDC directly, within its limit, ${direct.signature}, charged ${direct.charge} base units`)

  const sponsor = new PublicKey((await kora<{ signer_address: string }>(s.feePayer, 'getPayerSigner')).signer_address)
  const schedule = scheduleOf(MARKET.payment[SCHEDULE]!, Math.floor(Date.now() / 1000))
  const terms = escrow.termsFor({ schedule }, { recipient: tutorPay, amount: PRICE })
  const keys = escrow.keysFor({ payer: studentPay, sponsor, mint, terms, tokenProgram: token.program, programId: ESCROW })
  const receipt = async () => escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  const opened = await throughFeePayer(connection, s.feePayer, student.payKey, escrow.createAndFund({ payer: studentPay, sponsor, token, terms, programId: ESCROW }), token)
  const open = await receipt()
  assert.equal(open.status, 'funded', 'opened, paid into and marked')
  assert.equal(open.version, 4, 'by the escrow’s version 4')
  assert.deepEqual(open.schedule, terms.schedule, `on the market's ${SCHEDULE} schedule`)
  const early = await throughFeePayer(connection, s.feePayer, student.payKey, [escrow.payIx({ keys, programId: ESCROW })], token)
  const ended = await receipt()
  assert.deepEqual([ended.status, ended.outcome, ended.toRecipient], ['ended', 'pay', PRICE], 'paid out to the tutor, early')
  assert.ok(ended.payer.equals(studentPay) && ended.recipient.equals(tutorPay), 'between the two pay addresses')
  assert.ok(ended.sponsor.equals(sponsor), 'its rent back to the fee payer, which fronted it')
  assert.ok(escrow.escrowAddress(escrow.termsOf(ended), ESCROW).equals(keys.escrow), 'its address is its terms’')
  const escrowEvidence = `${chain}:${keys.escrow.toBase58()}`
  steps.deal = {
    payment: { ...direct, evidence: directEvidence },
    escrow: { address: keys.escrow.toBase58(), version: open.version, open: opened, pay: early, outcome: ended.outcome, sponsor: sponsor.toBase58(), schedule, evidence: escrowEvidence },
  }
  say(`deal: an escrow, version ${open.version}, on the ${SCHEDULE} schedule, ${keys.escrow.toBase58()}, opened and paid in, then paid out early`)

  // 9. Reviews, each naming its evidence. The student's AI names the offer, and the student's signer
  // fills in the payment it made for it. Evidence is never an AI's to write, and the tutor's signer
  // paid nothing, so the tutor's AI may not name the escrow: the tutor's app writes that review
  // itself, naming the escrow, which it saw pay the tutor's pay address.
  const byStudent = await student.ai!.done('post', { market, role: studentRole, kind: 'review', body: { subject: found.profile, score: '10', text: 'Clear and patient. A test review.', offer: offerAddress } })
  const studentReview = (await readProfile([s.host], student.address, Date.now())).current.get(`review/${byStudent.id}`)?.record.body
  assert.equal(studentReview?.evidence, directEvidence, 'its evidence, filled in by the student’s signer: the direct payment')
  const tutorReview = { subject: asked.from, score: '9', text: 'On time, paid at once. A test review.', evidence: escrowEvidence }
  await assert.rejects(tutor.ai!.call('post', { market, role: tutorRole, kind: 'review', body: tutorReview }), /evidence is the person's signer's to fill/, 'the tutor’s AI may not name the escrow')
  const tutorMain = await mainKey(tutor.seed, tutor.label)
  const tutorView = await readProfile([s.host], tutor.address, Date.now(), { post: true })
  const tutorReviewId = hex.encode(crypto.getRandomValues(new Uint8Array(8)))
  const [took] = await publish([s.host], [ownerRecord(tutorMain, `review/${tutorReviewId}`, tutorReview, nextTime(Date.now(), tutorView, `review/${tutorReviewId}`))])
  assert.ok(took!.results[0]?.ok, `the host takes the tutor’s review: ${JSON.stringify(took)}`)
  steps.reviews = { student: { id: byStudent.id, evidence: directEvidence, postedBy: 'ai' }, tutor: { id: tutorReviewId, evidence: escrowEvidence, postedBy: 'app' } }
  say('two reviews: the student’s AI named the offer and its signer the direct payment; the tutor’s AI was refused the escrow, and the tutor’s app named it')

  // 10. The loop index counts it all. What each profile shows is what the index's own ranking makes
  // of these two reviews, with its own numbers: each profile's face check counted, each review a
  // rating backed by a payment and its writer's word about the other, a vouch; a rating to one
  // decimal, trust and uniqueness from 0 to 100, as the index shows them.
  const index = s.index
  const profilePage = (address: string) => json(`${index.url}/profiles/${address}.json`)
  const face = uniqueness([FACE_CONFIDENCE])
  const ranked = rank(
    [{ address: tutor.address, uniqueness: face }, { address: student.address, uniqueness: face }],
    [
      { writer: student.address, subject: tutor.address, score: 10, evidence: SCORING.evidence.payment! },
      { writer: tutor.address, subject: student.address, score: 9, evidence: SCORING.evidence.escrow! },
    ],
    [
      { writer: student.address, subject: tutor.address, kind: 'rating', time: 0, address: `${student.address}/review/${byStudent.id}` },
      { writer: tutor.address, subject: student.address, kind: 'rating', time: 0, address: `${tutor.address}/review/${tutorReviewId}` },
    ],
    SCORING,
  )
  const want = (address: string) => ({
    ratings: { value: tenth(ranked.ratings.get(address)!.value), count: 1 },
    trust: hundredth(ranked.trust.get(address)!),
    uniqueness: hundredth(face),
    pickiness: pickinessWord(ranked.pickiness.get(address)!, SCORING),
  })
  type Shown = { ratings: { value: number; count: number }; trust: number; uniqueness: number; pickiness: string; statement: string; signature: string }
  const shownOf = (v: Shown) => ({ ratings: v.ratings, trust: v.trust, uniqueness: v.uniqueness, pickiness: v.pickiness })
  const describe = (w: { ratings: { value: number | null; count: number }; trust: number; uniqueness: number; pickiness: string }) => `rated ${w.ratings.value} by ${w.ratings.count}, trust ${w.trust}, uniqueness ${w.uniqueness}, pickiness ${w.pickiness}`
  say(`the index: waiting for both profiles, the offer, both reviews with their payments, the tutor ${describe(want(tutor.address))}, the student ${describe(want(student.address))}, and the deal`)
  const shown = await waitFor('the index to show it all', INDEX_WAIT, async () => {
    const [t, st] = await Promise.all([profilePage(tutor.address), profilePage(student.address)])
    if (t.status !== 200 || st.status !== 200) return null
    for (const [v, w] of [[t.body, want(tutor.address)], [st.body, want(student.address)]] as const) {
      if (!v.checks.some((c: { key: string }) => c.key === s.verifier.keys.face)) return null
      if (JSON.stringify(shownOf(v)) !== JSON.stringify(w)) return null
      if (!v.reviews.received.every((r: { counted: boolean; evidence: string }) => r.counted && r.evidence === 'with')) return null
    }
    if (!t.body.posts.some((p: { address: string; listed: boolean }) => p.address === offerAddress && p.listed)) return null
    const d = await json(`${index.url}/deals/${keys.escrow.toBase58()}.json`)
    if (d.status !== 200 || d.body.receipt?.outcome !== 'pay' || d.body.reviews.length !== 1 || !d.body.reviews[0].counted) return null
    return { tutor: t.body as Shown, student: st.body as Shown, deal: d.body }
  })
  for (const v of [shown.tutor, shown.student]) {
    const signature = unpackSignature(b64u.decode(v.signature))
    assert.ok(signature && checkBytes(index.address, new TextEncoder().encode(v.statement), signature), 'what each profile shows, signed by the index')
  }
  assert.equal(JSON.stringify(shown).includes(text) || JSON.stringify(shown).includes(replyText), false, 'no message is anywhere in the index')
  const rated = (v: Shown, address: string) => ({
    url: `${index.url}/profiles/${address}`,
    rating: v.ratings.value,
    count: v.ratings.count,
    trust: v.trust,
    uniqueness: v.uniqueness,
    pickiness: v.pickiness,
    statement: v.statement,
  })
  steps.index = {
    tutor: rated(shown.tutor, tutor.address),
    student: rated(shown.student, student.address),
    deal: { url: `${index.url}/deals/${keys.escrow.toBase58()}`, outcome: shown.deal.receipt.outcome, amount: shown.deal.receipt.amount, reviews: shown.deal.reviews.length },
  }
  say(`the index counts it all: the tutor ${describe(shownOf(shown.tutor))}, the student ${describe(shownOf(shown.student))}, each from one review with a payment, signed; the deal paid`)

  // 11. The trust carried to the coach profile, proven on the device. The tutor's leaf holds its
  // trust, with a count of 1: the index's tree, as its README says.
  const tag = hex.encode(toBytes32(tagOf(verifierScalarOf(tutor.scalar, VERIFIER_NAME), tutor.label)))
  const tree = await waitFor('the tutor’s leaf in the index’s tree', INDEX_WAIT, async () => {
    const [t, l] = await Promise.all([json(`${index.url}/v1/reputation`), json(`${index.url}/v1/reputation/leaves`)])
    if (t.status !== 200 || l.status !== 200 || t.body.root !== l.body.root) return null
    const mine = l.body.leaves.find((x: { tag: string }) => x.tag === tag)
    return mine?.score === shown.tutor.trust && mine.count === 1 ? { served: t.body as { index: string; root: string; time: number; signature: string }, leaves: l.body.leaves as { tag: string; scope: string; score: number; count: number }[] } : null
  })
  const leaves = tree.leaves.map((l) => ({ tag: BigInt(`0x${l.tag}`), scope: BigInt(`0x${l.scope}`), score: BigInt(l.score), count: BigInt(l.count) }))
  const root = buildTree(leaves).root
  const rootSignature = b64u.decode(tree.served.signature)
  assert.equal(hex.encode(toBytes32(root)), tree.served.root, 'the leaves served make the root served')
  assert.ok(checkBytes(index.address, signedBytes(root, tree.served.time), unpackSignature(rootSignature)!), 'signed by the index')
  const carried = await proveReputation({ seedScalar: tutor.scalar, sources: [{ label: tutor.label, verifierName: VERIFIER_NAME }], leaves, profileLabel: COACH, artifacts: REPUTATION_FILES })
  assert.equal(carried.address, coach.address, 'proven onto the coach profile')
  assert.equal(Number(carried.score), shown.tutor.trust, 'carrying the tutor’s trust')
  assert.ok(await checkReputation({ proof: carried.proof, root, score: carried.score, profile: coach.address, index: index.address, time: tree.served.time, signature: rootSignature }), 'it checks')
  const reputation = { circuit: 'reputation', index: tree.served.index, root: tree.served.root, time: tree.served.time, signature: tree.served.signature, score: Number(carried.score), proof: b64u.encode(reputationBytes(carried.proof)) }
  await spend(tutor, coach.address, 4)
  await profile(tutor, COACH, [reputation])
  say(`tutor: its trust, ${carried.score}, proven onto ${coach.address}`)
  const proofShown = await waitFor('the index to show the proof on the coach profile', INDEX_WAIT, async () => {
    const v = await profilePage(coach.address)
    const x = v.status === 200 ? v.body.proofs?.find((p: { circuit: string }) => p.circuit === 'reputation') : null
    return x?.result === 'shown' && x.trust === shown.tutor.trust ? x : null
  })
  steps.reputation = { profile: coach.address, url: `${index.url}/profiles/${coach.address}`, tag, root: tree.served.root, time: tree.served.time, leaves: leaves.length, score: Number(carried.score), result: proofShown.result }
  say('the index shows the carried trust on the coach profile')

  // 12. No answer either AI received holds one of its own person's addresses: each profile's, the
  // coach's included, and each pay address. An AI acting for one person reads the
  // other's addresses, as it must to message them and review them.
  const addresses: { [role: string]: unknown } = {}
  for (const p of people) {
    const own = (await p.signer!.addresses()).map((a) => a.toLowerCase())
    const answers = p.ai!.answers.map((a) => a.toLowerCase())
    const held = own.filter((a) => answers.some((answer) => answer.includes(a)))
    assert.deepEqual(held, [], `an answer ${p.role}'s AI got holds one of ${p.role}'s own addresses`)
    addresses[p.role] = { answers: answers.length, addresses: own.length, held: held.length }
  }
  steps.addresses = addresses
  say(`no answer holds the person's own addresses: ${tutor.ai!.answers.length} answers to the tutor's AI, ${student.ai!.answers.length} to the student's`)

  // 13. Balances.
  const left = async (folder: string) => (await json(`${s.host}/credits/balance/${folder}`)).body.credits as number
  steps.balances = { tutor: await left(tutor.address), student: await left(student.address), coach: await left(coach.address) }
}

try {
  await main()
  record.passed = true
} catch (err) {
  record.error = redact((err as Error).stack ?? String(err))
  console.error(record.error)
} finally {
  for (const p of people) {
    await p.ai?.close().catch(() => {})
    p.signer?.close()
  }
  await services?.stop().catch((err) => console.error(redact(String(err))))
  page?.close()
  if (sweepBack) {
    try {
      record.sweep = await sweepBack()
      say(`swept back from our own fee payer to the deploy key: ${Number(record.sweep.dollars) / 1e6} USDC and ${record.sweep.lamports / 1e9} SOL`)
    } catch (err) {
      // A run that cannot give back what its own fee payer holds fails, saying so: the fee payer's key goes with the run.
      record.passed = false
      record.error = `${record.error ?? ''}\nthe sweep: ${redact((err as Error).stack ?? String(err))}`.trim()
      console.error(redact(String(err)))
    }
  }
  record.ended = new Date().toISOString()
  let text = JSON.stringify(record, null, 2) + '\n'
  try {
    checkRecord(record)
    holdsNone(text, secrets)
  } catch (err) {
    // A record that is not one, or that would hold a secret, is written as a failure with no steps.
    const failed = { ...record, passed: false, error: `${record.error ?? ''}\nthe record: ${(err as Error).message}`.trim(), steps: {} }
    record.passed = false
    text = JSON.stringify(failed, null, 2) + '\n'
    holdsNone(text, secrets)
  }
  mkdirSync(join(here, 'runs'), { recursive: true })
  const file = join(here, 'runs', `${started.toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, text)
  say(`the run ${record.passed ? 'passed' : 'failed'}: ${file}`)
}
// The RPC client keeps sockets open, and the proofs' workers; the run is over either way.
process.exit(record.passed ? 0 : 1)
