// The loop: Forest end to end. Two people from two seeds, a tutor who sells and a student who buys.
// Each one's device is the reference app (mcp/test/app.ts), unchanged: it holds the seed and the
// stamp, keeps the Profiles folder, makes each profile with its verification, and at the connect
// page hands the mcp an access key for the profile ticked. What it has no method for, the device
// does here with the standard's pieces: the stamp and the welcome gift asked for, the credits, the
// reputation proof. Each person's AI is the MCP SDK's own client (mcp/test/setup.ts), logging in
// through the loop's connect page and calling the mcp's tools, which act in the person's folder with
// that access key. Against the loop's own verifier, host, index and mcp, on loopback (services.ts),
// with no chain and no secret.
//
//   ../standard.sh
//   (cd ../verifier && npm ci) && (cd ../host && npm ci) && (cd ../index && npm ci) && (cd ../mcp && npm ci)
//   npm ci && npm run e2e                      # the loop
//   npm run e2e -- <deployed.json>             # the deployed check: each service it names answers
//
//    1. keys: a seed each, and from it the profile's address and pay { solana, evm }, and the stamp
//       number at the loop verifier; the tutor's second profile, sports-coaching/coach;
//    2. stamps: the loop verifier's face check (its stand-in Didit passes it), asked with the
//       welcome gift for one buy at the host; a stamp for each, kept on the person's device, then
//       asked back from the verifier by its stamp number;
//    3. credits: each buy collected at the host with the gift's ticket, and finished;
//    4. profiles: credits into each folder, the stamp kept in the Profiles folder, and the profile,
//       its profile entry with a verification made on the device, listed there too;
//    5. logins: each AI logs in through the connect page, where the person ticks their profile and
//       their app lists an access key in its profile entry with every switch, writes its note, and
//       hands the mcp the pack;
//    6. mcp: the tutor's AI writes an offer; the student's finds it through the index's search and
//       messages the tutor; the tutor's reads the inbox, the student's market, role and checks as the
//       index shows them, and replies; the student's reads the reply;
//    7. the review: the student's AI reviews the tutor, naming the offer;
//    8. the loop index counts it all: both profiles, the offer, the review, and what each profile
//       shows (ratings, trust, uniqueness) as its own ranking makes them, signed; no message
//       anywhere;
//    9. the trust carried: the tutor's device finds its leaf by its profile, proves its trust onto
//       its coach profile, and the index shows the proof;
//   10. removed: the tutor's app takes the access key out of the profile entry; the host refuses its
//       AI's next write, and the offer it wrote counts for nothing;
//   11. a new device: from the tutor's seed alone, the Profiles folder gives its two profiles and its
//       stamp;
//   12. addresses: no answer either AI received holds one of its own person's addresses;
//   13. balances: what each folder's credits came to.
// Then, passed or failed, what the loop started stops, and the run exits 0 or 1. What it did is in
// what it prints.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { type Body, b64u, checkPay, hex, notePath, proofsOf, readFolder, verificationCheck } from '@foundationforest/folders'
import { lockCount, openLocked } from '@foundationforest/folders/locked'
import { type PayAddresses, checkBytes, mainKey, newSeed, openingHalf, payAddresses, pointOf, profilesKey, seedScalar, unpackSignature, verifierSecret } from '@foundationforest/keys'
import { buildTree, checkReputation, proofBytes as reputationBytes, proveReputation, signedBytes } from '@foundationforest/reputation'
import { type SignedStamp, checkVerification, stampFromJson, stampSigned, toBytes32 } from '@foundationforest/verification'

import { type Credit, DIRECTORY_PATH, PAYMENT_HEADER, type Pending, buy, creditList, finish, serviceOf } from '../host/client/client.ts'
import { hundredth, tenth } from '../index/src/pass.ts'
import { type Numbers, rank, uniqueness } from '../index/src/rank.ts'
import { App } from '../mcp/test/app.ts'
import { aiApp, logIn } from '../mcp/test/setup.ts'
import { FACE_CONFIDENCE, type Running, VERIFIER_NAME, checkDeployed, named, readServices, startServices } from './services.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const servicesFile = process.argv[2] ? resolve(process.argv[2]) : join(here, 'services.json')
const cfg = readServices(servicesFile)
const REPUTATION_FILES = { wasm: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.wasm'), zkey: join(repo, 'standard/proofs/reputation/circuit/setup/reputation.zkey') }
/** The tutor's second profile, where it carries its trust: another market, from the same seed. */
const COACH = 'sports-coaching/coach'
/** How many of the host's credits the loop verifier's welcome gift gives each person: its own default. */
const CREDITS = 10
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
  stampNumber: bigint
  stamp?: SignedStamp
  /** The buy the welcome gift pays for, its bytes and what finishes it, and the gift's ticket. */
  gift?: { buy: Uint8Array; pending: Pending; ticket: string }
  credits: Credit[]
  app?: App
  ai?: AI
  /** The address of the access key the person's app handed the mcp for the profile. */
  key?: string
}

async function person(role: Person['role']): Promise<Person> {
  const seed = newSeed()
  const label = `${cfg.market}/${role}`
  return {
    role,
    label,
    seed,
    scalar: await seedScalar(seed),
    address: (await mainKey(seed, label)).address,
    pay: await payAddresses(seed, label),
    stampNumber: (await verifierSecret(seed, VERIFIER_NAME)).stampNumber,
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

/**
 * The face check, as the app does it, asked with the welcome gift: the gift read in the verifier's
 * `GET /`, one buy at its host of exactly its credits, a session, the check (the stand-in passes
 * it), the stamp number and the buy's reference sent, and a stamp and a ticket back, checked. The
 * app keeps the stamp on the device, as safely as a key, and the buy to finish later.
 */
async function faceStamp(p: Person) {
  const verifier = services!.verifier
  const about = await json(`${verifier.url}/`)
  assert.deepEqual(about.body.gift, { credits: CREDITS, host: services!.host, sponsor: verifier.sponsor }, 'the loop verifier gives ten of its host’s credits')
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
  assert.equal(typeof got.body.gift?.ticket, 'string', `the gift's ticket: ${JSON.stringify(got.body.gift)}`)
  assert.equal(got.body.gift.ticket.split('.')[0], verifier.sponsor, 'signed by the verifier’s sponsor key')
  p.stamp = stamp
  p.gift = { buy: b.buy, pending: b.pending, ticket: got.body.gift.ticket }
  // A device that lost its stamp asks for it again by its stamp number: the same stamp comes back.
  const back = await post(`${verifier.url}/stamp`, { stampNumber: p.stampNumber.toString() })
  assert.equal(back.status, 200, `the stamp asked back: ${JSON.stringify(back.body)}`)
  const own = (x: SignedStamp) => ({ stampNumber: x.stampNumber, facts: x.facts, verifier: x.verifier, signature: x.signature })
  assert.deepEqual(own(stampFromJson(back.body.face)), own(stamp), 'asked back by its stamp number, it is the one signed')
  say(`${p.role}: a stamp from the loop verifier's face check, model ${String(got.body.stamp.model)}, kept on the device, the same asked back by its stamp number, and the gift's ticket for ${CREDITS} credits, buy ${b.reference}`)
}

/** The gift's credits, as the app collects them: the buy sent to the host with its ticket, and the credits finished. */
async function collectGift(p: Person) {
  const service = serviceOf(services!.host, (await json(`${services!.host}${DIRECTORY_PATH}`)).body)
  const res = await fetch(service.requestUri, { method: 'POST', headers: { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `ticket ${p.gift!.ticket}` }, body: p.gift!.buy as Uint8Array<ArrayBuffer> })
  assert.equal(res.status, 200, `${services!.host} takes the gift's ticket: ${await res.clone().text()}`)
  p.credits = await finish(p.gift!.pending, new Uint8Array(await res.arrayBuffer()))
  assert.equal(p.credits.length, CREDITS)
  say(`${p.role}: ${CREDITS} credits collected with the gift's ticket and finished`)
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
  say(`${p.role}: its AI logged in, and acts in ${p.label} with the access key ${p.key}: ${SWITCHES.join(', ')}, its note locked to the main key`)
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

  // 2. Stamps, each asked with the welcome gift.
  for (const p of [tutor, student]) await faceStamp(p)

  // 3. Credits: the gift's buys, collected with their tickets.
  for (const p of [tutor, student]) await collectGift(p)

  // 4. Profiles: credits into the Profiles folder, where the app keeps the stamp, and into the
  // profile's folder, then the profile. The tutor keeps three credits for its coach profile.
  for (const [p, n] of [[tutor, CREDITS - 5], [student, CREDITS - 2]] as const) {
    p.app = new App({ seed: p.seed, hosts: [s.host] })
    const folder = (await profilesKey(p.seed)).address
    await spend(p, folder, 2)
    await p.app.keep(p.stamp!, VERIFIER_NAME)
    await spend(p, p.address, n)
    const made = await profile(p, p.label)
    say(`${p.role}: its profile on the host, ${made}, with a verification and pay { solana, evm }, each signed, listed in its Profiles folder ${folder}; 2 credits there and ${n} in the profile's folder`)
  }

  // 5. Logins: each AI acts in its person's profile, with every switch.
  for (const p of [tutor, student]) await logInAs(p)

  // 6. mcp: every call through the AI's own client.
  const [market, tutorRole] = tutor.label.split('/') as [string, string]
  const read = await tutor.ai!.call('markets', { name: market })
  assert.ok(read.kinds.includes('offer') && read.market.offer.price, 'the tutor’s AI reads what an offer holds')
  const offer = {
    description: 'Maths for secondary school, one hour online. A test offer, posted by an AI through mcp by e2e.',
    price: { amount: '2', currency: 'USD', per: 'hour' },
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
  say(`mcp: the tutor's AI wrote ${offerAddress}, signed by its access key`)

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
  say('mcp: the tutor’s AI read it, counted, with the student’s market, role and face check as the index shows them, and replied')
  const replied = ((await student.ai!.call('read', { label: student.label, inbox: true })).messages as Message[]).find((m) => m.body.text === replyText)
  assert.deepEqual([replied?.from, replied?.counts], [tutor.address, true], 'the student’s AI reads the tutor’s reply')
  say('mcp: the student’s AI read the reply')

  // 7. The review, written by the student's AI, naming the offer.
  const review = { subject: found.profile, score: '10', text: 'Clear and patient. A test review.', offer: offerAddress }
  assert.equal((await student.ai!.call('write', { label: student.label, path: 'review/maths', body: review })).written, 'review/maths')
  const reviewed = (await readFolder([s.host], student.address, Date.now())).current.get('review/maths')?.entry
  assert.deepEqual([reviewed?.body?.offer, reviewed?.key], [offerAddress, student.key], 'on the host, naming the offer, signed by the student’s access key')
  say('the review: the student’s AI scored the tutor 10, naming the offer')

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
  say(`the index: waiting for both profiles, the offer, the review, the tutor ${describe(want(tutor.address))}, the student ${describe(want(student.address))}`)
  const shown = await waitFor('the index to show it all', INDEX_WAIT, async () => {
    const [t, st] = await Promise.all([profilePage(tutor.address), profilePage(student.address)])
    if (t.status !== 200 || st.status !== 200) return null
    for (const [v, w] of [[t.body, want(tutor.address)], [st.body, want(student.address)]] as const) {
      if (!v.checks.some((c: { key: string }) => c.key === s.verifier.keys.face)) return null
      if (JSON.stringify(shownOf(v)) !== JSON.stringify(w)) return null
    }
    const got = t.body.reviews.received.find((r: { address: string }) => r.address === `${student.address}/review/maths`)
    if (!got?.counted) return null
    if (!t.body.posts.some((p: { address: string; listed: boolean }) => p.address === offerAddress && p.listed)) return null
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
  const carried = await proveReputation({ seedScalar: tutor.scalar, labels: [tutor.label], leaves, profileLabel: COACH, artifacts: REPUTATION_FILES })
  assert.equal(carried.address, coach.address, 'proven onto the coach profile')
  assert.equal(Number(carried.score), shown.tutor.trust, 'carrying the tutor’s trust')
  assert.ok(await checkReputation({ proof: carried.proof, root, score: carried.score, profile: coach.address, index: index.address, time: tree.served.time, signature: rootSignature }), 'it checks')
  const reputation = { circuit: 'reputation', index: tree.served.index, root: tree.served.root, time: tree.served.time, signature: tree.served.signature, score: Number(carried.score), proof: b64u.encode(reputationBytes(carried.proof)) }
  await spend(tutor, coach.address, 3)
  await profile(tutor, COACH, [reputation])
  say(`tutor: its leaf found among ${leaves.length}, its trust, ${carried.score}, proven onto ${coach.address} with its last 3 credits`)
  await waitFor('the index to show the proof on the coach profile', INDEX_WAIT, async () => {
    const v = await profilePage(coach.address)
    const x = v.status === 200 ? v.body.proofs?.find((p: { circuit: string }) => p.circuit === 'reputation') : null
    return x?.result === 'shown' && x.trust === shown.tutor.trust ? x : null
  })
  say('the index shows the carried trust on the coach profile')

  // 10. The tutor's app takes the access key out of the profile entry. The host refuses the AI's
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
  say(`removed: the tutor's app took its AI's key out; the host refused its next write (${refused}), and the offer it wrote is gone from the host's view`)

  // 11. A new device: the tutor's seed alone gives its Profiles folder, its two profiles and its stamp.
  const device = await App.find(tutor.seed, [s.host])
  assert.deepEqual(device.labels, [COACH, tutor.label].sort(), 'both its profiles')
  for (const label of device.labels) assert.ok(await profileEntry((await mainKey(tutor.seed, label)).address), `${label}'s folder, on the host`)
  assert.equal(device.stamps.length, 1)
  assert.equal(stampFromJson(JSON.parse(device.stamps[0]!)).signature.S, tutor.stamp!.signature.S, 'its stamp, the one signed')
  say(`a new device found ${device.labels.join(' and ')}, and the stamp, from the tutor's seed alone`)

  // 12. No answer either AI received holds one of its own person's addresses: each profile's, the
  // coach's included, each pay address, and the Profiles folder's. An AI acting for one person reads
  // the other's addresses, as it must to message and review them.
  for (const [p, labels] of [[tutor, [tutor.label, COACH]], [student, [student.label]]] as const) {
    const own = (await addressesOf(p, [...labels])).map((a) => a.toLowerCase())
    const answers = p.ai!.answers.map((a) => a.toLowerCase())
    const held = own.filter((a) => answers.some((answer) => answer.includes(a)))
    assert.deepEqual(held, [], `an answer ${p.role}'s AI got holds one of ${p.role}'s own addresses`)
  }
  say(`no answer holds the person's own addresses: ${tutor.ai!.answers.length} answers to the tutor's AI, ${student.ai!.answers.length} to the student's`)

  // 13. Balances.
  const left = async (folder: string) => (await json(`${s.host}/credits/balance/${folder}`)).body.credits as number
  say(
    `balances: the tutor's folder ${await left(tutor.address)} credits, the student's ${await left(student.address)}, the coach's ${await left(coach.address)}; ` +
      `the Profiles folders ${await left((await profilesKey(tutor.seed)).address)} and ${await left((await profilesKey(student.seed)).address)}`,
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
