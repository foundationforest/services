// The loop: Forest end to end. Two people from two seeds, a tutor who sells and a student who buys.
// Each one's device is the reference app (mcp/test/app.ts), unchanged: it holds the seed and the
// stamp, keeps the Profiles folder, makes each profile with its verification, and at the connect
// page makes the AI's connection folder, with an access key for the profile ticked, and hands the
// mcp the pointer to it. What it has no method for, the device does here with the standard's
// pieces: the stamp and its gift asked for, the credits, the reputation proof. Each
// person's AI is the MCP SDK's own client (mcp/test/setup.ts), logging in through the loop's connect
// page and calling the mcp's tools, which read the connection and act in the person's folder with
// that access key. Against the loop's own verifier, host, index and mcp, on loopback (services.ts),
// with no chain and no secret.
//
//   ../standard.sh
//   (cd ../verifier && npm ci) && (cd ../host && npm ci) && (cd ../index && npm ci) && (cd ../mcp && npm ci)
//   npm ci && npm run e2e                      # the loop
//   npm run e2e -- <deployed.json>             # the deployed check: each service it names answers
//
//    1. keys: a seed each, and from it the profile's address and pay { solana, evm }, and the stamp
//       number at the loop verifier (keys/'s stampNumberOf); the tutor's second profile,
//       sports-coaching/coach;
//    2. stamps: the loop verifier's face check (its stand-in Didit passes it), asked with the
//       face stamp's gift, one buy at the host; a stamp for each, kept on the person's device, then
//       asked back from the verifier by its stamp number;
//    3. credits: each buy collected at the host with the gift's ticket, finished, and spent into the
//       wallet, the Profiles folder's balance;
//    4. profiles: the stamp kept in the Profiles folder, the profile's folder funded from the wallet
//       (a buy paid from its balance, its credits spent into the folder), and the profile, its
//       profile entry with a verification made on the device, listed there too;
//    5. logins: each AI logs in through the connect page, where the person ticks their profile and
//       their app makes the connection folder, funded from the wallet with one credit, lists an
//       access key in the profile entry with every switch, writes its note and its access entry, and
//       hands the mcp the pointer;
//    6. mcp: the tutor's AI writes a post, paid from the profile's balance; the student's finds it
//       through the index's search and messages the tutor, carrying one credit bought from the
//       student's balance, most of which lands in the tutor's; the tutor's reads the inbox, the
//       student's market, role and checks as the index shows them, and replies the same way; the
//       student's reads the reply;
//    7. the review: the student's AI reviews the tutor, naming the post;
//    8. the loop index counts it all: both profiles, the post, the review, and what each profile
//       shows (ratings, trust, uniqueness) as its own ranking makes them, signed; no message
//       anywhere;
//    9. the trust carried: the tutor's device finds its leaf by its profile, proves its trust onto
//       its coach profile, and the index shows the proof;
//   10. added: the tutor's app, from the seed alone, adds the coach profile to its AI's connection;
//       with no new login, the AI acts as both, and writes a locked note as the coach;
//   11. ended: the tutor's app ends the connection, its entry and both keys gone; the mcp refuses
//       the AI's next call, 401, and what the keys wrote counts for nothing;
//   12. a new device: from the tutor's seed alone, the Profiles folder gives its two profiles and its
//       stamp;
//   13. addresses: no answer either AI received holds one of its own person's addresses;
//   14. balances: what each folder's credits came to.
// Then, passed or failed, what the loop started stops, and the run exits 0 or 1. What it did is in
// what it prints.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { type Body, b64u, encodeEntry, encodeInbox, hex, proofsOf, readFolder, readInbox, verificationCheck } from '@foundationforest/folders'
import { lockCount, openLocked } from '@foundationforest/folders/locked'
import { type PayAddresses, accessKey, checkBytes, mainKey, newSeed, openingHalf, payAddresses, pointOf, seedNumber, stampNumberOf, unpackSignature } from '@foundationforest/keys'
import {
  type SignedStamp,
  buildTree,
  checkReputation,
  checkVerification,
  proofBytes as reputationBytes,
  proveReputation,
  signedBytes,
  stampFromJson,
  stampSigned,
  toBytes32,
} from '@foundationforest/proofs'

import { BUY_TYPE, DIRECTORY_PATH, PAYMENT_HEADER, type Pending, buy, finish, serviceOf, spendInto } from '../host/client/client.ts'
import { hundredth, tenth } from '../index/src/pass.ts'
import { type Numbers, rank, uniqueness } from '../index/src/rank.ts'
import { App } from '../mcp/test/app.ts'
import { aiApp, logIn } from '../mcp/test/setup.ts'
import { FACE_CONFIDENCE, type Running, VERIFIER_NAME, checkDeployed, named, readServices, startServices } from './services.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const servicesFile = process.argv[2] ? resolve(process.argv[2]) : join(here, 'services.json')
const cfg = readServices(servicesFile)
const REPUTATION_FILES = { wasm: join(repo, 'standard/proofs/reputation/setup/reputation.wasm'), zkey: join(repo, 'standard/proofs/reputation/setup/reputation.zkey') }
/** The tutor's second profile, where it carries its trust: another market, from the same seed. */
const COACH = 'sports-coaching/coach'
/** How many of the host's credits the loop verifier's face stamp gives each person: its own default. */
const CREDITS = 10
/** And its ID stamp, which no one in the loop takes: its own default. */
const ID_CREDITS = 100
/** What each person's app funds each profile with from the wallet, and the coach profile. */
const PROFILE_CREDITS = 3
const COACH_CREDITS = 2
/** A credit, in millionths: the unit a balance is kept in. */
const CREDIT = 1_000_000
/** What the person's app lets each AI do in the profile ticked, unless the person chooses fewer: every switch. */
const SWITCHES = ['read-inbox', 'read', 'write', 'message']
/** How long to wait for the index to show what was done: it reads every 5 seconds. */
const INDEX_WAIT = 2 * 60_000
/** The numbers the loop index ranks by: its own, from index/config. */
const SCORING = JSON.parse(readFileSync(join(repo, 'index/config/scoring.json'), 'utf8')) as Numbers

const started = Date.now()
const say = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(what: string, ms: number, get: () => Promise<T | null | undefined | false>, every = 2000): Promise<T> {
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

  /** The access token its login got: for the loop to ask the mcp with it directly. */
  token = () => this.c.app.tokens()!.access_token

  close = () => this.c.client.close()
}

/**
 * The connect page: a stand-in for the Forest app's, where the person whose turn it is ticks the
 * profiles their AI acts in, and their app makes the connection and hands back its pointer. One mcp
 * sends every login to one page, and the two people log in one after the other.
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
  /** The profile's address, and its pay addresses. */
  address: string
  pay: PayAddresses
  stampNumber: bigint
  stamp?: SignedStamp
  /** The buy the face stamp's gift pays for, its bytes and what finishes it, and the gift's ticket. */
  gift?: { buy: Uint8Array; pending: Pending; ticket: string }
  app?: App
  ai?: AI
  /** The address of the access key the person's app handed the mcp for the profile. */
  key?: string
  /** The address of their AI's connection folder. */
  connection?: string
}

async function person(role: Person['role']): Promise<Person> {
  const seed = newSeed()
  const label = `${cfg.market}/${role}`
  return {
    role,
    label,
    seed,
    address: (await mainKey(seed, label)).address,
    pay: await payAddresses(seed, label),
    stampNumber: stampNumberOf(seedNumber(seed), VERIFIER_NAME),
  }
}

/** Every address of one person's: each profile's, and its pay addresses, the Profiles folder's, and their AI's connection folder's. What no answer to their AI holds. */
async function addressesOf(p: Person, labels: string[]): Promise<string[]> {
  const out = [(await mainKey(p.seed, '')).address, p.connection!]
  for (const label of labels) out.push((await mainKey(p.seed, label)).address, ...Object.values(await payAddresses(p.seed, label)))
  return out
}

// ---- The steps ----

let services: Running | undefined
let page: Awaited<ReturnType<typeof connectPage>> | undefined
const people: Person[] = []

/**
 * The face check, as the app does it, asked with its gift: the gift read in the verifier's
 * `GET /`, one buy at its host of exactly its credits, a session, the check (the stand-in passes
 * it), the stamp number and the buy's reference sent, and a stamp and a ticket back, checked. The
 * app keeps the stamp on the device, as safely as a key, and the buy to finish later.
 */
async function faceStamp(p: Person) {
  const verifier = services!.verifier
  const about = await json(`${verifier.url}/`)
  assert.deepEqual(about.body.gift, { face: CREDITS, host: services!.host, id: ID_CREDITS, sponsor: verifier.sponsor }, 'the loop verifier gives ten of its host’s credits with a face stamp, and a hundred with an ID stamp')
  const directory = await json(`${services!.host}${DIRECTORY_PATH}`)
  assert.equal(directory.status, 200, `${services!.host} publishes its credits`)
  const b = await buy(serviceOf(services!.host, directory.body), CREDITS)
  const session = await post(`${verifier.url}/face/session`, {})
  assert.equal(session.status, 201, `a session: ${JSON.stringify(session.body)}`)
  const got = await post(`${verifier.url}/face/stamp`, { sessionId: session.body.sessionId, stampNumber: p.stampNumber.toString(), gift: b.reference })
  assert.equal(got.status, 200, `a stamp: ${JSON.stringify(got.body)}`)
  const stamp = stampFromJson(got.body.stamp)
  assert.ok(stampSigned(stamp), 'the verifier signed it')
  assert.equal(stamp.verifier, verifier.keys.face, 'with its face key, which the loop index lists')
  assert.equal(stamp.stampNumber, p.stampNumber, 'for this person’s stamp number')
  assert.equal(stamp.verifierName, VERIFIER_NAME, 'under the loop verifier’s name')
  assert.equal(typeof got.body.gift?.ticket, 'string', `the gift's ticket: ${JSON.stringify(got.body.gift)}`)
  assert.equal(got.body.gift.ticket.split('.')[0], verifier.sponsor, 'signed by the verifier’s sponsor key')
  p.stamp = stamp
  p.gift = { buy: b.buy, pending: b.pending, ticket: got.body.gift.ticket }
  // A device that lost its stamp asks for it again by its stamp number: the same stamp comes back.
  const back = await post(`${verifier.url}/stamp`, { stampNumber: p.stampNumber.toString() })
  assert.equal(back.status, 200, `the stamp asked back: ${JSON.stringify(back.body)}`)
  const own = (x: SignedStamp) => ({ stampNumber: x.stampNumber, facts: x.facts, verifier: x.verifier, verifierName: x.verifierName, signature: x.signature })
  assert.deepEqual(own(stampFromJson(back.body.face)), own(stamp), 'asked back by its stamp number, it is the one signed')
  say(`${p.role}: a stamp from the loop verifier's face check, model ${String(got.body.stamp.model)}, kept on the device, the same asked back by its stamp number, and the gift's ticket for ${CREDITS} credits, buy ${b.reference}`)
}

/** The gift's credits, as the app collects them: the buy sent to the host with its ticket, the credits finished, and spent into the wallet, the Profiles folder's balance. */
async function collectGift(p: Person) {
  const service = serviceOf(services!.host, (await json(`${services!.host}${DIRECTORY_PATH}`)).body)
  const res = await fetch(service.requestUri, { method: 'POST', headers: { 'content-type': BUY_TYPE, [PAYMENT_HEADER]: `ticket ${p.gift!.ticket}` }, body: p.gift!.buy as Uint8Array<ArrayBuffer> })
  assert.equal(res.status, 200, `${services!.host} takes the gift's ticket: ${await res.clone().text()}`)
  const credits = await finish(p.gift!.pending, new Uint8Array(await res.arrayBuffer()))
  assert.equal(credits.length, CREDITS)
  const wallet = (await mainKey(p.seed, '')).address
  assert.equal(await spendInto(services!.host, wallet, credits), CREDITS, 'all of them in the wallet')
  say(`${p.role}: ${CREDITS} credits collected with the gift's ticket, finished, and in the wallet, the Profiles folder ${wallet}'s balance`)
}

/** A folder's balance at the host, in millionths of a credit. */
async function held(folder: string): Promise<number> {
  return Math.round((await json(`${services!.host}/credits/balance/${folder}`)).body.credits * CREDIT)
}

/** What an entry or an inbox entry of `bytes` costs at the host, in millionths: a kilobyte at least, at the rate its directory gives for the disk. */
async function entryPrice(bytes: number): Promise<number> {
  const rate = Math.round(Number((await json(`${services!.host}${DIRECTORY_PATH}`)).body['forest-credit'].entry) * CREDIT)
  return Math.ceil((Math.max(bytes, 1000) * rate) / 1000)
}

/** The newest inbox entry left for `folder` at the host, as its bytes are kept. */
async function newestInbox(folder: string): Promise<number> {
  const page = await readInbox(services!.host, folder)
  return Buffer.byteLength(encodeInbox(page.entries.at(-1)!.entry))
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
  assert.ok(typeof shown.openKey === 'string', 'its open key, so it takes messages')
  const verification = proofsOf(shown).find((x) => x.circuit === 'verification')
  const check = verificationCheck(verification, address)
  assert.ok(check && (await checkVerification(check)), 'its verification checks')
  assert.equal(verification!.verifier, p.stamp!.verifier, 'from the stamp the device keeps')
  return address
}

/**
 * A person's AI logs in: its first call to act gets the challenge, the person's browser goes
 * through the connect page, where they tick their profile, and their app makes the connection
 * folder, funded from the wallet with one credit, lists an access key in the profile entry with every switch, writes
 * its note and its access entry, and hands the mcp the pointer; the code becomes a login. Read back
 * from the host: one access key listed; its note, at a random id, locked to the main key alone,
 * found by opening the folder's notes, holding the connection folder's key; and the connection
 * folder, found from the seed, its entries locked to two keys, with one access entry, for that key.
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
  p.ai = new AI(c)
  assert.deepEqual((await p.ai.call('my_profiles')).profiles, [{ label: p.label, can: SWITCHES }], 'it acts in this profile, by its label, with every switch')
  const keys = await p.app!.keys(p.label)
  assert.equal(keys.length, 1, 'one access key in the profile entry')
  assert.deepEqual(keys[0]!.can, SWITCHES)
  p.key = keys[0]!.key
  const main = await mainKey(p.seed, p.label)
  const note = await p.app!.note(p.label, p.key)
  assert.ok(note && lockCount(note.locked) === 1, 'its note, at key/<id>, locked to one key')
  const opened = await openLocked(note.locked, (await openingHalf(main.secret)).identity)
  assert.deepEqual([opened.key, opened.connector], [p.key, mcp], 'which the main key opens, naming the key and this mcp')
  const found = await p.app!.connections()
  assert.equal(found.length, 1, 'one connection, found from the seed')
  const conn = found[0]!
  assert.equal(opened.connection, b64u.encode(conn.key.secret), 'the note holds the connection folder’s key')
  assert.deepEqual(conn.view.current.get('profile')?.entry.body, { hosts: [services!.host] }, 'the connection folder’s profile entry holds only its hosts')
  assert.equal(lockCount(conn.view.current.get('connection')!.entry.body as { private: string }), 2, 'its connection entry locked to two keys: its own and the mcp’s')
  assert.equal(conn.access.length, 1, 'one access entry')
  assert.deepEqual([conn.access[0]!.body.label, (await accessKey(b64u.decode(conn.access[0]!.body.key as string))).address], [p.label, p.key], 'for this profile and this key')
  p.connection = conn.address
  say(`${p.role}: its AI logged in, and acts in ${p.label} with the access key ${p.key}: ${SWITCHES.join(', ')}, its note locked to the main key; its connection folder ${conn.address}, funded from the wallet with one credit`)
}

async function main() {
  say('the services: the loop’s own verifier, host, index and mcp, on loopback')
  page = await connectPage()
  services = await startServices({ appUrl: page.url, say })
  const s = services
  say(`verifier ${s.verifier.url} (${s.verifier.name}, face key ${s.verifier.keys.face}, ID key ${s.verifier.keys.id}, sponsor ${s.verifier.sponsor}), host ${s.host}, index ${s.index.url} (${s.index.address}), mcp ${s.mcp}`)

  // 1. Keys.
  const tutor = await person('tutor')
  const student = await person('student')
  people.push(tutor, student)
  const coach = { address: (await mainKey(tutor.seed, COACH)).address, pay: await payAddresses(tutor.seed, COACH) }
  say(`two people, each from a seed: tutor ${tutor.address}, student ${student.address}, and the tutor's coach profile ${coach.address}`)

  // 2. Stamps, each asked with its gift.
  for (const p of [tutor, student]) await faceStamp(p)

  // 3. Credits: the gift's buys, collected with their tickets, land in each wallet.
  for (const p of [tutor, student]) await collectGift(p)

  // 4. Profiles: the stamp kept in the Profiles folder, paid from its own balance, the wallet; the
  // profile's folder funded from the wallet; then the profile. Each app funds its AI's connection
  // folder from the wallet too, as it makes it (pay).
  for (const p of [tutor, student]) {
    p.app = new App({ seed: p.seed, hosts: [s.host], pay: (folder) => p.app!.fund(folder, 1) })
    const wallet = (await mainKey(p.seed, '')).address
    await p.app.keep(p.stamp!)
    const before = await held(wallet)
    await p.app.fund(p.address, PROFILE_CREDITS)
    assert.deepEqual([await held(wallet), await held(p.address)], [before - PROFILE_CREDITS * CREDIT, PROFILE_CREDITS * CREDIT], 'funded from the wallet: a buy paid from its balance, its credits spent into the profile’s folder')
    const made = await profile(p, p.label)
    say(`${p.role}: its profile on the host, ${made}, with a verification and pay { solana, evm }, listed in its Profiles folder ${wallet}, and funded from its wallet with ${PROFILE_CREDITS} credits, a buy paid from its balance`)
  }

  // 5. Logins: each AI acts in its person's profile, with every switch.
  for (const p of [tutor, student]) await logInAs(p)

  // 6. mcp: every call through the AI's own client.
  const [market, tutorRole] = tutor.label.split('/') as [string, string]
  const read = await tutor.ai!.call('markets', { name: market })
  assert.ok(read.kinds.post.price && read.kinds.review.post, 'the tutor’s AI reads what a post and a review hold')
  const maths = {
    description: 'Maths for secondary school, one hour online. A test post, written by an AI through mcp by e2e.',
    price: { amount: '2', currency: 'USD', per: 'hour' },
    subjects: ['maths'],
    levels: ['secondary'],
    place: { online: true },
  }
  const beforePost = await held(tutor.address)
  assert.equal((await tutor.ai!.call('write', { label: tutor.label, path: 'post/maths', body: maths })).written, 'post/maths')
  const postAddress = `${tutor.address}/post/maths`
  const onHost = (await readFolder([s.host], tutor.address, Date.now())).current.get('post/maths')?.entry
  assert.equal(onHost?.body?.description, maths.description, 'on the host, and current')
  assert.equal(onHost?.key, tutor.key, 'signed by the access key the tutor’s app handed over')
  const postPrice = await entryPrice(Buffer.byteLength(encodeEntry(onHost!)))
  assert.equal(await held(tutor.address), beforePost - postPrice, 'paid from the profile’s balance, at its price')
  say(`mcp: the tutor's AI wrote ${postAddress}, signed by its access key, paid from the profile's balance: ${postPrice / CREDIT} credits`)

  /** A message the AI of `from` sends `to`: one credit bought from the sender's balance, and all of it but the inbox entry's price in the recipient's. */
  const message = async (from: Person, to: string, text: string) => {
    const [fromBefore, toBefore] = [await held(from.address), await held(to)]
    assert.deepEqual(await from.ai!.call('message', { label: from.label, to, body: { text } }), { sent: true, hosts: 1 })
    const price = await entryPrice(await newestInbox(to))
    assert.deepEqual([await held(from.address), await held(to)], [fromBefore - CREDIT, toBefore + CREDIT - price], 'one credit from the sender, all of it but the inbox entry’s price to the recipient')
    return price
  }

  const found = await waitFor('the post in the index’s search, through the mcp', INDEX_WAIT, async () => {
    const out = await student.ai!.call('search', { filters: { q: 'maths', market, role: tutorRole } })
    return (out.index.answer.results as Array<{ profile: string; post: { address: string } }> | undefined)?.find((r) => r.post.address === postAddress)
  })
  const text = 'Is Tuesday at six free? A test message, sent through mcp by e2e.'
  const kept = await message(student, found.profile, text)
  say(`mcp: the student’s AI found the post in the index’s search, and messaged the tutor, carrying one credit from the student's balance: the host kept ${kept / CREDIT} for the inbox entry, and the tutor's balance went up by ${(CREDIT - kept) / CREDIT}`)

  type Message = { from?: string; time: number; body: { text?: string }; counts: boolean; index?: { market?: string; role?: string; checks?: Array<{ key: string }> } }
  const asked = await waitFor('the index to show the student, beside its message', INDEX_WAIT, async () => {
    const m = ((await tutor.ai!.call('read', { label: tutor.label, inbox: true })).messages as Message[]).find((x) => x.body.text === text)
    return m?.index?.checks?.some((c) => c.key === s.verifier.keys.face) ? m : null
  })
  assert.equal(asked.from, student.address, 'from the student’s profile')
  assert.equal(asked.counts, true, 'whose profile entry lists the key that signed it with message')
  assert.deepEqual([asked.index!.market, asked.index!.role], [cfg.market, 'student'], 'the student’s market and role, as the index shows them')
  const replyText = 'Tuesday at six, yes. A test reply, sent through mcp by e2e.'
  await message(tutor, asked.from!, replyText)
  say('mcp: the tutor’s AI read it, counted, with the student’s market, role and face check as the index shows them, and replied, carrying one credit the same way')
  const replied = ((await student.ai!.call('read', { label: student.label, inbox: true })).messages as Message[]).find((m) => m.body.text === replyText)
  assert.deepEqual([replied?.from, replied?.counts], [tutor.address, true], 'the student’s AI reads the tutor’s reply')
  say('mcp: the student’s AI read the reply')

  // 7. The review, written by the student's AI, naming the post.
  const review = { subject: found.profile, score: '10', text: 'Clear and patient. A test review.', post: postAddress }
  assert.equal((await student.ai!.call('write', { label: student.label, path: 'review/maths', body: review })).written, 'review/maths')
  const reviewed = (await readFolder([s.host], student.address, Date.now())).current.get('review/maths')?.entry
  assert.deepEqual([reviewed?.body?.post, reviewed?.key], [postAddress, student.key], 'on the host, naming the post, signed by the student’s access key')
  say('the review: the student’s AI scored the tutor 10, naming the post')

  // 8. The loop index counts it all. What each profile shows is what the index's own ranking makes
  // of this one review, with its own numbers: each profile's face check counted, the review a rating
  // and its writer's word about the tutor, a vouch; the student, whom no one rated, a newcomer.
  const index = s.index
  const profilePage = (address: string) => json(`${index.url}/profiles/${address}.json`)
  const face = uniqueness([FACE_CONFIDENCE])
  const ranked = rank(
    [{ address: tutor.address, uniqueness: face }, { address: student.address, uniqueness: face }],
    [{ writer: student.address, subject: tutor.address, score: 10 }],
    [{ writer: student.address, subject: tutor.address, kind: 'rating', time: 0, address: `${student.address}/review/maths` }],
    SCORING,
  )
  const want = (address: string) => ({
    ratings: { value: tenth(ranked.ratings.get(address)!.value), count: ranked.ratings.get(address)!.count },
    trust: hundredth(ranked.trust.get(address)!),
    uniqueness: hundredth(face),
  })
  type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number; statement: string; signature: string }
  const shownOf = (v: Shown) => ({ ratings: v.ratings, trust: v.trust, uniqueness: v.uniqueness })
  const describe = (w: ReturnType<typeof shownOf>) => `rated ${w.ratings.value} by ${w.ratings.count}, trust ${w.trust}, uniqueness ${w.uniqueness}`
  say(`the index: waiting for both profiles, the post, the review, the tutor ${describe(want(tutor.address))}, the student ${describe(want(student.address))}`)
  const shown = await waitFor('the index to show it all', INDEX_WAIT, async () => {
    const [t, st] = await Promise.all([profilePage(tutor.address), profilePage(student.address)])
    if (t.status !== 200 || st.status !== 200) return null
    for (const [v, w] of [[t.body, want(tutor.address)], [st.body, want(student.address)]] as const) {
      if (!v.checks.some((c: { key: string }) => c.key === s.verifier.keys.face)) return null
      if (JSON.stringify(shownOf(v)) !== JSON.stringify(w)) return null
    }
    const got = t.body.reviews.received.find((r: { address: string }) => r.address === `${student.address}/review/maths`)
    if (!got?.counted) return null
    if (!t.body.posts.some((p: { address: string; listed: boolean }) => p.address === postAddress && p.listed)) return null
    return { tutor: t.body as Shown, student: st.body as Shown }
  })
  for (const v of [shown.tutor, shown.student]) {
    const signature = unpackSignature(b64u.decode(v.signature))
    assert.ok(signature && checkBytes(index.address, new TextEncoder().encode(v.statement), signature), 'what each profile shows, signed by the index')
  }
  assert.equal(JSON.stringify(shown).includes(text) || JSON.stringify(shown).includes(replyText), false, 'no message is anywhere in the index')
  say(`the index counts it all: the tutor ${describe(shownOf(shown.tutor))}, the student ${describe(shownOf(shown.student))}, each statement signed; the review counted`)

  // 9. The trust carried to the coach profile, proven on the device. The tutor's leaf holds its
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
  const carried = await proveReputation({ seed: tutor.seed, labels: [tutor.label], leaves, profileLabel: COACH, artifacts: REPUTATION_FILES })
  assert.equal(carried.address, coach.address, 'proven onto the coach profile')
  assert.equal(Number(carried.score), shown.tutor.trust, 'carrying the tutor’s trust')
  assert.ok(await checkReputation({ proof: carried.proof, root, score: carried.score, profile: coach.address, index: index.address, time: tree.served.time, signature: rootSignature }), 'it checks')
  const reputation = { circuit: 'reputation', index: tree.served.index, root: tree.served.root, time: tree.served.time, signature: tree.served.signature, score: Number(carried.score), proof: b64u.encode(reputationBytes(carried.proof)) }
  await tutor.app!.fund(coach.address, COACH_CREDITS)
  await profile(tutor, COACH, [reputation])
  say(`tutor: its leaf found among ${leaves.length}, its trust, ${carried.score}, proven onto ${coach.address}, funded from its wallet with ${COACH_CREDITS} credits`)
  await waitFor('the index to show the proof on the coach profile', INDEX_WAIT, async () => {
    const v = await profilePage(coach.address)
    const x = v.status === 200 ? v.body.proofs?.find((p: { circuit: string }) => p.circuit === 'reputation') : null
    return x?.result === 'shown' && x.trust === shown.tutor.trust ? x : null
  })
  say('the index shows the carried trust on the coach profile')

  // 10. Added: the tutor's app, finding the connection from the seed alone, adds the coach profile
  // to it, with every switch: one access key more, its note, its access entry. With no new login,
  // the tutor's AI acts as both, and writes a locked note as the coach.
  await new App({ seed: tutor.seed, hosts: [s.host] }).addToConnection(tutor.connection!, COACH)
  assert.deepEqual((await tutor.ai!.call('my_profiles')).profiles, [COACH, tutor.label].map((label) => ({ label, can: SWITCHES })), 'with no new login, both, by their labels')
  const coachKey = (await tutor.app!.keys(COACH))[0]!.key
  const plan = { text: 'Football on Saturdays. A test note, locked, written by an AI through mcp by e2e.' }
  assert.equal((await tutor.ai!.call('write', { label: COACH, path: 'notes/plan', body: plan, locked: true })).locked, true)
  assert.deepEqual((await tutor.ai!.call('read', { label: COACH, path: 'notes/plan' })).body, plan, 'and reads it back')
  assert.equal((await readFolder([s.host], coach.address, Date.now())).current.get('notes/plan')?.entry.key, coachKey, 'on the host, signed by the coach’s access key')
  say(`added: the tutor's app added ${COACH} to its AI's connection, from the seed alone; with no new login, the AI wrote a locked note as the coach, signed by its access key ${coachKey}`)

  // 11. Ended: the tutor's app ends the connection: its connection entry deleted, then each key it
  // holds taken out of its profile entry, with its note and its access entry. The mcp answers the
  // AI's next call 401, so it must log in again, and what the keys wrote counts for nothing: the
  // newest entry that still counts at each path is current, and there is none.
  await tutor.app!.endConnection(tutor.connection!)
  for (const label of [tutor.label, COACH]) assert.deepEqual(await tutor.app!.keys(label), [], `no access key listed in ${label}`)
  assert.equal(await tutor.app!.note(tutor.label, tutor.key!), undefined, 'and no note about it')
  assert.deepEqual(await tutor.app!.connections(), [], 'and no connection')
  const ended = await fetch(s.mcp, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tutor.ai!.token()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_profiles', arguments: {} } }),
  })
  assert.equal(ended.status, 401, 'the mcp refuses the ended connection’s token')
  const why = ended.headers.get('www-authenticate') ?? ''
  assert.match(why, /error="invalid_token", error_description="the connection this login points to is gone"/)
  const next = await tutor.ai!.call('write', { label: tutor.label, path: 'post/physics', body: { ...maths, description: 'Physics. A test post after the connection ended.' } }).then(
    () => assert.fail('the mcp acted for an ended connection'),
    (err: Error) => err,
  )
  assert.ok(!(next instanceof Refused), `the AI's next call is refused before any tool, so it must log in again: ${next.message}`)
  assert.equal((await readFolder([s.host], tutor.address, Date.now())).current.get('post/maths'), undefined, 'the post its key wrote counts for nothing')
  assert.equal((await readFolder([s.host], coach.address, Date.now())).current.get('notes/plan'), undefined, 'nor the coach’s note')
  say(`ended: the tutor's app ended its AI's connection; the mcp answered its next call 401 (${why.split('error_description=')[1]}), and the post and the note its keys wrote are gone from the host's view`)

  // 12. A new device: the tutor's seed alone gives its Profiles folder, its two profiles and its stamp.
  const device = await App.find(tutor.seed, [s.host])
  assert.deepEqual(device.labels, [COACH, tutor.label].sort(), 'both its profiles')
  for (const label of device.labels) assert.ok(await profileEntry((await mainKey(tutor.seed, label)).address), `${label}'s folder, on the host`)
  assert.equal(device.stamps.length, 1)
  assert.equal(stampFromJson(JSON.parse(device.stamps[0]!)).signature.S, tutor.stamp!.signature.S, 'its stamp, the one signed')
  say(`a new device found ${device.labels.join(' and ')}, and the stamp, from the tutor's seed alone`)

  // 13. No answer either AI received holds one of its own person's addresses: each profile's, the
  // coach's included, each pay address, the Profiles folder's, and their connection folder's. An AI acting for one person reads
  // the other's addresses, as it must to message and review them.
  for (const [p, labels] of [[tutor, [tutor.label, COACH]], [student, [student.label]]] as const) {
    const own = (await addressesOf(p, [...labels])).map((a) => a.toLowerCase())
    const answers = p.ai!.answers.map((a) => a.toLowerCase())
    const held = own.filter((a) => answers.some((answer) => answer.includes(a)))
    assert.deepEqual(held, [], `an answer ${p.role}'s AI got holds one of ${p.role}'s own addresses`)
  }
  say(`no answer holds the person's own addresses: ${tutor.ai!.answers.length} answers to the tutor's AI, ${student.ai!.answers.length} to the student's`)

  // 14. Balances.
  const left = async (folder: string) => (await json(`${s.host}/credits/balance/${folder}`)).body.credits as number
  say(
    `balances: the tutor's folder ${await left(tutor.address)} credits, the student's ${await left(student.address)}, the coach's ${await left(coach.address)}; ` +
      `the Profiles folders ${await left((await mainKey(tutor.seed, '')).address)} and ${await left((await mainKey(student.seed, '')).address)}; ` +
      `the connection folders ${await left(tutor.connection!)} and ${await left(student.connection!)}`,
  )
}

/** The deployed check: each service the file names answers, and no loop runs. */
async function deployed() {
  say(`the deployed check: ${named(cfg).join(', ')}, as ${servicesFile} names them`)
  await checkDeployed(cfg, say)
}

let passed = false
try {
  await (named(cfg).length ? deployed() : main())
  passed = true
} catch (err) {
  console.error((err as Error).stack ?? String(err))
} finally {
  for (const p of people) await p.ai?.close().catch(() => {})
  await services?.stop().catch((err) => console.error(String(err)))
  page?.close()
  say(passed ? 'passed' : 'failed')
}
// The proofs' workers keep the process alive; the run is over either way.
process.exit(passed ? 0 : 1)
