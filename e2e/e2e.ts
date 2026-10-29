// The loop: Forest end to end. Two people from two seeds, a tutor who sells and a student who buys.
// Each one's device is the reference app (mcp/test/app.ts), unchanged: it holds the seed and the
// stamp, keeps the Profiles folder, makes each profile with its verification, and at the connect
// page hands the mcp an access key for the profile ticked. What it has no method for, the device
// does here with the standard's pieces: the stamp asked for, the payment, the reputation proof. Each
// person's AI is the MCP SDK's own client (mcp/test/setup.ts), logging in through the loop's connect
// page and calling the mcp's tools, which act in the person's folder with that access key. Against
// the host and fee payer services.json names, or the loop's own copies on loopback, with the loop's
// own verifier, index and mcp (services.ts); the chain is remote, through RPC_URL, or
// services.json's rpc.
//
//   ../standard.sh
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
//    5. profiles: credits into each folder, the stamp kept in the Profiles folder, and the profile,
//       its profile entry with a verification made on the device, listed there too;
//    6. logins: each AI logs in through the connect page, where the person ticks their profile and
//       their app lists an access key in its profile entry with every switch, writes its note, and
//       hands the mcp the pack;
//    7. mcp: the tutor's AI writes an offer; the student's finds it through the index's search and
//       messages the tutor; the tutor's reads the inbox, the student's market, role and checks as the
//       index shows them, and replies; the student's reads the reply;
//    8. the payment: the student's app pays the tutor's pay address directly, a plain transfer through
//       the fee payer at cost;
//    9. the review: the student's AI reviews the tutor, naming the offer and the payment as evidence;
//   10. the loop index counts it all: both profiles, the offer, the review with its payment, and what
//       each profile shows (ratings, trust, uniqueness, pickiness) as its own ranking makes them,
//       signed; no message anywhere;
//   11. the trust carried: the tutor's device finds its leaf by its profile, proves its trust onto
//       its coach profile, and the index shows the proof;
//   12. removed: the tutor's app takes the access key out of the profile entry; the host refuses its
//       AI's next write, and the offer it wrote counts for nothing;
//   13. a new device: from the tutor's seed alone, the Profiles folder gives its two profiles and its
//       stamp;
//   14. addresses: no answer either AI received holds one of its own person's addresses;
//   15. balances: what each folder's credits came to.
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
import { type Body, b64u, checkPay, hex, notePath, proofsOf, readFolder, verificationCheck } from '@foundationforest/folders'
import { lockCount, openLocked } from '@foundationforest/folders/locked'
import { type PayAddresses, checkBytes, mainKey, newSeed, openingHalf, payAddresses, payKey, pointOf, profilesKey, seedScalar, unpackSignature, verifierSecret } from '@foundationforest/keys'
import { buildTree, checkReputation, proofBytes as reputationBytes, proveReputation, signedBytes } from '@foundationforest/reputation'
import { type SignedStamp, checkVerification, stampFromJson, stampSigned, toBytes32 } from '@foundationforest/verification'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

import { type Credit, DIRECTORY_PATH, PAYMENT_HEADER, amountOf, buy, creditList, finish, serviceOf } from '../host/client/client.ts'
import { hundredth, tenth } from '../index/src/pass.ts'
import { type Numbers, pickinessWord, rank, uniqueness } from '../index/src/rank.ts'
import { App } from '../mcp/test/app.ts'
import { aiApp, logIn } from '../mcp/test/setup.ts'
import { DOLLAR, type Paid, directPaymentIxs, dollarsOf, fundingFor, fundingIxs, keyFromPhrase, payReferenceIxs, send, sweepIxs, throughFeePayer, unitsOf } from './chain.ts'
import { type RunRecord, checkRecord, holdsNone } from './record.ts'
import { FACE_CONFIDENCE, type Running, VERIFIER_NAME, readServices, startServices } from './services.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const servicesFile = process.argv[2] ? resolve(process.argv[2]) : join(here, 'services.json')
const cfg = readServices(servicesFile)
const rpcUrl = process.env.RPC_URL || cfg.rpc
const REPUTATION_FILES = { wasm: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.wasm'), zkey: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.zkey') }
/** The tutor's second profile, where it carries its trust: another market, from the same seed. */
const COACH = 'sports-coaching/coach'
/** How many of the host's credits each person buys: about a dollar of writes a hundred times over. */
const CREDITS = 10
/** What the tutor's offer asks an hour, and what the student pays. */
const PRICE = 2n * DOLLAR
/** What the person's app lets each AI do in the profile ticked, unless the person chooses fewer: every switch. */
const SWITCHES = ['read-inbox', 'read', 'write', 'message']
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
  chain: { rpc: process.env.RPC_URL ? 'RPC_URL' : cfg.rpc, testDollar: cfg.testDollar, market: cfg.market },
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

  close = () => this.c.client.close()
}

/**
 * The connect page: a stand-in for the Forest app's, where the person whose turn it is ticks the
 * profiles their AI acts in, and their app hands back the pack. One mcp sends every login to one
 * page, and the two people log in one after the other.
 */
async function connectPage(): Promise<{ url: string; at: { app: App; profiles: string[] } | null; close: () => void }> {
  const page: { url: string; at: { app: App; profiles: string[] } | null; close: () => void } = { url: '', at: null, close: () => server.close() }
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    if (!page.at) return void res.writeHead(409).end('nobody is at the connect page')
    page.at.app.connect(q.get('connector')!, q.get('request')!, { profiles: page.at.profiles }).then(
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
  /** The profile's Solana pay key: what pays. */
  payKey: Keypair
  stampNumber: bigint
  /** An address of its own apart from its profiles, as a wallet app holds one: what buys credits. */
  wallet: Keypair
  stamp?: SignedStamp
  credits: Credit[]
  app?: App
  ai?: AI
  /** The address of the access key the person's app handed the mcp for the profile. */
  key?: string
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

/** Every address of one person's: each profile's, and its pay addresses, and the Profiles folder's. What no answer to their AI holds. */
async function addressesOf(p: Person, labels: string[]): Promise<string[]> {
  const out = [(await profilesKey(p.seed)).address]
  for (const label of labels) out.push((await mainKey(p.seed, label)).address, ...Object.values(await payAddresses(p.seed, label)))
  return out
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

/** A folder's current profile entry's body, as any reader reads it from the host. */
async function profileEntry(address: string): Promise<Body | null> {
  return (await readFolder([services!.host], address, Date.now())).current.get('profile')?.entry.body ?? null
}

/**
 * A profile of the person's, as their device makes it: the app adds it, its profile entry with a
 * verification made on the device from the stamp it keeps and `more` proofs after it, and lists it
 * in the Profiles folder. Read back as any reader reads it, its verification checked as any reader
 * checks it. Its folder holds credits first: the app writes only where the host takes it.
 */
async function profile(p: Person, label: string, more: Body[] = []) {
  const address = await p.app!.addProfile(label, { proofs: more })
  const shown = await profileEntry(address)
  assert.ok(shown, `the host took ${label}'s profile entry`)
  assert.deepEqual(shown.pay, { ...(await payAddresses(p.seed, label)) }, 'its pay addresses, solana and evm')
  assert.deepEqual(checkPay(shown, address), ['solana', 'evm'], 'each signed by its pay key')
  assert.ok(typeof shown.openKey === 'string', 'its open key, so it takes messages')
  const verification = proofsOf(shown).find((x) => x.circuit === 'verification')
  const check = verificationCheck(verification, address)
  assert.ok(check && (await checkVerification(check)), 'its verification checks')
  assert.equal(verification!.verifier, p.stamp!.verifier, 'from the stamp the device keeps')
  return address
}

/**
 * A person's AI logs in: its first call to act gets the challenge, the person's browser goes
 * through the connect page, where they tick their profile, and their app lists an access key in its
 * profile entry with every switch, writes its note, and hands the mcp the pack; the code becomes a
 * login. Read back from the host: one access key listed, and its note locked to the main key alone.
 */
async function logInAs(p: Person) {
  const mcp = services!.mcp
  const c = await aiApp(mcp)
  page!.at = { app: p.app!, profiles: [p.label] }
  try {
    await logIn(c)
  } finally {
    page!.at = null
  }
  const token = c.app.tokens()?.access_token
  if (token) secrets.push(token)
  p.ai = new AI(c)
  assert.deepEqual((await p.ai.call('my_profiles')).profiles, [{ label: p.label, can: SWITCHES }], 'it acts in this profile, by its label, with every switch')
  const keys = await p.app!.keys(p.label)
  assert.equal(keys.length, 1, 'one access key in the profile entry')
  assert.deepEqual(keys[0]!.can, SWITCHES)
  p.key = keys[0]!.key
  const main = await mainKey(p.seed, p.label)
  const note = (await readFolder([services!.host], p.address, Date.now())).current.get(notePath(main.secret, p.key))?.entry.body as { private: string } | undefined
  assert.ok(note && lockCount(note) === 1, 'its note, at its keyed path, locked to one key')
  const opened = await openLocked(note, (await openingHalf(main.secret)).identity)
  assert.equal(opened.connector, mcp, 'which the main key opens, naming this mcp')
  say(`${p.role}: its AI logged in, and acts in ${p.label} with the access key ${p.key}: ${SWITCHES.join(', ')}`)
  return { profiles: [p.label], can: keys[0]!.can, key: p.key, note: 'locked to the main key' }
}

async function main() {
  const phrase = process.env.FOREST_DEVNET_SEED
  if (!phrase) throw new Error('FOREST_DEVNET_SEED is not set: the phrase’s deploy key funds the run')
  const connection = new Connection(rpcUrl, 'confirmed')
  const deploy = keyFromPhrase(phrase, 'deploy')
  const mint = new PublicKey(cfg.testDollar)
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

  // 5. Profiles: credits into the Profiles folder, where the app keeps the stamp, and into the
  // profile's folder, then the profile. The tutor keeps three credits for its coach profile.
  const profiles: { [role: string]: unknown } = {}
  for (const [p, n] of [[tutor, CREDITS - 5], [student, CREDITS - 2]] as const) {
    p.app = new App({ seed: p.seed, hosts: [s.host] })
    const folder = (await profilesKey(p.seed)).address
    await spend(p, folder, 2)
    await p.app.keep(p.stamp!, VERIFIER_NAME)
    const spent = await spend(p, p.address, n)
    const made = await profile(p, p.label)
    profiles[p.role] = { profile: made, profilesFolder: folder, spent, verification: 'checks' }
    say(`${p.role}: its profile on the host, ${made}, with a verification and pay { solana, evm }, listed in its Profiles folder`)
  }
  steps.profiles = profiles

  // 6. Logins: each AI acts in its person's profile, with every switch.
  steps.logins = { tutor: await logInAs(tutor), student: await logInAs(student) }

  // 7. mcp: every call through the AI's own client.
  const [market, tutorRole] = tutor.label.split('/') as [string, string]
  const read = await tutor.ai!.call('markets', { name: market })
  assert.ok(read.kinds.includes('offer') && read.market.offer.price, 'the tutor’s AI reads what an offer holds')
  const offer = {
    description: 'Maths for secondary school, one hour online. A test offer, posted by an AI through mcp by e2e.',
    price: { amount: (PRICE / DOLLAR).toString(), currency: 'USD', per: 'hour' },
    payment: ['direct'],
    subjects: ['maths'],
    levels: ['secondary'],
    place: { online: true },
  }
  assert.equal((await tutor.ai!.call('write', { label: tutor.label, path: 'offer/maths', body: offer })).written, 'offer/maths')
  const offerAddress = `${tutor.address}/offer/maths`
  const onHost = (await readFolder([s.host], tutor.address, Date.now())).current.get('offer/maths')?.entry
  assert.equal(onHost?.body?.description, offer.description, 'on the host, and current')
  assert.equal(onHost?.key, tutor.key, 'signed by the access key the tutor’s app handed over')
  say(`mcp: the tutor's AI wrote ${offerAddress}`)

  const found = await waitFor('the offer in the index’s search, through the mcp', INDEX_WAIT, async () => {
    const out = await student.ai!.call('search', { filters: { q: 'maths', market, role: tutorRole } })
    return (out.index.answer.results as Array<{ profile: string; post: { address: string } }> | undefined)?.find((r) => r.post.address === offerAddress)
  })
  const text = 'Is Tuesday at six free? A test message, sent through mcp by e2e.'
  assert.deepEqual(await student.ai!.call('message', { label: student.label, to: found.profile, body: { text } }), { sent: true, hosts: 1 })
  say('mcp: the student’s AI found the offer in the index’s search, and messaged the tutor')

  type Message = { from?: string; time: number; body: { text?: string }; counts: boolean; index?: { market?: string; role?: string; checks?: Array<{ key: string }> } }
  const asked = await waitFor('the index to show the student, beside its message', INDEX_WAIT, async () => {
    const m = ((await tutor.ai!.call('read', { label: tutor.label, inbox: true })).messages as Message[]).find((x) => x.body.text === text)
    return m?.index?.checks?.some((c) => c.key === s.verifier.keys.face) ? m : null
  })
  assert.equal(asked.from, student.address, 'from the student’s profile')
  assert.equal(asked.counts, true, 'whose profile entry lists the key that signed it with message')
  assert.deepEqual([asked.index!.market, asked.index!.role], [cfg.market, 'student'], 'the student’s market and role, as the index shows them')
  const replyText = 'Tuesday at six, yes. A test reply, sent through mcp by e2e.'
  await tutor.ai!.call('message', { label: tutor.label, to: asked.from, body: { text: replyText } })
  say('mcp: the tutor’s AI read it, with the student’s market, role and face check as the index shows them, and replied')
  const replied = ((await student.ai!.call('read', { label: student.label, inbox: true })).messages as Message[]).find((m) => m.body.text === replyText)
  assert.deepEqual([replied?.from, replied?.counts], [tutor.address, true], 'the student’s AI reads the tutor’s reply')
  steps.mcp = { offer: offerAddress, offerKey: tutor.key, found: found.profile, message: 'sent', inbox: { from: asked.from, counts: asked.counts, market: asked.index!.market, role: asked.index!.role }, reply: 'sent', replyRead: true }

  // 8. The payment, as the student's app makes it: to the pay address the tutor's profile entry
  // lists, signed by its pay key, a plain transfer from the student's own, through the fee payer at
  // cost. The AI pays nothing.
  const balance = async (owner: PublicKey) => BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount)
  const theirs = (await profileEntry(found.profile))!
  assert.ok(checkPay(theirs, found.profile).includes('solana'), 'its Solana pay address, signed by its pay key')
  const to = new PublicKey(String((theirs.pay as { solana: string }).solana))
  assert.ok(to.equals(tutorPay))
  const before = await balance(to)
  const paid: Paid = await throughFeePayer(connection, s.feePayer, student.payKey, directPaymentIxs({ from: studentPay, to, units: PRICE, token }), token)
  assert.equal(await balance(to), before + PRICE, 'the tutor got it')
  const evidence = `${chain}:${paid.signature}`
  steps.payment = { ...paid, to: to.toBase58(), evidence }
  say(`the payment: the student's app paid ${PRICE / DOLLAR} USDC to the tutor's pay address, ${paid.signature}, charged ${paid.charge} base units`)

  // 9. The review, written by the student's AI, naming the offer and that payment as evidence.
  const review = { subject: found.profile, score: '10', text: 'Clear and patient. A test review.', offer: offerAddress, evidence }
  assert.equal((await student.ai!.call('write', { label: student.label, path: 'review/maths', body: review })).written, 'review/maths')
  const reviewed = (await readFolder([s.host], student.address, Date.now())).current.get('review/maths')?.entry
  assert.deepEqual([reviewed?.body?.evidence, reviewed?.key], [evidence, student.key], 'on the host, naming the payment, signed by the student’s access key')
  steps.review = { id: 'maths', evidence, writtenBy: 'ai', key: student.key }
  say('the review: the student’s AI named the offer and the payment')

  // 10. The loop index counts it all. What each profile shows is what the index's own ranking makes
  // of this one review, with its own numbers: each profile's face check counted, the review a rating
  // backed by a payment and its writer's word about the tutor, a vouch; the student, whom no one
  // rated, a newcomer.
  const index = s.index
  const profilePage = (address: string) => json(`${index.url}/profiles/${address}.json`)
  const face = uniqueness([FACE_CONFIDENCE])
  const ranked = rank(
    [{ address: tutor.address, uniqueness: face }, { address: student.address, uniqueness: face }],
    [{ writer: student.address, subject: tutor.address, score: 10, evidence: SCORING.evidence.payment! }],
    [{ writer: student.address, subject: tutor.address, kind: 'rating', time: 0, address: `${student.address}/review/maths` }],
    SCORING,
  )
  const want = (address: string) => ({
    ratings: { value: tenth(ranked.ratings.get(address)!.value), count: ranked.ratings.get(address)!.count },
    trust: hundredth(ranked.trust.get(address)!),
    uniqueness: hundredth(face),
    pickiness: pickinessWord(ranked.pickiness.get(address)!, SCORING),
  })
  type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number; pickiness: string; statement: string; signature: string }
  const shownOf = (v: Shown) => ({ ratings: v.ratings, trust: v.trust, uniqueness: v.uniqueness, pickiness: v.pickiness })
  const describe = (w: ReturnType<typeof shownOf>) => `rated ${w.ratings.value} by ${w.ratings.count}, trust ${w.trust}, uniqueness ${w.uniqueness}, pickiness ${w.pickiness}`
  say(`the index: waiting for both profiles, the offer, the review with its payment, the tutor ${describe(want(tutor.address))}, the student ${describe(want(student.address))}`)
  const shown = await waitFor('the index to show it all', INDEX_WAIT, async () => {
    const [t, st] = await Promise.all([profilePage(tutor.address), profilePage(student.address)])
    if (t.status !== 200 || st.status !== 200) return null
    for (const [v, w] of [[t.body, want(tutor.address)], [st.body, want(student.address)]] as const) {
      if (!v.checks.some((c: { key: string }) => c.key === s.verifier.keys.face)) return null
      if (JSON.stringify(shownOf(v)) !== JSON.stringify(w)) return null
    }
    const got = t.body.reviews.received.find((r: { address: string }) => r.address === `${student.address}/review/maths`)
    if (!got?.counted || got.evidence !== 'with') return null
    if (!t.body.posts.some((p: { address: string; listed: boolean }) => p.address === offerAddress && p.listed)) return null
    return { tutor: t.body as Shown, student: st.body as Shown, review: got as { evidence: string } }
  })
  for (const v of [shown.tutor, shown.student]) {
    const signature = unpackSignature(b64u.decode(v.signature))
    assert.ok(signature && checkBytes(index.address, new TextEncoder().encode(v.statement), signature), 'what each profile shows, signed by the index')
  }
  assert.equal(JSON.stringify(shown).includes(text) || JSON.stringify(shown).includes(replyText), false, 'no message is anywhere in the index')
  const rated = (v: Shown, address: string) => ({ url: `${index.url}/profiles/${address}`, rating: v.ratings.value, count: v.ratings.count, trust: v.trust, uniqueness: v.uniqueness, pickiness: v.pickiness, statement: v.statement })
  steps.index = { tutor: rated(shown.tutor, tutor.address), student: rated(shown.student, student.address), review: { evidence: shown.review.evidence } }
  say(`the index counts it all: the tutor ${describe(shownOf(shown.tutor))}, the student ${describe(shownOf(shown.student))}, signed; the review with its payment`)

  // 11. The trust carried to the coach profile, proven on the device. The tutor's leaf holds its
  // trust, by its profile: the index's tree, as its README says.
  const tree = await waitFor('the tutor’s leaf in the index’s tree', INDEX_WAIT, async () => {
    const [t, l] = await Promise.all([json(`${index.url}/v1/reputation`), json(`${index.url}/v1/reputation/leaves`)])
    if (t.status !== 200 || l.status !== 200 || t.body.root !== l.body.root) return null
    const mine = l.body.leaves.find((x: { profile: string }) => x.profile === tutor.address)
    return mine?.score === shown.tutor.trust ? { served: t.body as { index: string; root: string; time: number; signature: string }, leaves: l.body.leaves as { profile: string; score: number }[] } : null
  })
  const leaves = tree.leaves.map((l) => ({ profile: pointOf(l.profile), score: BigInt(l.score) }))
  const root = buildTree(leaves).root
  const rootSignature = b64u.decode(tree.served.signature)
  assert.equal(hex.encode(toBytes32(root)), tree.served.root, 'the leaves served make the root served')
  assert.ok(checkBytes(index.address, signedBytes(root, tree.served.time), unpackSignature(rootSignature)!), 'signed by the index')
  const carried = await proveReputation({ seedScalar: tutor.scalar, labels: [tutor.label], leaves, profileLabel: COACH, artifacts: REPUTATION_FILES })
  assert.equal(carried.address, coach.address, 'proven onto the coach profile')
  assert.equal(Number(carried.score), shown.tutor.trust, 'carrying the tutor’s trust')
  assert.ok(await checkReputation({ proof: carried.proof, root, score: carried.score, profile: coach.address, index: index.address, time: tree.served.time, signature: rootSignature }), 'it checks')
  const reputation = { circuit: 'reputation', index: tree.served.index, root: tree.served.root, time: tree.served.time, signature: tree.served.signature, score: Number(carried.score), proof: b64u.encode(reputationBytes(carried.proof)) }
  await spend(tutor, coach.address, 3)
  await profile(tutor, COACH, [reputation])
  say(`tutor: its trust, ${carried.score}, proven onto ${coach.address}`)
  const proofShown = await waitFor('the index to show the proof on the coach profile', INDEX_WAIT, async () => {
    const v = await profilePage(coach.address)
    const x = v.status === 200 ? v.body.proofs?.find((p: { circuit: string }) => p.circuit === 'reputation') : null
    return x?.result === 'shown' && x.trust === shown.tutor.trust ? x : null
  })
  steps.reputation = { profile: coach.address, url: `${index.url}/profiles/${coach.address}`, root: tree.served.root, time: tree.served.time, leaves: leaves.length, score: Number(carried.score), result: proofShown.result }
  say('the index shows the carried trust on the coach profile')

  // 12. The tutor's app takes the access key out of the profile entry. The host refuses the AI's
  // next write, and the offer the key wrote counts for nothing: the newest entry that still counts
  // at its path is current, and there is none.
  await tutor.app!.removeKey(tutor.label, tutor.key!)
  assert.deepEqual(await tutor.app!.keys(tutor.label), [], 'no access key listed')
  const refused = await tutor.ai!.call('write', { label: tutor.label, path: 'offer/physics', body: { ...offer, description: 'Physics. A test offer after the key was removed.' } }).then(
    () => assert.fail('the host took a write by a removed key'),
    (err: Error) => err.message,
  )
  assert.match(refused, /no host took it: .*\(unlisted: /, 'refused by the host, as unlisted')
  assert.equal((await readFolder([s.host], tutor.address, Date.now())).current.get('offer/maths'), undefined, 'the offer it wrote counts for nothing')
  steps.removed = { key: tutor.key, refused, offer: 'gone' }
  say(`removed: the tutor's app took its AI's key out; the host refused its next write (${refused})`)

  // 13. A new device: the tutor's seed alone gives its Profiles folder, its two profiles and its stamp.
  const device = await App.find(tutor.seed, [s.host])
  assert.deepEqual(device.labels, [COACH, tutor.label].sort(), 'both its profiles')
  for (const label of device.labels) assert.ok(await profileEntry((await mainKey(tutor.seed, label)).address), `${label}'s folder, on the host`)
  assert.equal(device.stamps.length, 1)
  assert.equal(stampFromJson(JSON.parse(device.stamps[0]!)).signature.S, tutor.stamp!.signature.S, 'its stamp, the one signed')
  steps.device = { labels: device.labels, stamps: device.stamps.length }
  say(`a new device found ${device.labels.join(' and ')}, and the stamp, from the tutor's seed alone`)

  // 14. No answer either AI received holds one of its own person's addresses: each profile's, the
  // coach's included, each pay address, and the Profiles folder's. An AI acting for one person reads
  // the other's addresses, as it must to message and review them.
  const addresses: { [role: string]: unknown } = {}
  for (const [p, labels] of [[tutor, [tutor.label, COACH]], [student, [student.label]]] as const) {
    const own = (await addressesOf(p, [...labels])).map((a) => a.toLowerCase())
    const answers = p.ai!.answers.map((a) => a.toLowerCase())
    const held = own.filter((a) => answers.some((answer) => answer.includes(a)))
    assert.deepEqual(held, [], `an answer ${p.role}'s AI got holds one of ${p.role}'s own addresses`)
    addresses[p.role] = { answers: answers.length, addresses: own.length, held: held.length }
  }
  steps.addresses = addresses
  say(`no answer holds the person's own addresses: ${tutor.ai!.answers.length} answers to the tutor's AI, ${student.ai!.answers.length} to the student's`)

  // 15. Balances.
  const left = async (folder: string) => (await json(`${s.host}/credits/balance/${folder}`)).body.credits as number
  steps.balances = {
    tutor: await left(tutor.address),
    student: await left(student.address),
    coach: await left(coach.address),
    profilesFolders: { tutor: await left((await profilesKey(tutor.seed)).address), student: await left((await profilesKey(student.seed)).address) },
  }
}

try {
  await main()
  record.passed = true
} catch (err) {
  record.error = redact((err as Error).stack ?? String(err))
  console.error(record.error)
} finally {
  for (const p of people) await p.ai?.close().catch(() => {})
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
