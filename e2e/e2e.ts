// The loop: Forest end to end. Two people from two seeds, a tutor and a student, each the way their
// app would do it, against the services services.json names, or the loop's own copies of them on
// loopback (services.ts); the chain is remote, through RPC_URL, or services.json's rpc.
//
//   ../standard.sh && (cd ../standard/proofs/reputation/circuit && npm run fetch)
//   (cd ../host && npm ci) && (cd ../issuer && npm ci) && (cd ../index && npm ci) && (cd ../mcp && npm ci)
//   ../fee-payer/build.sh                    # Kora, for the loop's own fee payer
//   npm ci && FOREST_DEVNET_SEED='<the phrase>' [RPC_URL=<an RPC>] npm run e2e [-- <services.json>]
//
//    1. keys: a seed each, and from it the main key, the inbox key, the pay key, and the note number
//       at the loop issuer; the tutor's second profile, sports-coaching/coach, from the same seed;
//    2. funding: the phrase's deploy key makes each test-dollar account and sends SOL, and the test
//       dollar's authority mints: the student's pay address, each wallet app's address, and the loop's
//       own fee payer;
//    3. notes: the loop issuer's face check (its stand-in Didit passes it), a note for each;
//    4. credits: each wallet app buys 10 of the host's credits on Solana, a plain transfer naming the
//       buy's reference, collected once final and finished;
//    5. profiles: each app makes a write key and a read key for its assistant and lists them in
//       permissions; the host takes the hosts and permissions records free and refuses the profile
//       record unpaid; the app spends credits into the folder, and the host takes it: market, role,
//       pay address, inbox key, an inbox for holders of the loop issuer's note with the read key among
//       its readers, and a real note proof;
//    6. mcp, over its MCP door as a chat calls it, with the keys the apps made: the tutor's assistant
//       posts an offer; the student's sends the tutor a message, which the host takes after checking
//       the student's note proof; the tutor's opens it with the read key;
//    7. the deal, paid two ways, each through the fee payer at cost: a direct payment between the two
//       pay addresses, and an escrow on the market's session schedule, opened and paid in, then paid
//       out early by the student;
//    8. reviews, through mcp: the student's names the escrow, the tutor's the direct payment;
//    9. the loop index counts it all: both profiles under the face key, the offer, both reviews with
//       their payments, both ratings signed, the deal; no message anywhere;
//   10. the rating carried: the tutor's app finds its leaf among the index's, proves its rating on the
//       device onto its coach profile, and the index shows the proof;
//   11. balances: what each folder's credits came to.
// Everything it did goes to runs/<time>.json, whether it passed or not. What the loop started stops.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as escrow from '@foundationforest/escrow-client'
import { type AccessKey, type InboxKey, type MainKey, type ReadKey, accessKey, inboxKey, issuerScalarOf, issuerSecret, mainKey, newSeed, payKey, readKey, seedScalar, stampOf, unpackSignature, verifyBytes } from '@foundationforest/keys'
import { type SignedNote, noteFromJson, noteSigned, proofBytes as noteBytes, proveNote, toBytes32 } from '@foundationforest/note'
import { type Body, b64u, hex, hostsRecord, ownerRecord, permissionsRecord, publish, readProfile } from '@foundationforest/records'
import { buildTree, proofBytes as reputationBytes, proveReputation, signedBytes, verifyReputation } from '@foundationforest/reputation'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

import { DOLLAR, fundingFor, fundingIxs, keyFromPhrase, kora, payReferenceIxs, send, throughFeePayer } from './chain.ts'
import { type Credit, DIRECTORY_PATH, PAYMENT_HEADER, amountOf, buy, creditList, finish, serviceOf } from './credits/client.ts'
import { type RunRecord, checkRecord, holdsNone } from './record.ts'
import { ISSUER_NAME, type Running, readServices, startServices } from './services.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const servicesFile = process.argv[2] ? resolve(process.argv[2]) : join(here, 'services.json')
const cfg = readServices(servicesFile)
const rpcUrl = process.env.RPC_URL || cfg.rpc
const NOTE_FILES = { wasm: join(repo, 'standard/proofs/note/circuit/setup/note.wasm'), zkey: join(repo, 'standard/proofs/note/circuit/setup/note.zkey') }
const REPUTATION_FILES = { wasm: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.wasm'), zkey: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.zkey') }
/** The tutor's second profile, where it carries its rating: another market, from the same seed. */
const COACH = 'sports-coaching/coach'
/** How many of the host's credits each person buys: about a dollar of writes a hundred times over. */
const CREDITS = 10
/** What the tutor's offer asks an hour, and what each payment of the deal is. */
const PRICE = 2n * DOLLAR
/** How long to wait for the index to show what was done. */
const INDEX_WAIT = 15 * 60_000

/** What must never reach the record or the log: the phrase, the RPC's URL when RPC_URL gave it, and each key and credit the run makes. */
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
  services: { host: where(cfg.host), issuer: where(cfg.issuer), feePayer: where(cfg.feePayer), index: where(cfg.index), mcp: where(cfg.mcp) },
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

/** Decimal text in whole units, in base units of `decimals`. */
const unitsOf = (amount: string, decimals: number): bigint => {
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole! + fraction.padEnd(decimals, '0'))
}

// ---- A person, as their app holds them ----

type Person = {
  role: 'tutor' | 'student'
  label: string
  /** The seed, which the app keeps behind its unlock; here, in memory for the run. */
  seed: Uint8Array
  scalar: bigint
  main: MainKey
  inbox: InboxKey
  /** The pay key, a Solana key: the profile's pay address. */
  pay: Keypair
  noteNumber: bigint
  /** An address of its own apart from its profiles, as a wallet app holds one: what buys credits. */
  wallet: Keypair
  note?: SignedNote
  credits: Credit[]
  write?: AccessKey
  read?: ReadKey
}

async function person(role: Person['role']): Promise<Person> {
  const seed = newSeed()
  const label = `${cfg.market}/${role}`
  const main = await mainKey(seed, label)
  const pay = Keypair.fromSeed((await payKey(seed, label)).privateKey)
  const wallet = Keypair.generate()
  secrets.push(b64u.encode(seed), hex.encode(seed), b64u.encode(pay.secretKey.subarray(0, 32)), b64u.encode(wallet.secretKey.subarray(0, 32)))
  return { role, label, seed, scalar: await seedScalar(seed), main, inbox: await inboxKey(main.secret), pay, noteNumber: (await issuerSecret(seed, ISSUER_NAME)).noteNumber, wallet, credits: [] }
}

// ---- The steps ----

let services: Running | undefined
let mcp: Client | undefined

/** One of mcp's tools, through its MCP door, as a chat calls it: its answer, or its refusal, in its words. */
class Refused extends Error {}
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = (await mcp!.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> }
  const text = r.content[0]?.text ?? ''
  if (r.isError) throw new Refused(`${name}: ${text}`)
  return JSON.parse(text)
}

/** A tool whose host could not read the sender's records yet, which is the sender's to try again. */
const tried = (name: string, args: Record<string, unknown>, what: string) =>
  waitFor(what, 60_000, async () => {
    try {
      return await tool(name, args)
    } catch (err) {
      if (err instanceof Refused && err.message.includes('lookup')) return null
      throw err
    }
  })

/** The face check, as the app does it: a session, the check (the stand-in passes it), the note number sent, and a note back, checked. */
async function faceNote(p: Person) {
  const issuer = services!.issuer
  const session = await post(`${issuer.url}/face/session`, {})
  assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
  const got = await post(`${issuer.url}/face/note`, { sessionId: session.body.sessionId, noteNumber: p.noteNumber.toString() })
  assert.equal(got.status, 200, `a note: ${JSON.stringify(got.body)}`)
  const note = noteFromJson(got.body.note)
  assert.ok(noteSigned(note), 'the issuer signed it')
  assert.equal(note.issuer, issuer.keys.face, 'with its face key, which the loop index lists')
  assert.equal(note.noteNumber, p.noteNumber, 'for this person’s note number')
  p.note = note
  say(`${p.role}: a note from the loop issuer's face check`)
  return { issuer: note.issuer, model: String(got.body.note.model) }
}

/**
 * Credits bought on Solana, as a wallet app pays a buy: the host's directory read, a buy made, a
 * plain transfer from the wallet naming the buy's reference, the buy collected once the host finds
 * the payment final, and the credits finished.
 */
async function buyCredits(p: Person, token: escrow.Token, connection: Connection) {
  const host = services!.host
  const directory = await json(`${host}${DIRECTORY_PATH}`)
  assert.equal(directory.status, 200, `${host} publishes its credits`)
  const service = serviceOf(host, directory.body)
  if (!service.address || !service.mint) throw new Error(`${host} sells its credits only for its sponsors' tickets, and the loop pays in a dollar`)
  assert.equal(service.mint, token.mint.toBase58(), `${host} is paid in the test dollar`)
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

/** A note proof for `label`, made on the device from the person's note, as a profile record carries it. */
async function noteProof(p: Person, label: string) {
  const r = await proveNote({ seedScalar: p.scalar, issuerName: ISSUER_NAME, note: p.note!, label, artifacts: NOTE_FILES })
  return { circuit: 'note', issuer: r.issuer, issuerName: ISSUER_NAME, label, stamp: hex.encode(toBytes32(r.stamp)), proof: b64u.encode(noteBytes(r.proof)) }
}

/** Each record's answer from the one host, in the order sent: ok, or its error. */
async function published(records: ReturnType<typeof ownerRecord>[]): Promise<string[]> {
  const [out] = await publish([services!.host], records)
  return [...out!.results].sort((a, b) => a.i - b.i).map((r) => (r.ok ? 'ok' : (r.error ?? 'refused')))
}

/**
 * A profile, as its app sets it up: the access keys it makes for its assistant, listed in the
 * permissions record; the hosts and permissions records, which the host takes free; the profile
 * record, refused while the folder holds no credits, then taken once `n` credits are spent into it.
 */
async function setUp(p: Person, n: number) {
  p.write = accessKey(new Uint8Array(randomBytes(32)))
  p.read = await readKey(new Uint8Array(randomBytes(32)))
  secrets.push(b64u.encode(p.write.secret), b64u.encode(p.read.secret), p.read.identity, p.inbox.identity)
  const proof = await noteProof(p, p.label)
  const [market, role] = p.label.split('/')
  const body = {
    market,
    role,
    pay: p.pay.publicKey.toBase58(),
    inboxKey: p.inbox.sealTo,
    inbox: { senders: { issuer: services!.issuer.keys.face }, readers: [p.read.sealTo] },
    proofs: [proof],
  } as unknown as Body
  const access = [
    { key: p.write.address, scope: 'write' as const, paths: ['offer', 'review', 'inbox'] },
    { key: p.read.address, sealTo: p.read.sealTo, scope: 'read' as const, paths: ['inbox'] },
  ]
  const now = Date.now()
  const host = services!.host
  assert.deepEqual(
    await published([hostsRecord(p.main, [host], now), permissionsRecord(p.main, access, now), ownerRecord(p.main, 'profile', body, now)]),
    ['ok', 'ok', 'refused'],
    'the hosts and permissions records free, the profile record refused unpaid',
  )
  const spent = await spend(p, p.main.address, n)
  assert.deepEqual(await published([ownerRecord(p.main, 'profile', body, now)]), ['ok'], 'the profile record, paid')
  say(`${p.role}: its profile on the host, ${p.main.address}, with a note proof and its assistant's two keys listed`)
  return { unpaid: 'refused', spent, stamp: proof.stamp, writeKey: p.write.address, readKey: p.read.address }
}

async function main() {
  const phrase = process.env.FOREST_DEVNET_SEED
  if (!phrase) throw new Error('FOREST_DEVNET_SEED is not set: the phrase’s keys fund and mint for the run')
  const connection = new Connection(rpcUrl, 'confirmed')
  const deploy = keyFromPhrase(phrase, 'deploy')
  const authority = keyFromPhrase(phrase, 'test-dollar-authority')
  const mint = new PublicKey(cfg.testDollar)
  const ESCROW = new PublicKey(cfg.escrow)
  const token = escrow.tokenOf(mint, (await connection.getAccountInfo(mint))!)
  const ata = (owner: PublicKey) => escrow.associatedTokenAddress(owner, token.mint, token.program)

  say('the services: the loop’s own issuer and index, and the rest as services.json names them or our own')
  services = await startServices(cfg, { rpcUrl, payTo: deploy.publicKey.toBase58(), say, redact })
  const s = services
  record.loop = { issuer: { name: s.issuer.name, face: s.issuer.keys.face, id: s.issuer.keys.id }, index: s.index.address }
  say(`issuer ${s.issuer.url}, host ${s.host}, fee payer ${s.feePayer}, index ${s.index.url} (${s.index.address}), mcp ${s.mcp}`)

  // 1. Keys.
  const tutor = await person('tutor')
  const student = await person('student')
  const coach = { main: await mainKey(tutor.seed, COACH), pay: (await payKey(tutor.seed, COACH)).address }
  steps.keys = {
    tutor: { label: tutor.label, profile: tutor.main.address, pay: tutor.pay.publicKey.toBase58() },
    student: { label: student.label, profile: student.main.address, pay: student.pay.publicKey.toBase58() },
    coach: { label: COACH, profile: coach.main.address, pay: coach.pay },
  }
  say(`two people, each from a seed: tutor ${tutor.main.address}, student ${student.main.address}`)

  // 2. Funding.
  const ownFeePayer = s.ownFeePayer ? new PublicKey(s.ownFeePayer) : null
  const funding = fundingIxs(fundingFor({ tutorPay: tutor.pay.publicKey, studentPay: student.pay.publicKey, wallets: [tutor.wallet.publicKey, student.wallet.publicKey], feePayer: ownFeePayer }), { payer: deploy.publicKey, authority: authority.publicKey }, token)
  const accounts = await send(connection, funding.accounts, [deploy])
  const money = await send(connection, funding.money, [deploy, authority])
  steps.funding = { accounts: accounts.signature, money: money.signature, wallets: { tutor: tutor.wallet.publicKey.toBase58(), student: student.wallet.publicKey.toBase58() }, feePayer: s.ownFeePayer }
  say('funded: each test-dollar account, the student’s dollars, each wallet’s dollar and SOL, and our own fee payer’s SOL')

  // 3. Notes.
  steps.notes = { tutor: await faceNote(tutor), student: await faceNote(student) }

  // 4. Credits.
  steps.credits = { tutor: await buyCredits(tutor, token, connection), student: await buyCredits(student, token, connection) }

  // 5. Profiles. The tutor keeps four credits for its coach profile.
  steps.profiles = { tutor: await setUp(tutor, CREDITS - 4), student: await setUp(student, CREDITS) }

  // 6. mcp, as a chat calls it, with the keys each app made.
  mcp = new Client({ name: 'forest-e2e', version: '0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(s.mcp)))
  const asTutor = { profile: tutor.main.address, writeKey: b64u.encode(tutor.write!.secret) }
  const asStudent = { profile: student.main.address, writeKey: b64u.encode(student.write!.secret) }
  const offer = {
    description: 'Maths for secondary school, one hour online. A test offer, posted by an assistant through mcp by e2e.',
    price: { amount: (PRICE / DOLLAR).toString(), currency: 'USD', per: 'hour' },
    payment: ['direct', 'session'],
    subjects: ['maths'],
    levels: ['secondary'],
    place: { online: true },
  }
  const posted = await tool('post', { action: 'post', id: 'maths', body: offer, ...asTutor })
  const offerBy = (await readProfile([s.host], tutor.main.address, Date.now())).current.get('offer/maths')?.record.by
  assert.equal(offerBy, tutor.write!.address, 'the offer is signed by the write key, not the main key')
  const text = 'Is Tuesday at six free? A test message, sent through mcp by e2e.'
  const sent = await tried('send', { to: tutor.main.address, body: { text }, ...asStudent }, 'the tutor’s host to take the message')
  const box = await tool('inbox', { profile: tutor.main.address, readKey: b64u.encode(tutor.read!.secret) })
  const got = box.messages.find((m: { id: string }) => m.id === sent.id)
  assert.deepEqual([got?.from, got?.key, got?.body], [student.main.address, student.write!.address, { text }], 'from the student, by its write key, opened with the read key')
  steps.mcp = { offer: posted.address, offerBy, message: { id: sent.id, from: student.main.address, hosts: sent.hosts, copy: sent.copy?.hosts ?? sent.copy }, opened: true }
  say(`mcp: the tutor's assistant posted ${posted.address}; the student's sent a message, which the tutor's opened`)

  // 7. The deal, paid two ways, each through the fee payer at cost.
  const tutorPay = tutor.pay.publicKey
  const studentPay = student.pay.publicKey
  const balance = async (owner: PublicKey) => BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount)
  const before = await balance(tutorPay)
  const payment = await throughFeePayer(connection, s.feePayer, student.pay, [escrow.transferIx({ from: ata(studentPay), to: ata(tutorPay), owner: studentPay, mint, amount: PRICE, decimals: token.decimals, tokenProgram: token.program })], token)
  assert.equal(await balance(tutorPay), before + PRICE, 'the tutor got the direct payment')
  say(`deal: a direct payment, ${payment.signature}, charged ${payment.charge} base units`)

  const sponsor = new PublicKey((await kora<{ signer_address: string }>(s.feePayer, 'getPayerSigner')).signer_address)
  // The market's session schedule: the student may take nothing back, and it is paid seven days after payment unless stopped.
  const until = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  const terms = escrow.termsFor({ schedule: { windows: [{ until, payerShare: 0 }], end: 'pay' } }, { recipient: tutorPay, amount: PRICE })
  const keys = escrow.keysFor({ payer: studentPay, sponsor, mint, terms, tokenProgram: token.program, programId: ESCROW })
  const read = async () => escrow.decodeEscrow(new Uint8Array((await connection.getAccountInfo(keys.escrow))!.data))
  const opened = await throughFeePayer(connection, s.feePayer, student.pay, escrow.createAndFund({ payer: studentPay, sponsor, token, terms, programId: ESCROW }), token)
  const open = await read()
  assert.equal(open.status, 'funded', 'opened, paid into and marked')
  assert.deepEqual(open.schedule, terms.schedule, 'on the session schedule')
  const early = await throughFeePayer(connection, s.feePayer, student.pay, [escrow.payIx({ keys, programId: ESCROW })], token)
  const ended = await read()
  assert.deepEqual([ended.status, ended.outcome, ended.toRecipient], ['ended', 'pay', PRICE], 'paid out to the tutor, early')
  assert.ok(ended.payer.equals(studentPay) && ended.recipient.equals(tutorPay), 'between the two pay addresses')
  assert.ok(ended.sponsor.equals(sponsor), 'its rent back to the fee payer, which fronted it')
  assert.ok(escrow.escrowAddress(escrow.termsOf(ended), ESCROW).equals(keys.escrow), 'its address is its terms’')
  steps.deal = { payment, escrow: { address: keys.escrow.toBase58(), open: opened, pay: early, outcome: ended.outcome, sponsor: sponsor.toBase58(), schedule: { until, payerShare: 0, end: 'pay' } } }
  say(`deal: an escrow on the session schedule, ${keys.escrow.toBase58()}, opened and paid in, then paid out early`)

  // 8. Reviews, through mcp, each naming its evidence.
  const byStudent = await tool('review', { action: 'post', body: { subject: tutor.main.address, score: '10', text: 'Clear and patient. A test review.', offer: posted.address, evidence: keys.escrow.toBase58() }, ...asStudent })
  const byTutor = await tool('review', { action: 'post', body: { subject: student.main.address, score: '9', text: 'On time, paid at once. A test review.', evidence: payment.signature }, ...asTutor })
  steps.reviews = { student: { address: byStudent.address, evidence: keys.escrow.toBase58() }, tutor: { address: byTutor.address, evidence: payment.signature } }
  say('two reviews through mcp: the student’s names the escrow, the tutor’s the direct payment')

  // 9. The loop index counts it all.
  const index = s.index
  const page = (address: string) => json(`${index.url}/profiles/${address}.json`)
  say('the index: waiting for both profiles, the offer, both reviews with their payments, both ratings and the deal')
  const shown = await waitFor('the index to show it all', INDEX_WAIT, async () => {
    const [t, st] = await Promise.all([page(tutor.main.address), page(student.main.address)])
    if (t.status !== 200 || st.status !== 200) return null
    for (const [v, rating] of [[t.body, 10], [st.body, 9]] as const) {
      if (!v.checks.some((c: { key: string }) => c.key === s.issuer.keys.face)) return null
      if (v.rating.value !== rating || v.rating.withPayment !== 1 || v.rating.reviews !== 1) return null
      if (!v.reviews.received.every((r: { counted: boolean; evidence: string }) => r.counted && r.evidence === 'with')) return null
    }
    if (!t.body.posts.some((p: { address: string; listed: boolean }) => p.address === posted.address && p.listed)) return null
    const d = await json(`${index.url}/deals/${keys.escrow.toBase58()}.json`)
    if (d.status !== 200 || d.body.receipt?.outcome !== 'pay' || d.body.reviews.length !== 1 || !d.body.reviews[0].counted) return null
    return { tutor: t.body, student: st.body, deal: d.body }
  })
  for (const v of [shown.tutor, shown.student]) {
    const signature = unpackSignature(b64u.decode(v.rating.signature))
    assert.ok(signature && verifyBytes(index.address, new TextEncoder().encode(v.rating.statement), signature), 'each rating signed by the index')
  }
  assert.equal(JSON.stringify(shown).includes(text), false, 'no message is anywhere in the index')
  steps.index = {
    tutor: { url: `${index.url}/profiles/${tutor.main.address}`, rating: shown.tutor.rating.value, reviews: shown.tutor.rating.reviews, withPayment: shown.tutor.rating.withPayment, statement: shown.tutor.rating.statement },
    student: { url: `${index.url}/profiles/${student.main.address}`, rating: shown.student.rating.value, reviews: shown.student.rating.reviews, withPayment: shown.student.rating.withPayment, statement: shown.student.rating.statement },
    deal: { url: `${index.url}/deals/${keys.escrow.toBase58()}`, outcome: shown.deal.receipt.outcome, amount: shown.deal.receipt.amount, reviews: shown.deal.reviews.length },
  }
  say('the index counts it all: ratings 10 and 9, each with a payment, signed; the deal paid')

  // 10. The rating carried to the coach profile, proven on the device.
  const stamp = hex.encode(toBytes32(stampOf(issuerScalarOf(tutor.scalar, ISSUER_NAME), tutor.label)))
  const tree = await waitFor('the tutor’s leaf in the index’s tree', INDEX_WAIT, async () => {
    const [t, l] = await Promise.all([json(`${index.url}/v1/reputation`), json(`${index.url}/v1/reputation/leaves`)])
    if (t.status !== 200 || l.status !== 200 || t.body.root !== l.body.root) return null
    const mine = l.body.leaves.find((x: { stamp: string }) => x.stamp === stamp)
    return mine?.score === 100 && mine.count === 1 ? { served: t.body as { index: string; root: string; time: number; signature: string }, leaves: l.body.leaves as { stamp: string; scope: string; score: number; count: number }[] } : null
  })
  const leaves = tree.leaves.map((l) => ({ stamp: BigInt(`0x${l.stamp}`), scope: BigInt(`0x${l.scope}`), score: BigInt(l.score), count: BigInt(l.count) }))
  const root = buildTree(leaves).root
  const rootSignature = b64u.decode(tree.served.signature)
  assert.equal(hex.encode(toBytes32(root)), tree.served.root, 'the leaves served make the root served')
  assert.ok(verifyBytes(index.address, signedBytes(root, tree.served.time), unpackSignature(rootSignature)!), 'signed by the index')
  const carried = await proveReputation({ seedScalar: tutor.scalar, sources: [{ label: tutor.label, issuerName: ISSUER_NAME }], leaves, profileLabel: COACH, artifacts: REPUTATION_FILES })
  assert.equal(carried.address, coach.main.address, 'proven onto the coach profile')
  assert.ok(await verifyReputation({ proof: carried.proof, root, score: carried.score, profile: coach.main.address, index: index.address, time: tree.served.time, signature: rootSignature }), 'it checks')
  const reputation = { circuit: 'reputation', index: tree.served.index, root: tree.served.root, time: tree.served.time, signature: tree.served.signature, score: Number(carried.score), proof: b64u.encode(reputationBytes(carried.proof)) }
  const coachBody = { market: 'sports-coaching', role: 'coach', pay: coach.pay, proofs: [await noteProof(tutor, COACH), reputation] } as unknown as Body
  const now = Date.now()
  assert.deepEqual(await published([hostsRecord(coach.main, [s.host], now)]), ['ok'])
  await spend(tutor, coach.main.address, 4)
  assert.deepEqual(await published([ownerRecord(coach.main, 'profile', coachBody, now)]), ['ok'], 'the coach profile, with both proofs')
  say(`tutor: its rating, ${carried.score} tenths, proven onto ${coach.main.address}`)
  const proofShown = await waitFor('the index to show the proof on the coach profile', INDEX_WAIT, async () => {
    const v = await page(coach.main.address)
    const x = v.status === 200 ? v.body.proofs?.find((p: { circuit: string }) => p.circuit === 'reputation') : null
    return x?.result === 'shown' && x.rating === 10 ? x : null
  })
  steps.reputation = { profile: coach.main.address, url: `${index.url}/profiles/${coach.main.address}`, stamp, root: tree.served.root, time: tree.served.time, leaves: leaves.length, score: Number(carried.score), result: proofShown.result }
  say('the index shows the carried rating on the coach profile')

  // 11. Balances.
  const left = async (folder: string) => (await json(`${s.host}/credits/balance/${folder}`)).body.credits as number
  steps.balances = { tutor: await left(tutor.main.address), student: await left(student.main.address), coach: await left(coach.main.address) }
}

try {
  await main()
  record.passed = true
} catch (err) {
  record.error = redact((err as Error).stack ?? String(err))
  console.error(record.error)
} finally {
  await mcp?.close().catch(() => {})
  await services?.stop().catch((err) => console.error(redact(String(err))))
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
