// The verifier end to end, in one process: a stand-in Didit, an embedder that knows people by name, a
// real SQLite file, real HTTP, and stamps checked the way the standard checks them, a verification
// made and checked against the key `GET /` publishes. One test runs the stand-in Didit the
// end-to-end test runs (test/fake-didit.ts) itself, with the stand-in embedding.
//
//   npm test

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hkdf, seedNumber, serviceKey, stampNumberOf } from '@foundationforest/keys'
import { checkVerification, proveVerification, signStamp, stampFromJson, stampSigned } from '@foundationforest/proofs'
import { b64u, canonical, parseCanonical } from '@foundationforest/folders'
import { poseidon3 } from 'poseidon-lite/poseidon3'

import { buy, finish, serviceOf } from '../../host/client/client.ts'
import * as hostCredits from '../../host/credits/seller.ts'

import { DiditClient, DiditUnavailable } from '../src/didit.ts'
import { RECIPES, faceFacts, fieldsRoot, fieldsText, h as hash, idFacts } from '../src/facts.ts'
import { INFO, SEED_FILE, parseSeed, seedFrom } from '../src/seed.ts'
import { HOLD_FOR_MS, HOLDS_EVERY_MS, OPEN_FOR_MS, SIGNED_FOR_MS } from '../src/server.ts'
import { CONSENT, readConfig, startVerifier, type Verifier } from '../src/service.ts'
import { ID_TRIES, Store } from '../src/store.ts'
import { PaymentUnavailable } from '../src/stripe.ts'
import {
  FACE_WORKFLOW,
  FakeFaceCheck,
  FakePayments,
  ID_WORKFLOW,
  VERIFIER_NAME,
  assertKept,
  doc,
  faceOf,
  namedFaces,
  stampNumber,
  passed,
  passedId,
  seedJson,
} from './fakes.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** The verification circuit's setup files, committed in the standard. */
const setup = join(here, '../../standard/proofs/verification/setup')
const ARTIFACTS = { wasm: join(setup, 'verification.wasm'), zkey: join(setup, 'verification.zkey') }

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forest-verifier-'))
  dirs.push(dir)
  return dir
}

type Harness = {
  verifier: Verifier
  faces: FakeFaceCheck
  /** The ID check's Didit. */
  ids: FakeFaceCheck
  /** Stripe. */
  payments: FakePayments
  /** The payment each ID session was opened with. */
  paidFor: Map<string, string>
  /** The ID sessions a payment opened, in order. */
  sessionsOf(payment: string): string[]
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new face session whose check came to `decision`; returns its id. */
  session(decision: ReturnType<typeof passed>): Promise<string>
  /** A payment made and paid at Stripe, not yet sent to the verifier. */
  paid(): Promise<string>
  /** A payment that opened an ID session, so the verifier knows it was paid, and gave no stamp. */
  knownPayment(): Promise<string>
  /** A new ID session whose check came to `decision`, opened with `payment` or a new one; returns its id. */
  idSession(decision: ReturnType<typeof passed>, payment?: string): Promise<string>
  /** Moves the verifier's clock on. */
  later(ms: number): void
}

/**
 * The verifier, with `seed` in its seed file beside the database when given; with none there, it
 * makes one. Its ID check is for sale, through a stand-in Stripe, unless `forSale` is false: then
 * through Stripe itself if its settings give a key, and otherwise not.
 */
async function start(options: { env?: Record<string, string | undefined>; seed?: string; dbPath?: string; forSale?: boolean } = {}): Promise<Harness> {
  const dbPath = options.dbPath ?? join(tempDir(), 'verifier.sqlite')
  if (options.seed) writeFileSync(join(dirname(dbPath), SEED_FILE), options.seed, { mode: 0o600 })
  const config = readConfig({
    VERIFIER_NAME,
    DIDIT_FACE_API_KEY: 'not-used',
    DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
    DIDIT_ID_API_KEY: 'not-used',
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DATABASE_PATH: dbPath,
    PORT: '0',
    ...options.env,
  })
  let clock = Date.now()
  const faces = new FakeFaceCheck()
  const ids = new FakeFaceCheck()
  const payments = new FakePayments(() => clock)
  const paidFor = new Map<string, string>()
  const logs: string[] = []
  const verifier = await startVerifier(config, {
    faceCheck: faces,
    idCheck: ids,
    embedder: namedFaces(),
    ...(options.forSale !== false && { payments }),
    log: (line) => logs.push(line),
    now: () => clock,
  })
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(verifier.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const session = async (decision: ReturnType<typeof passed>) => {
    const { status, body } = await post('/face/session')
    assert.equal(status, 201)
    faces.set(body.sessionId, decision)
    return body.sessionId as string
  }
  const paid = async () => {
    const { payment } = await payments.checkout('https://app.example/paid')
    payments.pay(payment)
    return payment
  }
  const idSession = async (decision: ReturnType<typeof passed>, payment?: string) => {
    payment ??= await paid()
    const { status, body } = await post('/id/session', { payment })
    assert.equal(status, 201, JSON.stringify(body))
    ids.set(body.sessionId, decision)
    paidFor.set(body.sessionId, payment)
    return body.sessionId as string
  }
  const knownPayment = async () => {
    const payment = await paid()
    await idSession(passedId('nobody'), payment)
    return payment
  }
  const sessionsOf = (payment: string) => [...paidFor].filter(([, p]) => p === payment).map(([id]) => id)
  return { verifier, faces, ids, payments, paidFor, sessionsOf, dbPath, logs, post, session, paid, knownPayment, idSession, later: (ms) => void (clock += ms) }
}

const faceStamp = (h: Harness, sessionId: string, n: bigint) => h.post('/face/stamp', { sessionId, stampNumber: n.toString() })
/** An ID stamp asked with `payment`, or else the one its session was opened with. */
const idStamp = (h: Harness, sessionId: string, n: bigint, payment = h.paidFor.get(sessionId)) => h.post('/id/stamp', { sessionId, stampNumber: n.toString(), payment })
const about = async (h: Harness) => (await fetch(h.verifier.url + '/')).json()
/** A stamp's own fields: what the verifier keeps of it, and hands back. */
const own = ({ stampNumber, facts, verifier, verifierName, signature }: Record<string, unknown>) => ({ stampNumber, facts, verifier, verifierName, signature })
const stampBack = (h: Harness, n: bigint) => h.post('/stamp', { stampNumber: n.toString() })

/** A face stamp for `person`, as an app gets one. */
async function face(h: Harness, person: string, n: bigint) {
  const sessionId = await h.session(passed(person))
  const res = await faceStamp(h, sessionId, n)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { sessionId, stamp: res.body.stamp }
}

test('GET /: the name, for each check the key that signs its stamps, as an address, and its facts recipe, and the consent screen', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const res = await fetch(h.verifier.url + '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const text = await res.text()
    assert.equal(canonical(parseCanonical(text)), text, 'canonical JSON')
    // A new recipe is a new key: the ID key's text is `id-fields`, never `id`, which derived the key of the recipe before.
    const keys = { face: serviceKey(await hkdf(seed.bytes, 'face')).address, id: serviceKey(await hkdf(seed.bytes, 'id-fields')).address }
    assert.notEqual(keys.id, serviceKey(await hkdf(seed.bytes, 'id')).address)
    assert.deepEqual(JSON.parse(text), {
      name: VERIFIER_NAME,
      face: { key: keys.face, facts: 'Poseidon([h(model), h(embedding)])' },
      id: { key: keys.id, facts: 'Poseidon([h(model), h(embedding), fieldsRoot])', forSale: true, testPayments: true },
      h: RECIPES.h,
      fieldsRoot:
        'the root of a Poseidon Merkle tree of depth 8 over the fields beside the stamp: one leaf Poseidon([h(name), h(value)]) for each, in the order of their names, then leaves of 0; each node Poseidon([left, right])',
      consent: CONSENT,
    })
    assert.deepEqual(h.verifier.keys, keys)
    assert.notEqual(keys.face, keys.id, 'two keys, one for each check')
    assert.equal((await fetch(h.verifier.url + '/', { method: 'POST' })).status, 405)
  } finally {
    await h.verifier.close()
  }
})

test('GET /: whether the ID check is for sale, and whether its payments run on a test key, as its Stripe key says, before anyone asks Stripe', async () => {
  for (const [key, forSale, testPayments] of [
    [undefined, false, false],
    ['sk_test_51standin', true, true],
    ['rk_test_51standin', true, true],
    ['sk_live_51standin', true, false],
    ['rk_live_51standin', true, false],
  ] as const) {
    const h = await start({ forSale: false, env: { STRIPE_SECRET_KEY: key, STRIPE_ID_PRICE: key && 'price_1standin' } })
    try {
      const { id } = await about(h)
      assert.deepEqual({ forSale: id.forSale, testPayments: id.testPayments }, { forSale, testPayments }, key ?? 'no key')
    } finally {
      await h.verifier.close()
    }
  }
})

test('a face stamp: signed by the face key, its facts the face recipe, and a verification from it holds for that key only', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const n = stampNumberOf(seedNumber(seed), VERIFIER_NAME)
    const { stamp: json } = await face(h, 'alice', n)
    assert.deepEqual(Object.keys(json).sort(), ['embedding', 'facts', 'model', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.stampNumber, n)
    assert.equal(stamp.verifierName, VERIFIER_NAME, 'under its name')
    assert.equal(stamp.verifier, published.face.key, 'the face key GET / publishes')
    assert.ok(stampSigned(stamp), "the standard's check: the verifier signed it")
    assert.deepEqual(b64u.decode(json.embedding), faceOf('alice'), "alice's face, beside the stamp")
    assert.equal(json.model, 'test-model')
    assert.equal(stamp.facts, faceFacts('test-model', faceOf('alice')), 'Poseidon([h(model), h(embedding)])')

    // The stamp does what it is for: a verification, made with the standard's own code, that holds for its verifier.
    const label = 'lessons/seller'
    const proof = await proveVerification({ seed, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
    assert.equal(await check(published.face.key), true)
    assert.equal(await check(published.id.key), false, 'a face stamp is no ID stamp')
    assert.deepEqual(h.logs, [], 'nothing is logged')
  } finally {
    await h.verifier.close()
  }
})

test('an ID stamp: signed by the ID key, its facts the ID recipe over the fields beside it, and a verification for that key only', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const n = stampNumberOf(seedNumber(seed), VERIFIER_NAME)
    const read = doc('Lovelace', { first_name: ' ADA ', last_name: 'LoveLace', 'extra_fields.profession': 'Mathematician' })
    const res = await idStamp(h, await h.idSession(passedId('ada', read)), n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const json = res.body.stamp
    assert.deepEqual(Object.keys(json).sort(), ['embedding', 'facts', 'fields', 'model', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const fields = JSON.parse(json.fields)
    assert.deepEqual(fields, read, "every field Didit read, as it read it, by Didit's names")
    assert.equal(fieldsText(fields), json.fields, 'as text, in canonical JSON')
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.verifier, published.id.key, 'the ID key GET / publishes')
    assert.ok(stampSigned(stamp))
    // The root made again from the fields beside the stamp, whatever order they are read in.
    const reversed = Object.fromEntries(Object.entries(fields).reverse())
    assert.equal(stamp.facts, poseidon3([hash(json.model), hash(b64u.decode(json.embedding)), fieldsRoot(reversed)]), 'Poseidon([h(model), h(embedding), fieldsRoot])')
    assert.equal(stamp.facts, idFacts('test-model', faceOf('ada'), read))

    const label = 'lessons/buyer'
    const proof = await proveVerification({ seed, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
    assert.equal(await check(published.id.key), true)
    assert.equal(await check(published.face.key), false, 'an ID stamp is no face stamp')

    // A field Didit did not read is simply absent: the person is not turned away.
    const { issuing_state: _, ...countryless } = doc('Krasniqi')
    const without = await idStamp(h, await h.idSession(passedId('besa', countryless)), await stampNumber())
    assert.equal(without.status, 200, JSON.stringify(without.body))
    assert.deepEqual(JSON.parse(without.body.stamp.fields), countryless)
    assert.equal(stampFromJson(without.body.stamp).facts, idFacts('test-model', faceOf('besa'), countryless))
  } finally {
    await h.verifier.close()
  }
})

test('one ID stamp a person, ever: a face Didit has seen, with the same birth date and a name that fits, is refused for another stamp number; for the same one, the first stamp, given back', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const first = await h.idSession(passedId('ada', doc('Lovelace')))
    const signed = await idStamp(h, first, n1)
    assert.equal(signed.status, 200)
    assert.equal(h.payments.state(h.paidFor.get(first)!), 'taken', 'a new ID stamp takes the hold')
    // What Didit keeps of her: a user, by the session's vendor_data, with the name and birth date it read.
    h.ids.users.set('id-ada', { fullName: 'Ada Lovelace', birth: '1990-04-01' })
    const seen = { matches: [{ vendorData: 'id-ada', sessionId: null }] }

    // Her face again, the same name and birth date written another way, from another country's document, for another stamp number: refused.
    const renewed = doc('lovelace ', { first_name: '  ADA', full_name: 'ADA LOVELACE', issuing_state: 'IRL', document_number: 'CD7654321' })
    const refused = await h.idSession(passedId('ada', renewed, seen))
    assert.deepEqual(await idStamp(h, refused, n2), { status: 403, body: { error: 'duplicate_document' } })
    assert.equal(h.payments.state(h.paidFor.get(refused)!), 'cancelled', 'its hold cancelled')
    assert.deepEqual(await idStamp(h, refused, n1), { status: 409, body: { error: 'payment_used' } }, 'and its payment used up')
    // For the same stamp number, from a new session: the first stamp back, its own fields only, never a new one, and nothing taken.
    const later = await h.idSession(passedId('ada', renewed, seen))
    const again = await idStamp(h, later, n1)
    assert.deepEqual(again, { status: 200, body: { stamp: own(signed.body.stamp) } })
    assert.equal(h.payments.state(h.paidFor.get(later)!), 'cancelled', 'a stamp given back cancels its hold')
    assert.deepEqual((await stampBack(h, n1)).body.id, own(signed.body.stamp), 'the one POST /stamp gives')
    assert.deepEqual((await idStamp(h, later, n1)).body, again.body, 'and that session, sent again, the same')
    // The first session, sent again within its hour: its stamp, with its fields; after it, used.
    assert.deepEqual((await idStamp(h, first, n1)).body, signed.body)
    h.later(SIGNED_FOR_MS)
    assert.deepEqual(await idStamp(h, first, n1), { status: 409, body: { error: 'session_used' } })
    // Ada Lovelace born another day, with her face, is someone else.
    assert.equal((await idStamp(h, await h.idSession(passedId('ada2', doc('Lovelace', { date_of_birth: '1815-12-10' }), seen)), n2)).status, 200)
  } finally {
    await h.verifier.close()
  }
})

/** An ID check, for a new stamp number, matching the Didit users `like`: its status and code, its payment's hold, and the user it leaves in Didit once stamped. */
async function idCheck(h: Harness, who: { first: string; last: string; birth: string }, like: string[] = []) {
  const full = `${who.first} ${who.last}`
  const document = doc(who.last, { first_name: who.first, last_name: who.last, full_name: full, date_of_birth: who.birth })
  const sessionId = await h.idSession(passedId(full, document, { matches: like.map((vendorData) => ({ vendorData, sessionId: null })) }))
  const res = await idStamp(h, sessionId, await stampNumber())
  const user = `id-${randomUUID()}`
  if (res.status === 200) h.ids.users.set(user, { fullName: full, birth: who.birth })
  return { status: res.status, error: res.body.error as string | undefined, hold: h.payments.state(h.paidFor.get(sessionId)!), user }
}

test('the ID check refuses a person Didit has seen: their face, birth date and a name that fits; twins, namesakes and another birth date pass', async () => {
  const h = await start()
  try {
    const refused = { status: 403, error: 'duplicate_document', hold: 'cancelled' }
    const passes = { status: 200, error: undefined, hold: 'taken' }
    const outcome = ({ status, error, hold }: Awaited<ReturnType<typeof idCheck>>) => ({ status, error, hold })

    // Carlos Islas, then Carlos Islas Garza: the same face and birth date, and the first name in both.
    const carlos = await idCheck(h, { first: 'Carlos', last: 'Islas', birth: '1990-01-01' })
    assert.deepEqual(outcome(carlos), passes)
    assert.deepEqual(outcome(await idCheck(h, { first: 'Carlos', last: 'Islas Garza', birth: '1990-01-01' }, [carlos.user])), refused, 'a name with one more word')
    // The other way round: every word of the user's name in this one's.
    const garza = await idCheck(h, { first: 'Carlos Alberto', last: 'Islas Garza', birth: '1992-02-02' })
    assert.deepEqual(outcome(await idCheck(h, { first: 'Carlos', last: 'Islas', birth: '1992-02-02' }, [garza.user])), refused, 'a name with fewer words')
    // Accents, case and marks are no difference.
    const jose = await idCheck(h, { first: 'JOSE', last: "O'BRIEN", birth: '1993-03-03' })
    assert.deepEqual(outcome(await idCheck(h, { first: 'José', last: 'O’Brien', birth: '1993-03-03' }, [jose.user])), refused, 'NFKD, marks removed, lower case, letters only')

    // Twins: one face, one birth date and one last name, each first name the other's own.
    const ana = await idCheck(h, { first: 'Ana', last: 'Islas', birth: '1995-05-05' })
    assert.deepEqual(outcome(await idCheck(h, { first: 'Eva', last: 'Islas', birth: '1995-05-05' }, [ana.user])), passes, 'Ana and Eva')
    const mariaJose = await idCheck(h, { first: 'María José', last: 'López', birth: '1996-06-06' })
    assert.deepEqual(outcome(await idCheck(h, { first: 'María Fernanda', last: 'López', birth: '1996-06-06' }, [mariaJose.user])), passes, 'María José and María Fernanda')
    // Strangers with one name and birth date, and two faces: Didit matches neither to the other.
    assert.deepEqual(outcome(await idCheck(h, { first: 'Juan', last: 'Pérez', birth: '1985-03-03' })), passes)
    assert.deepEqual(outcome(await idCheck(h, { first: 'Juan', last: 'Pérez', birth: '1985-03-03' })), passes, 'a name alone never decides')
    // One face, another birth date: someone else.
    assert.deepEqual(outcome(await idCheck(h, { first: 'Carlos', last: 'Islas', birth: '1991-01-01' }, [carlos.user])), passes, 'a face alone never decides')

    // A user with no name: the birth date alone decides.
    h.ids.users.set('id-nameless', { fullName: null, birth: '2000-01-01' })
    assert.deepEqual(outcome(await idCheck(h, { first: 'Lena', last: 'Ortiz', birth: '2000-01-01' }, ['id-nameless'])), refused)
    assert.deepEqual(outcome(await idCheck(h, { first: 'Lena', last: 'Ortiz', birth: '2000-01-02' }, ['id-nameless'])), passes)
    // A user Didit no longer has, as after they had Didit erase their data, or one with no birth date: no one.
    h.ids.users.set('id-undated', { fullName: 'Lena Ortiz', birth: null })
    assert.deepEqual(outcome(await idCheck(h, { first: 'Lena', last: 'Ortiz', birth: '2001-01-01' }, ['id-gone', 'id-undated'])), passes)

    // Didit not answering for a user: a 502, and nothing used.
    h.ids.usersDown = true
    const payment = await h.paid()
    const sessionId = await h.idSession(passedId('kim', doc('Kim'), { matches: [{ vendorData: carlos.user, sessionId: null }] }), payment)
    const n = await stampNumber()
    assert.deepEqual(await idStamp(h, sessionId, n), { status: 502, body: { error: 'face_check_unavailable' } })
    assert.equal(h.payments.state(payment), 'held')
    h.ids.usersDown = false
    assert.equal((await idStamp(h, sessionId, n)).status, 200, 'the same session, asked again')
  } finally {
    await h.verifier.close()
  }
})

test('a match to a session the same payment opened is the person’s own earlier try; any other session takes only its own payment', async () => {
  const h = await start()
  try {
    // Two tries on one payment, both approved; the app lost the first. The second matches it.
    const payment = await h.paid()
    const lost = await h.idSession(passedId('ida', doc('Pfeiffer')), payment)
    h.ids.users.set('id-lost', { fullName: 'Ada Pfeiffer', birth: '1990-04-01' })
    const second = await h.idSession(passedId('ida', doc('Pfeiffer'), { matches: [{ vendorData: 'id-lost', sessionId: lost }] }), payment)
    const [a, b] = [await stampNumber(), await stampNumber()]
    assert.equal((await idStamp(h, second, a)).status, 200, 'its own earlier try is no one else')
    // The first, for another seed: its payment gave its stamp, and no other payment takes it.
    assert.deepEqual(await idStamp(h, lost, b), { status: 409, body: { error: 'payment_used' } })
    const other = await h.knownPayment()
    assert.deepEqual(await idStamp(h, lost, b, other), { status: 402, body: { error: 'not_paid' } }, 'one person, one stamp')

    // A match to a session another payment opened counts.
    const elsewhere = await h.idSession(passedId('ida', doc('Pfeiffer')))
    const third = await h.idSession(passedId('ida', doc('Pfeiffer'), { matches: [{ vendorData: 'id-lost', sessionId: elsewhere }] }))
    assert.deepEqual(await idStamp(h, third, await stampNumber()), { status: 403, body: { error: 'duplicate_document' } })
  } finally {
    await h.verifier.close()
  }
})

test('a session gives its stamp to one stamp number, and again only within the hour after, on either check', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const { sessionId, stamp } = await face(h, 'alice', n1)
    const id = await h.idSession(passedId('bob', doc('Byron')))
    const idFirst = await idStamp(h, id, n1)
    assert.equal(idFirst.status, 200)
    assert.deepEqual(await faceStamp(h, sessionId, n2), { status: 409, body: { error: 'session_used' } }, 'for another stamp number')
    assert.deepEqual(await idStamp(h, id, n2), { status: 409, body: { error: 'session_used' } })

    // A retry within the hour: Didit's same decision, the same stamp.
    h.later(SIGNED_FOR_MS - 1)
    const faceAgain = await faceStamp(h, sessionId, n1)
    assert.deepEqual([faceAgain.status, faceAgain.body.stamp], [200, stamp], 'a lost answer, asked again')
    assert.deepEqual((await idStamp(h, id, n1)).body.stamp, idFirst.body.stamp)
    // The hour counts from the first signing: a retry gives no more time.
    h.later(1)
    // Didit down: had it been asked, the answer would be 502.
    h.faces.down = h.ids.down = true
    assert.deepEqual(await faceStamp(h, sessionId, n1), { status: 409, body: { error: 'session_used' } }, 'after the hour, used, before Didit is asked')
    assert.deepEqual(await idStamp(h, id, n1), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'the sweep deletes it, not the request')
  } finally {
    await h.verifier.close()
  }
})

test('two requests for one session at once, with two stamp numbers: one stamp, the other refused', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed('erin'))
    const release = h.faces.hold()
    const both = [faceStamp(h, sessionId, await stampNumber()), faceStamp(h, sessionId, await stampNumber())]
    while (h.faces.waiting < 2) await new Promise((r) => setImmediate(r))
    release()
    const statuses = (await Promise.all(both)).map((r) => r.status).sort()
    assert.deepEqual(statuses, [200, 409])
  } finally {
    await h.verifier.close()
  }
})

test('a face Didit has seen before is declined: face_seen, nothing kept; In Review is unfinished; the ID check only reports a face seen', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    for (const risk of ['DUPLICATED_FACE', 'POSSIBLE_DUPLICATED_FACE']) {
      const seen = await h.session(passed('known', { status: 'Declined', risks: ['LOW_FACE_QUALITY', risk] }))
      assert.deepEqual(await faceStamp(h, seen, n), { status: 403, body: { error: 'face_seen' } }, risk)
    }
    assert.deepEqual(await faceStamp(h, await h.session(passed('known', { status: 'Declined', risks: ['LIVENESS_FACE_ATTACK'] })), n), { status: 403, body: { error: 'declined' } }, 'declined for anything else')
    const review = await h.session(passed('known', { status: 'In Review', liveness: [{ status: 'In Review' }] }))
    assert.deepEqual(await faceStamp(h, review, n), { status: 403, body: { error: 'not_approved' } }, 'no one reviews: In Review is unfinished')
    assert.deepEqual(await stampBack(h, n), { status: 404, body: { error: 'not_found' } }, 'nothing kept')
    assert.equal((await faceStamp(h, await h.session(passed('new')), n)).status, 200)

    // The ID check's workflow takes no action on a face seen before: approved, it passes on its matches alone.
    const id = await h.idSession(passedId('ida', doc('Pfeiffer'), { risks: ['DUPLICATED_FACE'] }))
    assert.equal((await idStamp(h, id, n)).status, 200)
    const declined = await h.idSession(passedId('ida', doc('Pfeiffer'), { status: 'Declined', risks: ['DUPLICATED_FACE'] }))
    assert.deepEqual(await idStamp(h, declined, n), { status: 403, body: { error: 'declined' } }, 'face_seen is the face check’s')
  } finally {
    await h.verifier.close()
  }
})

test('the sweep deletes every session the verifier opened: an hour after its stamp, keeping its face template; any other a day after it opened, face and all', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const unfinished = await h.session(passed('known', { status: 'In Review', liveness: [{ status: 'In Review' }] }))
    assert.equal((await faceStamp(h, unfinished, n)).status, 403)
    const declined = await h.session(passed('gone', { status: 'Declined', risks: ['DUPLICATED_FACE'] }))
    assert.equal((await faceStamp(h, declined, n)).status, 403)
    const idDeclined = await h.idSession(passedId('ida', doc('Pfeiffer'), { status: 'Declined' }))
    assert.equal((await idStamp(h, idDeclined, n)).status, 403)
    const lost = await h.session(passed('lost'))

    const signed = await face(h, 'ana', n)
    const id = await h.idSession(passedId('ida', doc('Pfeiffer')))
    assert.equal((await idStamp(h, id, n)).status, 200)
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'nothing is deleted before the stamp is answered')

    h.later(SIGNED_FOR_MS - 1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'nor within the hour')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[signed.sessionId], [id]], 'a session that gave a stamp, once the hour is over')
    assert.deepEqual([h.faces.keptFaces, h.ids.keptFaces], [[signed.sessionId], [id]], 'keeping its face template')
    assert.deepEqual(h.logs, [], 'Didit kept each face template: nothing to say')
    assert.deepEqual(await faceStamp(h, signed.sessionId, n), { status: 409, body: { error: 'session_used' } })

    // A day after they opened: every other session, refused, unfinished or never asked, face and all.
    h.later(OPEN_FOR_MS - SIGNED_FOR_MS - 1)
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.length, 1, 'not before the day is over')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted.slice(1).sort(), h.ids.deleted], [[unfinished, declined, lost].sort(), [id, idDeclined]])
    assert.deepEqual([h.faces.keptFaces, h.ids.keptFaces], [[signed.sessionId], [id]], 'keeping nothing of them')
    assert.equal(h.faces.sessions.size + h.ids.sessions.size, 0, 'Didit has none of them')
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.length, 4, 'each once')

    // Didit not answering a deletion: the session stays for the next sweep.
    const m = await stampNumber()
    const later = await face(h, 'lena', m)
    h.later(SIGNED_FOR_MS)
    h.faces.deleteDown = true
    await h.verifier.sweep()
    assert.deepEqual(h.logs, ['verifier: 1 session could not be deleted in Didit, kept for the next sweep (Error)'], 'logged, without the session')
    h.faces.deleteDown = false
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.at(-1), later.sessionId)

    // Didit deleting a session without keeping the face template it was asked to keep: logged, by Didit's outcome only.
    h.faces.outcome = 'deleted'
    const mo = await face(h, 'mo', m)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: Didit kept no face template for a deleted session (deleted)')

    // The file names a session in clear only until Didit has deleted it.
    const pia = await face(h, 'pia', m)
    const open = await h.session(passed('quinn'))
    const payment = await h.paid()
    const idOpen = await h.idSession(passedId('rui', doc('Rui')), payment)
    await h.verifier.close()
    assertKept(h.dbPath, {
      sessions: [[signed.sessionId, n, 'face'], [id, n, 'id'], [later.sessionId, m, 'face'], [mo.sessionId, m, 'face'], [pia.sessionId, m, 'face']],
      toDelete: [pia.sessionId],
      opened: [[open, null], [idOpen, payment]],
      payments: [[h.paidFor.get(idDeclined)!, 1, false], [h.paidFor.get(id)!, ID_TRIES, true], [payment, 1, false]],
      never: [],
    })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('refusals, malformed requests, and Didit not answering', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const refused: [ReturnType<typeof passed>, string][] = [
      [passed('g', { workflowId: ID_WORKFLOW }), 'wrong_workflow'],
      [passed('g', { status: 'Declined' }), 'declined'],
      [passed('g', { status: 'Declined', risks: ['DUPLICATED_FACE'] }), 'face_seen'],
      [passed('g', { status: 'Expired' }), 'expired'],
      [passed('g', { status: 'Abandoned' }), 'expired'],
      [passed('g', { status: 'Not Started' }), 'not_approved'],
      [passed('g', { status: 'In Progress' }), 'not_approved'],
      [passed('g', { liveness: [] }), 'no_liveness'],
      [passed('g', { liveness: [{ status: 'Declined' }] }), 'liveness_not_passed'],
      [passed('g', { faceImage: null }), 'no_face'],
      [passed('none'), 'no_face'],
    ]
    for (const [decision, error] of refused) {
      assert.deepEqual(await faceStamp(h, await h.session(decision), await stampNumber()), { status: 403, body: { error } }, error)
    }
    assert.deepEqual(await faceStamp(h, '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a', n), { status: 403, body: { error: 'unknown_session' } })

    const idRefused: [Partial<ReturnType<typeof passed>>, string][] = [
      [{ workflowId: FACE_WORKFLOW }, 'wrong_workflow'],
      [{ status: 'Declined', documents: [{ status: 'Declined' }] }, 'declined'],
      [{ status: 'Expired' }, 'expired'],
      [{ documents: [] }, 'no_document'],
      [{ documents: [{ status: 'Declined' }] }, 'document_not_passed'],
      [{ faceMatches: [] }, 'no_face_match'],
      [{ faceMatches: [{ status: 'In Review' }] }, 'face_match_not_passed'],
      [{ document: null }, 'no_document_data'],
      [{ document: doc('x', { date_of_birth: '01/04/1990' }) }, 'no_document_data'],
      [{ document: doc('x', { date_of_birth: '1990-02-30' }) }, 'no_document_data'],
      [{ document: doc('', { first_name: '', full_name: ' ' }) }, 'no_document_data'],
      [{ faceImage: null }, 'no_face'],
    ]
    for (const [over, error] of idRefused) {
      const person = `p-${randomBytes(4).toString('hex')}`
      assert.deepEqual(await idStamp(h, await h.idSession(passedId(person, doc(person), over)), await stampNumber()), { status: 403, body: { error } }, error)
    }
    // A face session is not an ID session, and no payment opened it; and the other way round.
    assert.deepEqual(await idStamp(h, await h.session(passed('alice')), n, await h.knownPayment()), { status: 402, body: { error: 'not_paid' } })
    assert.deepEqual(await faceStamp(h, await h.idSession(passedId('alice')), n), { status: 403, body: { error: 'unknown_session' } })

    const sessionId = await h.session(passed('gina'))
    h.faces.down = true
    assert.deepEqual(await faceStamp(h, sessionId, n), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.down = false
    h.faces.photoDown = true
    assert.deepEqual(await faceStamp(h, sessionId, n), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.photoDown = false

    const bad: [unknown, number, string][] = [
      ['nope', 400, 'not_json'],
      [[1], 400, 'not_an_object'],
      [{ sessionId }, 400, 'expected_exactly_sessionId_and_stampNumber'],
      [{ sessionId, stampNumber: 5 }, 400, 'expected_exactly_sessionId_and_stampNumber'],
      [{ sessionId, stampNumber: '5', more: 1 }, 400, 'expected_exactly_sessionId_and_stampNumber'],
      [{ sessionId: 'x', stampNumber: '5' }, 400, 'bad_session_id'],
      [{ sessionId, stampNumber: '05' }, 400, 'bad_stamp_number'],
      [{ sessionId, stampNumber: '-5' }, 400, 'bad_stamp_number'],
      [{ sessionId, stampNumber: (2n ** 254n).toString() }, 400, 'bad_stamp_number'],
      [{ sessionId, stampNumber: 'x'.repeat(5000) }, 413, 'too_large'],
    ]
    for (const [body, status, error] of bad) assert.deepEqual(await h.post('/face/stamp', body), { status, body: { error } }, error)
    // The ID stamp takes the payment too.
    const payment = await h.knownPayment()
    const idBad: [unknown, number, string][] = [
      ['nope', 400, 'not_json'],
      [[1], 400, 'not_an_object'],
      [{ sessionId, stampNumber: '5' }, 400, 'expected_exactly_sessionId_and_stampNumber_and_payment'],
      [{ sessionId, stampNumber: '5', payment: 5 }, 400, 'expected_exactly_sessionId_and_stampNumber_and_payment'],
      [{ sessionId, stampNumber: '5', payment, more: 1 }, 400, 'expected_exactly_sessionId_and_stampNumber_and_payment'],
      [{ sessionId: 'x', stampNumber: '5', payment }, 400, 'bad_session_id'],
      [{ sessionId, stampNumber: '05', payment }, 400, 'bad_stamp_number'],
      [{ sessionId, stampNumber: '5', payment: 'pi_3Mtw' }, 400, 'bad_payment'],
      [{ sessionId, stampNumber: '5', payment: 'x'.repeat(5000) }, 413, 'too_large'],
    ]
    for (const [body, status, error] of idBad) assert.deepEqual(await h.post('/id/stamp', body), { status, body: { error } }, error)
    assert.deepEqual(await h.post('/face/session', { x: 1 }), { status: 400, body: { error: 'expected_empty_body' } })
    assert.deepEqual(await h.post('/nowhere'), { status: 404, body: { error: 'not_found' } })
    assert.deepEqual(await h.post('/verifier.json'), { status: 404, body: { error: 'not_found' } })
    assert.equal((await fetch(h.verifier.url + '/face/stamp')).status, 405)
    h.faces.down = true
    assert.deepEqual(await h.post('/face/session'), { status: 502, body: { error: 'face_check_unavailable' } })
  } finally {
    await h.verifier.close()
  }
})

test('the ID check is paid through Stripe: a Checkout page sending the person back to an app, then a session for a paid payment', async () => {
  const h = await start({ env: { APP_ORIGINS: 'https://app.example' } })
  try {
    const made = await h.post('/id/payment', { returnUrl: 'https://app.example/paid?for=id' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual(Object.keys(made.body).sort(), ['payment', 'url'])
    const { payment } = made.body
    assert.equal(h.payments.returnUrls.get(payment), 'https://app.example/paid?for=id', 'Stripe is told where to send the person back')
    for (const returnUrl of ['https://other.example/', 'not a url']) {
      assert.deepEqual(await h.post('/id/payment', { returnUrl }), { status: 400, body: { error: 'bad_return_url' } }, returnUrl)
    }
    for (const body of [{}, { returnUrl: 3 }, { returnUrl: 'https://app.example/', x: 1 }]) {
      assert.deepEqual(await h.post('/id/payment', body), { status: 400, body: { error: 'expected_exactly_returnUrl' } })
    }

    // Not paid yet: no session, and Stripe is asked again next time.
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 402, body: { error: 'not_paid' } })
    assert.deepEqual(await h.post('/id/session', { payment: 'cs_test_unknown' }), { status: 402, body: { error: 'not_paid' } }, 'one Stripe does not have')
    h.payments.pay(payment)
    const opened = await h.post('/id/session', { payment })
    assert.equal(opened.status, 201)
    assert.deepEqual([h.ids.created, h.faces.created], [1, 0], 'on the ID check’s Didit, and only there')
    assert.equal(h.payments.state(payment), 'held', 'paying only holds the $5')
    const asked = h.payments.asked
    assert.equal((await h.post('/id/session', { payment })).status, 201)
    assert.equal(h.payments.asked, asked + 1, 'Stripe is asked each time whether it still holds the money')

    // Didit not answering gives the try back.
    h.ids.down = true
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 502, body: { error: 'face_check_unavailable' } })
    h.ids.down = false
    assert.equal((await h.post('/id/session', { payment })).status, 201, `the try given back: ${ID_TRIES} sessions in all`)
    const asking = h.payments.asked
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 409, body: { error: 'payment_used' } }, 'no more tries')
    assert.equal(h.payments.asked, asking, 'nor a question to Stripe')
    assert.equal(h.ids.created, ID_TRIES)

    // One clock: a payment opens sessions only in its first day; a hold cancelled at Stripe opens none.
    const slow = await h.paid()
    assert.equal((await h.post('/id/session', { payment: slow })).status, 201)
    h.later(OPEN_FOR_MS - 1)
    assert.equal((await h.post('/id/session', { payment: slow })).status, 201, 'within its day')
    h.later(1)
    assert.deepEqual(await h.post('/id/session', { payment: slow }), { status: 402, body: { error: 'not_paid' } }, 'a day after it was held')
    const dropped = await h.paid()
    await h.payments.cancel(dropped)
    assert.deepEqual(await h.post('/id/session', { payment: dropped }), { status: 402, body: { error: 'not_paid' } }, 'its hold cancelled')
    assert.equal(h.ids.created, ID_TRIES + 2)

    const bad: [unknown, string][] = [
      [{}, 'expected_exactly_payment'],
      [{ payment: 5 }, 'expected_exactly_payment'],
      [{ payment, x: 1 }, 'expected_exactly_payment'],
      [{ payment, returnUrl: 5 }, 'expected_exactly_payment_and_returnUrl'],
      [{ payment, returnUrl: 'https://other.example/' }, 'bad_return_url'],
      [{ payment: 'pi_3Mtw' }, 'bad_payment'],
      [{ payment: 'cs_test_a/b' }, 'bad_payment'],
    ]
    for (const [body, error] of bad) assert.deepEqual(await h.post('/id/session', body), { status: 400, body: { error } }, error)

    const unasked = await h.paid()
    h.payments.down = true
    assert.deepEqual(await h.post('/id/payment', { returnUrl: 'https://app.example/' }), { status: 502, body: { error: 'payment_unavailable' } })
    assert.deepEqual(await h.post('/id/session', { payment: unasked }), { status: 502, body: { error: 'payment_unavailable' } })
    assert.equal(h.ids.created, ID_TRIES + 2, 'a refused request never reaches Didit')
  } finally {
    await h.verifier.close()
  }
})

test('one payment, one ID stamp, from a session it opened: a try that will never pass leaves the hold for the next, the last ends it, and a stamp takes it', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const payment = await h.paid()
    // Declined, then expired: two tries, and the payment still gives its stamp.
    const declined = await h.idSession(passedId('ada', doc('Lovelace'), { status: 'Declined' }), payment)
    assert.deepEqual(await idStamp(h, declined, n), { status: 403, body: { error: 'declined' } })
    const expired = await h.idSession(passedId('ada', doc('Lovelace'), { status: 'Expired' }), payment)
    assert.deepEqual(await idStamp(h, expired, n), { status: 403, body: { error: 'expired' } })
    assert.equal(h.payments.state(payment), 'held', 'its hold stays for the next try')
    const third = await h.idSession(passedId('ada', doc('Lovelace')), payment)
    const signed = await idStamp(h, third, n)
    assert.equal(signed.status, 200, JSON.stringify(signed.body))
    assert.equal(h.payments.state(payment), 'taken', 'a new stamp takes it')

    // Used up: no more sessions, and no stamp for any other session.
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 409, body: { error: 'payment_used' } })
    const other = await h.idSession(passedId('bea', doc('Brontë')))
    assert.deepEqual(await idStamp(h, other, await stampNumber(), payment), { status: 409, body: { error: 'payment_used' } }, 'one stamp a payment')
    // Sent again within its hour, the session gives the same stamp, and uses nothing.
    assert.deepEqual((await idStamp(h, third, n)).body, signed.body)

    // A payment Stripe was never asked about, or one that did not open the session: no stamp, and Didit is not asked.
    const sibling = await h.idSession(passedId('cy', doc('Twombly')))
    h.ids.down = true
    assert.deepEqual(await idStamp(h, other, await stampNumber(), await h.paid()), { status: 402, body: { error: 'not_paid' } })
    assert.deepEqual(await idStamp(h, other, await stampNumber(), h.paidFor.get(sibling)), { status: 402, body: { error: 'not_paid' } }, 'a session another payment opened')
    h.ids.down = false
    assert.equal((await idStamp(h, other, await stampNumber())).status, 200, 'with its own')

    // The last try refused ends the payment: its hold cancelled, at once.
    const last = await h.paid()
    for (let i = 0; i < ID_TRIES; i++) {
      const session = await h.idSession(passedId('dee', doc('Dee'), { status: 'Declined' }), last)
      assert.deepEqual(await idStamp(h, session, await stampNumber()), { status: 403, body: { error: 'declined' } })
      assert.equal(h.payments.state(last), i < ID_TRIES - 1 ? 'held' : 'cancelled', `try ${i + 1}`)
    }
    // Only its newest session ends it: an older one refused after the last was opened leaves the hold
    // for that one, which may still pass.
    const late = await h.paid()
    const lateTries = []
    for (let i = 0; i < ID_TRIES; i++) lateTries.push(await h.idSession(passedId('fay', doc('Fay'), { status: 'Declined' }), late))
    h.ids.set(lateTries.at(-1)!, passedId('fay', doc('Fay')))
    for (const older of lateTries.slice(0, -1)) assert.deepEqual(await idStamp(h, older, await stampNumber()), { status: 403, body: { error: 'declined' } })
    assert.equal(h.payments.state(late), 'held', 'an older try ends nothing')
    assert.equal((await idStamp(h, lateTries.at(-1)!, await stampNumber())).status, 200, 'and the newest gives its stamp')
    assert.equal(h.payments.state(late), 'taken')

    // An unfinished try, or a session that is none of the ID check's, ends nothing.
    const unfinished = await h.paid()
    const sessions = []
    for (let i = 0; i < ID_TRIES; i++) sessions.push(await h.idSession(passedId('eli', doc('Eli'), { status: 'In Progress' }), unfinished))
    assert.deepEqual(await idStamp(h, sessions.at(-1)!, n), { status: 403, body: { error: 'not_approved' } })
    h.ids.set(sessions.at(-1)!, passedId('eli', doc('Eli'), { workflowId: FACE_WORKFLOW }))
    assert.deepEqual(await idStamp(h, sessions.at(-1)!, n), { status: 403, body: { error: 'wrong_workflow' } })
    assert.equal(h.payments.state(unfinished), 'held')
    h.ids.set(sessions[0]!, passedId('eli', doc('Eli')))
    assert.equal((await idStamp(h, sessions[0]!, await stampNumber())).status, 200, 'and its first session, once done, gives its stamp')
  } finally {
    await h.verifier.close()
  }
})

test('Stripe or Didit failing a request: a 502, and one log line saying why by its status and codes alone, never its words, a key or an id', async () => {
  const h = await start({ env: { APP_ORIGINS: 'https://app.example' } })
  try {
    const unasked = await h.paid()
    const payment = await h.knownPayment()
    const sessionId = await h.session(passed('gina'))
    const n = await stampNumber()
    const unavailable = (error: string) => ({ status: 502, body: { error } })

    // Stripe refusing a new payment, as it refuses `payment_method_types`.
    h.payments.down = true
    h.payments.fail = new PaymentUnavailable('Stripe answered 400 to a new payment', { status: 400, codes: ['invalid_request_error', 'payment_method_types_no_longer_supported', 'payment_method_types'] })
    assert.deepEqual(await h.post('/id/payment', { returnUrl: 'https://app.example/' }), unavailable('payment_unavailable'))
    // Stripe refusing the key, asked about a payment: of what it sent, only what is a code.
    const sent = ['invalid_request_error', 'Invalid API Key provided: sk_test_****ndin', 'sk_test_51standin', `sk_test_${'a'.repeat(99)}`, unasked, sessionId, 'X', 'a'.repeat(65), { code: 'x' }]
    h.payments.fail = new PaymentUnavailable('Stripe answered 401 to a payment', { status: 401, codes: sent })
    assert.deepEqual(await h.post('/id/session', { payment: unasked }), unavailable('payment_unavailable'))
    // Stripe not reached: the error's kind alone.
    h.payments.fail = new PaymentUnavailable('Stripe could not be reached')
    assert.deepEqual(await h.post('/id/session', { payment: unasked }), unavailable('payment_unavailable'))
    h.payments.down = false

    // Didit refusing to open a session, then to say what one decided; the photo's address refusing.
    h.faces.down = true
    h.faces.fail = new DiditUnavailable('Didit answered 402 to a new session', { status: 402, codes: ['insufficient_credits'] })
    assert.deepEqual(await h.post('/face/session'), unavailable('face_check_unavailable'))
    h.faces.fail = new DiditUnavailable('Didit answered 401 to a decision', { status: 401, codes: [sessionId] })
    assert.deepEqual(await faceStamp(h, sessionId, n), unavailable('face_check_unavailable'))
    h.faces.down = false
    h.faces.photoDown = true
    h.faces.fail = new DiditUnavailable("the photo's address answered 403", { status: 403 })
    assert.deepEqual(await faceStamp(h, sessionId, n), unavailable('face_check_unavailable'))
    h.faces.photoDown = false
    // Anything else thrown: its kind alone.
    h.ids.down = true
    assert.deepEqual(await h.post('/id/session', { payment }), unavailable('face_check_unavailable'))
    h.ids.down = false

    assert.deepEqual(h.logs, [
      'verifier: payment_unavailable (PaymentUnavailable 400 invalid_request_error payment_method_types_no_longer_supported payment_method_types)',
      'verifier: payment_unavailable (PaymentUnavailable 401 invalid_request_error)',
      'verifier: payment_unavailable (PaymentUnavailable)',
      'verifier: face_check_unavailable (DiditUnavailable 402 insufficient_credits)',
      'verifier: face_check_unavailable (DiditUnavailable 401)',
      'verifier: face_check_unavailable (DiditUnavailable 403)',
      'verifier: face_check_unavailable (Error)',
    ], 'one line for each')

    // The sweep says why the last deletion Didit refused failed, the same way.
    h.faces.fail = new DiditUnavailable('Didit answered 503 to a deletion', { status: 503 })
    await face(h, 'hana', await stampNumber())
    h.later(SIGNED_FOR_MS)
    h.faces.deleteDown = true
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: 1 session could not be deleted in Didit, kept for the next sweep (DiditUnavailable 503)')
    h.faces.deleteDown = false

    // Stripe failing to take a hold: a 502, and nothing used; the same session, asked again, takes it.
    const held = await h.paid()
    const taking = await h.idSession(passedId('ivo', doc('Ivo')), held)
    const m = await stampNumber()
    h.payments.down = true
    h.payments.fail = new PaymentUnavailable('Stripe answered 500 to a capture', { status: 500, codes: ['api_error'] })
    assert.deepEqual(await idStamp(h, taking, m), unavailable('payment_unavailable'))
    assert.equal(h.logs.at(-1), 'verifier: payment_unavailable (PaymentUnavailable 500 api_error)')
    assert.equal(h.payments.state(held), 'held')
    h.payments.down = false
    assert.equal((await idStamp(h, taking, m)).status, 200)
    // Failing to cancel one: the refusal still answered, and the hold left for the hourly search.
    h.ids.users.set('id-ivo', { fullName: 'Ada Ivo', birth: '1990-04-01' })
    const again = await h.idSession(passedId('ivo', doc('Ivo'), { matches: [{ vendorData: 'id-ivo', sessionId: null }] }))
    h.payments.down = true
    assert.deepEqual(await idStamp(h, again, await stampNumber()), { status: 403, body: { error: 'duplicate_document' } })
    assert.equal(h.logs.at(-1), 'verifier: a hold could not be cancelled at Stripe, left for the hourly search (PaymentUnavailable 500 api_error)')
    // Failing the search for old holds: logged, and tried again at the next sweep, not an hour later.
    h.later(HOLDS_EVERY_MS)
    const searched = h.payments.searched.length
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: the search for old holds failed, tried again at the next sweep (PaymentUnavailable 500 api_error)')
    h.payments.down = false
    await h.verifier.sweep()
    assert.equal(h.payments.searched.length, searched + 1)
  } finally {
    await h.verifier.close()
  }
})

test('without Stripe the ID check is not for sale; the face check is free', async () => {
  const h = await start({ forSale: false, env: { APP_ORIGINS: 'https://app.example' } })
  try {
    for (const [path, body] of [
      ['/id/payment', { returnUrl: 'https://app.example/' }],
      ['/id/session', { payment: 'cs_test_a1' }],
      ['/id/stamp', { sessionId: '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a', stampNumber: '5', payment: 'cs_test_a1' }],
    ] as const) {
      assert.deepEqual(await h.post(path, body), { status: 503, body: { error: 'not_for_sale' } }, path)
    }
    assert.equal(h.ids.created, 0)
    assert.equal((await face(h, 'alice', await stampNumber())).stamp.verifier, h.verifier.keys.face)
  } finally {
    await h.verifier.close()
  }
})

test('the file keeps which session gave which stamp number and which check it was, and the stamp it signed: nothing of who the person is', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const a = await face(h, 'alice', n1)
    const b = await face(h, 'bob', n2)
    const id = await h.idSession(passedId('alice', doc('Lovelace', { 'extra_fields.profession': 'Analyst' })))
    const res = await idStamp(h, id, n1)
    assert.equal(res.status, 200)
    // A later check for the same stamp number gives the first stamp back, and writes nothing of its own document either.
    const later = await h.idSession(passedId('alice', doc('Lovelace', { document_number: 'CD7654321', place_of_birth: 'Marylebone' })))
    assert.deepEqual((await idStamp(h, later, n1)).body.stamp, own(res.body.stamp))
    const open = await h.knownPayment()
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()

    assertKept(h.dbPath, {
      sessions: [[a.sessionId, n1, 'face'], [b.sessionId, n2, 'face'], [id, n1, 'id'], [later, n1, 'id']],
      // A payment beside the session it opened only while it is open, and that session not yet deleted.
      opened: [[h.sessionsOf(open)[0]!, open]],
      // Of a payment, its hash, its tries and whether it is used up: nothing beside a stamp number.
      payments: [[h.paidFor.get(id)!, ID_TRIES, true], [h.paidFor.get(later)!, ID_TRIES, true], [open, 1, false]],
      // The stamp's facts and signature are kept; the fields beside it are not, nor any of them.
      never: [
        ...['Lovelace', 'lovelace', '1990-04-01', 'AB1234567', 'CD7654321', '12 St James Square', 'Marylebone', 'Analyst', 'date_of_birth', 'document_number'],
        ...['test-model', a.stamp.embedding, res.body.stamp.embedding, res.body.stamp.fields],
      ],
    })
    assert.equal(readFileSync(h.dbPath).includes(Buffer.from(faceOf('alice'))), false, 'no embedding')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a stamp asked back by its stamp number is the one signed, its own fields only, for both keys, and after its session is deleted in Didit', async () => {
  const dbPath = join(tempDir(), 'verifier.sqlite')
  let h = await start({ dbPath })
  try {
    const [n, m] = [await stampNumber(), await stampNumber()]
    const signedFace = await face(h, 'alice', n)
    const id = await h.idSession(passedId('alice', doc('Lovelace')))
    const signedId = await idStamp(h, id, n)
    assert.equal(signedId.status, 200)
    const back = await stampBack(h, n)
    assert.equal(back.status, 200)
    assert.deepEqual(back.body, { face: own(signedFace.stamp), id: own(signedId.body.stamp) }, 'each the one signed, without the fields beside it')
    for (const stamp of [back.body.face, back.body.id]) assert.deepEqual(Object.keys(stamp).sort(), ['facts', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const published = await about(h)
    assert.deepEqual([back.body.face.verifier, back.body.id.verifier], [published.face.key, published.id.key])
    assert.ok(stampSigned(stampFromJson(back.body.face)) && stampSigned(stampFromJson(back.body.id)))

    // A number with a face stamp only: no ID stamp.
    const bob = await face(h, 'bob', m)
    assert.deepEqual((await stampBack(h, m)).body, { face: own(bob.stamp), id: null })
    // A later check for the same number answers its own stamp; the first stays the one handed back.
    const later = await face(h, 'carol', n)
    assert.notEqual(later.stamp.facts, signedFace.stamp.facts)
    assert.deepEqual((await stampBack(h, n)).body, back.body)

    // The sessions deleted in Didit, and the verifier started again on the same file: the stamps still come back.
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted.sort(), h.ids.deleted], [[signedFace.sessionId, bob.sessionId, later.sessionId].sort(), [id]])
    assert.deepEqual(h.logs, [], 'nothing is logged')
    await h.verifier.close()
    h = await start({ dbPath })
    assert.deepEqual(await stampBack(h, n), back)
    assert.deepEqual(h.logs, [])
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('at start, a kept ID stamp the ID key did not sign is forgotten, and its stamp number’s next ID check keeps a new one', async () => {
  const seed = seedJson()
  const dbPath = join(tempDir(), 'verifier.sqlite')
  const n = await stampNumber()
  // An ID stamp kept for n from the key the text `id` derives, the recipe before this one.
  const file = new Store(dbPath)
  const before = signStamp(await hkdf(seed.bytes, 'id'), { stampNumber: n, facts: 5n, verifierName: VERIFIER_NAME })
  assert.equal(file.remember({ sessionId: randomUUID(), stampNumber: n, kind: 'id', since: 0, signedAt: Date.now(), stamp: before }), 'ok')
  file.close()

  let h = await start({ seed: seed.json, dbPath })
  try {
    assert.deepEqual(await stampBack(h, n), { status: 404, body: { error: 'not_found' } }, 'forgotten')
    const signedFace = await face(h, 'ada', n)
    const res = await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace'))), n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.stamp.verifier, h.verifier.keys.id)
    assert.notEqual(res.body.stamp.facts, '5')
    assert.deepEqual(JSON.parse(res.body.stamp.fields), doc('Lovelace'), 'a new stamp, with its fields')
    assert.ok(stampSigned(stampFromJson(res.body.stamp)))

    // Started again: the stamps its own keys signed stay.
    await h.verifier.close()
    h = await start({ dbPath })
    assert.deepEqual((await stampBack(h, n)).body, { face: own(signedFace.stamp), id: own(res.body.stamp) })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a stamp number nothing was signed for is 404, and a body with any other field is refused', async () => {
  const h = await start()
  try {
    assert.deepEqual(await stampBack(h, await stampNumber()), { status: 404, body: { error: 'not_found' } })
    const bad: [unknown, number, string][] = [
      ['nope', 400, 'not_json'],
      [{}, 400, 'expected_exactly_stampNumber'],
      [{ stampNumber: 5 }, 400, 'expected_exactly_stampNumber'],
      [{ stampNumber: '5', sessionId: '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a' }, 400, 'expected_exactly_stampNumber'],
      [{ stampNumber: '05' }, 400, 'bad_stamp_number'],
      [{ stampNumber: (2n ** 254n).toString() }, 400, 'bad_stamp_number'],
    ]
    for (const [body, status, error] of bad) assert.deepEqual(await h.post('/stamp', body), { status, body: { error } }, error)
    assert.equal((await fetch(h.verifier.url + '/stamp')).status, 405)
  } finally {
    await h.verifier.close()
  }
})

test('the configuration names what is missing', () => {
  assert.throws(() => readConfig({}), /missing environment variables: DIDIT_FACE_API_KEY, DIDIT_FACE_WORKFLOW_ID, DIDIT_ID_API_KEY, DIDIT_ID_WORKFLOW_ID$/)
  assert.throws(() => readConfig({ DIDIT_API_KEY: 'k', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_WORKFLOW_ID: 'i' }), /DIDIT_FACE_API_KEY, DIDIT_ID_API_KEY$/, 'one key for each check’s application')
  const base = { DIDIT_FACE_API_KEY: 'kf', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_API_KEY: 'ki', DIDIT_ID_WORKFLOW_ID: 'i' }
  const config = readConfig(base)
  assert.deepEqual([config.diditFaceApiKey, config.diditIdApiKey], ['kf', 'ki'])
  assert.equal(config.verifierName, 'verifier.forest.foundation', 'the name, unless told otherwise')
  assert.equal(readConfig({ ...base, VERIFIER_NAME }).verifierName, VERIFIER_NAME)
  assert.equal(config.diditBaseUrl, 'https://verification.didit.me')
  assert.equal(config.faceModel, 'sface')

  // The stand-in embedding is for a stand-in Didit on this machine, and nowhere else.
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in' }), /FACE_MODEL=stand-in is for a stand-in Didit on this machine only/)
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'https://didit.example' }), /stand-in/)
  assert.equal(readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'http://127.0.0.1:8090' }).faceModel, 'stand-in')
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'other' }), /FACE_MODEL is sface or stand-in/)

  // The gifts: none unless the host is named; ten credits with a face stamp and a hundred with an ID
  // stamp unless set; none at 0.
  const host = { ...base, HOST_URL: 'https://host.example' }
  assert.equal(config.gift, undefined)
  assert.deepEqual(readConfig(host).gift, { origin: 'https://host.example', credits: { face: 10, id: 100 } })
  assert.deepEqual(readConfig({ ...host, FACE_CREDITS: '20', ID_CREDITS: '0' }).gift, { origin: 'https://host.example', credits: { face: 20, id: 0 } })
  assert.equal(readConfig({ ...host, FACE_CREDITS: '0', ID_CREDITS: '0' }).gift, undefined)
  assert.throws(() => readConfig({ ...base, HOST_URL: 'https://host.example/' }), /HOST_URL is an origin/)
  assert.throws(() => readConfig({ ...host, FACE_CREDITS: '-1' }), /FACE_CREDITS/)
  assert.throws(() => readConfig({ ...host, ID_CREDITS: 'many' }), /ID_CREDITS/)

  // The apps a person may be sent back to: none unless named, each an origin.
  assert.deepEqual(config.appOrigins, [])
  assert.deepEqual(readConfig({ ...base, APP_ORIGINS: 'https://app.example, http://localhost:5173' }).appOrigins, ['https://app.example', 'http://localhost:5173'])
  assert.throws(() => readConfig({ ...base, APP_ORIGINS: 'https://app.example/' }), /APP_ORIGINS is an origin/)
  assert.throws(() => readConfig({ ...base, APP_ORIGINS: 'app.example' }), /APP_ORIGINS is an origin/)

  // Stripe: with its key the ID check is for sale, for the Price named; the Price alone sells nothing;
  // the key is never quoted.
  const price = 'price_1UXRbDILoxkbMfX4cfwRfCOI'
  assert.equal(config.stripe, undefined)
  assert.equal(readConfig({ ...base, STRIPE_ID_PRICE: price }).stripe, undefined)
  for (const key of ['sk_test_51abc', 'rk_test_51abc', 'sk_live_51abc', 'rk_live_51abc']) {
    assert.deepEqual(readConfig({ ...base, STRIPE_SECRET_KEY: key, STRIPE_ID_PRICE: price }).stripe, { secretKey: key, price })
  }
  assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_51abc' }), /STRIPE_SECRET_KEY needs STRIPE_ID_PRICE/)
  assert.throws(
    () => readConfig({ ...base, STRIPE_SECRET_KEY: 'pk_test_51secret', STRIPE_ID_PRICE: price }),
    (error: Error) => /STRIPE_SECRET_KEY is a Stripe secret key/.test(error.message) && !error.message.includes('51secret'),
  )
  assert.throws(() => readConfig({ ...base, STRIPE_ID_PRICE: 'prod_VYYiTk7BVWOSdv' }), /STRIPE_ID_PRICE is a Stripe Price/)
})

/** The host's own seller, taking the verifier's sponsor key. */
async function hostSeller(sponsor: string) {
  const pkcs8 = new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))
  const origin = 'https://host.example'
  const seller = hostCredits.seller({ origin, key: await hostCredits.keyFrom(pkcs8), requestUri: '/credits/buy', price: '0.01', maxBuy: 1000, sponsors: [sponsor], path: ':memory:' })
  return { seller, service: serviceOf(origin, seller.directory()) }
}

test('the gifts: at a stamp number’s first stamp from each check, a sponsor’s ticket for the app’s host buy, which the host collects; the verifier pays nothing', async () => {
  const seed = seedJson()
  const sponsor = (await seedFrom(seed.bytes).ed25519(INFO.sponsor)).address
  const host = await hostSeller(sponsor)
  const h = await start({ seed: seed.json, env: { HOST_URL: 'https://host.example', FACE_CREDITS: '5', ID_CREDITS: '7' } })
  try {
    // GET / says what each gift holds, so the app knows what to buy.
    assert.deepEqual((await about(h)).gift, { face: 5, host: 'https://host.example', id: 7, sponsor })
    const stamp = (sessionId: string, n: bigint, gift: unknown) => h.post('/face/stamp', { sessionId, stampNumber: n.toString(), gift })

    const n = await stampNumber()
    const sessionId = await h.session(passed('alice'))
    const mine = await buy(host.service, 5)
    const first = await stamp(sessionId, n, mine.reference)
    assert.equal(first.status, 200)
    assert.ok(stampSigned(stampFromJson(first.body.stamp)))
    const { ticket } = first.body.gift
    assert.equal(ticket.split('.')[0], sponsor, 'it names the sponsor')

    // The host takes the ticket, from the sponsor it lists, and the app finishes the credits.
    const answered = await host.seller.collect(mine.buy, `ticket ${ticket}`)
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.equal((await finish(mine.pending, answered.body as Uint8Array)).length, 5)
    assert.deepEqual(host.seller.bill(), { [sponsor]: 5 }, 'the host bills the sponsor')

    // Once a stamp number: the same buy again, the same ticket (a retry within the session's hour);
    // another buy, none.
    const again = await stamp(sessionId, n, mine.reference)
    assert.deepEqual([again.status, again.body.gift], [200, first.body.gift], 'a retry: the same ticket')
    assert.deepEqual((await stamp(sessionId, n, (await buy(host.service, 5)).reference)).body.gift, { error: 'given' })

    // Anything but a buy's reference; a buy of more credits than the gift gives is not paid.
    const m = await stampNumber()
    const bob = await h.session(passed('bob'))
    const bobStamp = async (gift?: unknown) => {
      const res = await h.post('/face/stamp', { sessionId: bob, stampNumber: m.toString(), ...(gift !== undefined && { gift }) })
      assert.equal(res.status, 200)
      return res.body
    }
    assert.deepEqual((await bobStamp('nope')).gift, { error: 'bad_gift' })
    assert.deepEqual((await bobStamp({ host: mine.reference })).gift, { error: 'bad_gift' })
    const six = await buy(host.service, 6)
    const tickets = (await bobStamp(six.reference)).gift
    assert.equal((await host.seller.collect(six.buy, `ticket ${tickets.ticket}`)).status, 402, 'a buy of more credits than the ticket gives is not paid')

    // The stamp is never held back by the gift; none asked, none answered.
    assert.equal((await bobStamp()).gift, undefined)

    // The ID stamp's gift is its own: once a stamp number, though the face check gave one.
    const id = await h.idSession(passedId('bob', doc('Byron')))
    const seven = await buy(host.service, 7)
    const payment = h.paidFor.get(id)
    const idStamp = await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), payment, gift: seven.reference })
    assert.equal(idStamp.status, 200)
    assert.equal(idStamp.body.gift.ticket.split('.')[1], '7', 'the ID check’s credits')
    const paid = await host.seller.collect(seven.buy, `ticket ${idStamp.body.gift.ticket}`)
    assert.equal((await finish(seven.pending, paid.body as Uint8Array)).length, 7)
    assert.deepEqual((await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), payment, gift: (await buy(host.service, 7)).reference })).body.gift, { error: 'given' })
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()
    assertKept(h.dbPath, { sessions: [[sessionId, n, 'face'], [bob, m, 'face'], [id, m, 'id']], gifts: [n, m], idGifts: [m], payments: [[payment!, ID_TRIES, true]], never: [mine.reference, six.reference, seven.reference, ticket] })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('with no gift, a stamp asked for with one is refused; so is one from a check whose gift is 0', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed('alice'))
    const res = await h.post('/face/stamp', { sessionId, stampNumber: (await stampNumber()).toString(), gift: 'x' })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_stampNumber' }])
    assert.equal((await about(h)).gift, undefined)
  } finally {
    await h.verifier.close()
  }
  // A check whose gift is 0 gives none, and refuses its stamp asked with one, the same way.
  const faceOnly = await start({ env: { HOST_URL: 'https://host.example', ID_CREDITS: '0' } })
  try {
    const id = await faceOnly.idSession(passedId('ada', doc('Lovelace')))
    const res = await faceOnly.post('/id/stamp', { sessionId: id, stampNumber: (await stampNumber()).toString(), payment: faceOnly.paidFor.get(id), gift: 'x' })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_stampNumber_and_payment' }])
    assert.equal((await about(faceOnly)).gift.id, 0)
  } finally {
    await faceOnly.verifier.close()
  }
})

test('the seed: made on the first start beside the database, kept there, the same on every start after', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'verifier.sqlite')
  const seedFile = join(dir, SEED_FILE)
  const first = await start({ dbPath })
  let published: string
  try {
    assert.equal(first.verifier.madeSeed, true, 'no seed beside the database: one is made')
    published = await (await fetch(first.verifier.url + '/')).text()
  } finally {
    await first.verifier.close()
  }
  assert.equal(statSync(seedFile).mode & 0o777, 0o600, 'readable by this user only')
  const contents = readFileSync(seedFile, 'utf8')
  assert.match(contents, /^\{"seed":"[0-9a-f]{64}"\}$/)
  const seed = parseSeed(contents, 'the seed file')
  assert.equal(JSON.parse(published).face.key, serviceKey(await seed.mix('face')).address, 'GET / names the face key mixed from it')
  assert.equal(JSON.parse(published).id.key, serviceKey(await seed.mix('id-fields')).address, 'and the ID key')
  assert.deepEqual(first.logs, [], 'and the seed is never logged')

  const second = await start({ dbPath })
  try {
    assert.equal(second.verifier.madeSeed, false)
    assert.equal(await (await fetch(second.verifier.url + '/')).text(), published, 'the same verifier')
  } finally {
    await second.verifier.close()
  }
  assert.equal(readFileSync(seedFile, 'utf8'), contents, 'the file is never written again')

  // A seed file that is no seed stops the verifier, with a message that quotes none of it.
  const hexText = JSON.parse(contents).seed as string
  for (const text of [contents.slice(0, 40), JSON.stringify({ seed: hexText.slice(0, 62) }), JSON.stringify({ seed: hexText, more: 1 }), JSON.stringify({ seed: hexText.toUpperCase() })]) {
    await assert.rejects(
      () => start({ seed: text }),
      (error: Error) => /^the seed file .* is not the verifier's seed/.test(error.message) && !error.message.includes(hexText.slice(4, 20)),
    )
  }
})

test('a check sends the person back only to an app the verifier names in APP_ORIGINS', async () => {
  const h = await start({ env: { APP_ORIGINS: 'https://app.example' } })
  try {
    const opened = await h.post('/face/session', { returnUrl: 'https://app.example/checked?from=face' })
    assert.equal(opened.status, 201)
    assert.equal(h.faces.callbacks.get(opened.body.sessionId), 'https://app.example/checked?from=face', 'Didit is told where to send the person back')
    assert.equal(h.faces.callbacks.get((await h.post('/face/session')).body.sessionId), undefined, 'none asked, none sent')
    for (const returnUrl of ['https://other.example/', 'http://app.example/', 'https://app.example.evil/', 'not a url']) {
      assert.deepEqual(await h.post('/face/session', { returnUrl }), { status: 400, body: { error: 'bad_return_url' } }, returnUrl)
    }
    assert.deepEqual(await h.post('/face/session', { returnUrl: 3 }), { status: 400, body: { error: 'expected_exactly_returnUrl' } })
    assert.deepEqual(await h.post('/face/session', { returnUrl: 'https://app.example/', x: 1 }), { status: 400, body: { error: 'expected_exactly_returnUrl' } })
    assert.equal(h.faces.created, 2, 'a refused request never reaches Didit')
    // The ID check, the same way, and its payment's page too.
    const payment = await h.paid()
    const id = await h.post('/id/session', { payment, returnUrl: 'https://app.example/checked?from=id' })
    assert.equal(id.status, 201)
    assert.equal(h.ids.callbacks.get(id.body.sessionId), 'https://app.example/checked?from=id')
    assert.deepEqual(await h.post('/id/session', { payment, returnUrl: 'https://other.example/' }), { status: 400, body: { error: 'bad_return_url' } })
    assert.equal(h.ids.created, 1)
    assert.deepEqual(await h.post('/id/payment', { returnUrl: 'https://app.example.evil/' }), { status: 400, body: { error: 'bad_return_url' } })
  } finally {
    await h.verifier.close()
  }
  const none = await start()
  try {
    assert.deepEqual(await none.post('/face/session', { returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_return_url' } }, 'with no APP_ORIGINS, no return URL is taken')
    assert.deepEqual(await none.post('/id/payment', { returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_return_url' } }, 'so no payment page either')
  } finally {
    await none.verifier.close()
  }
})

test('the stand-in for tests: test/fake-didit.ts and the stand-in embedding, both checks for two people, and a face seen before', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const fake = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, 'fake-didit.ts')], {
    env: { ...process.env, FAKE_DIDIT_PORT: String(port), FAKE_DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW, FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve) => fake.stdout!.once('data', () => resolve()))
  const baseUrl = `http://127.0.0.1:${port}`
  const config = readConfig({
    VERIFIER_NAME,
    DIDIT_FACE_API_KEY: 'fake-didit',
    DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
    DIDIT_ID_API_KEY: 'fake-didit',
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DIDIT_BASE_URL: baseUrl,
    FACE_MODEL: 'stand-in',
    DATABASE_PATH: join(tempDir(), 'verifier.sqlite'),
    PORT: '0',
  })
  const didit = new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, check: 'face', baseUrl })
  let clock = Date.now()
  const payments = new FakePayments()
  const verifier = await startVerifier(config, { log: () => {}, now: () => clock, payments })
  const seen = await startVerifier(
    { ...config, databasePath: join(tempDir(), 'verifier.sqlite') },
    { faceCheck: new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, check: 'face', baseUrl, scenario: 'decline_duplicated_face' }), log: () => {}, now: () => clock },
  )
  try {
    const post = async (at: Verifier, path: string, body: unknown = {}) => {
      const res = await fetch(at.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    const signedFaces: string[] = []
    for (let person = 0; person < 2; person++) {
      const n = await stampNumber()
      const face = await post(verifier, '/face/session')
      signedFaces.push(face.body.sessionId)
      const faceStamp = await post(verifier, '/face/stamp', { sessionId: face.body.sessionId, stampNumber: n.toString() })
      assert.equal(faceStamp.status, 200, JSON.stringify(faceStamp.body))
      assert.equal(faceStamp.body.stamp.model, 'stand-in')
      assert.equal(faceStamp.body.stamp.verifier, verifier.keys.face)
      assert.ok(stampSigned(stampFromJson(faceStamp.body.stamp)))
      assert.equal((await didit.decision(face.body.sessionId))?.status, 'Approved', 'still in Didit once its stamp is signed')
      const again = await post(verifier, '/face/stamp', { sessionId: face.body.sessionId, stampNumber: n.toString() })
      assert.deepEqual(again.body.stamp, faceStamp.body.stamp, 'within the hour, the same stamp')
      const { payment } = await payments.checkout('https://app.example/paid')
      payments.pay(payment)
      const id = await post(verifier, '/id/session', { payment })
      assert.equal(id.status, 201, JSON.stringify(id.body))
      const idStamp = await post(verifier, '/id/stamp', { sessionId: id.body.sessionId, stampNumber: n.toString(), payment })
      assert.equal(idStamp.status, 200, JSON.stringify(idStamp.body))
      assert.equal(idStamp.body.stamp.verifier, verifier.keys.id)
      const fields = JSON.parse(idStamp.body.stamp.fields)
      assert.deepEqual([fields.date_of_birth, fields.issuing_state], ['1990-01-01', 'GBR'])
      assert.equal(stampFromJson(idStamp.body.stamp).facts, idFacts('stand-in', b64u.decode(idStamp.body.stamp.embedding), fields))
      assert.ok(stampSigned(stampFromJson(idStamp.body.stamp)))
    }
    // An hour on, the sweep deletes every signed session in Didit, asking it to keep the face template.
    clock += SIGNED_FOR_MS
    await verifier.sweep()
    assert.deepEqual(await didit.decision(signedFaces[0]!), null, 'deleted in Didit')
    assert.deepEqual(await post(verifier, '/face/stamp', { sessionId: signedFaces[0], stampNumber: (await stampNumber()).toString() }), { status: 409, body: { error: 'session_used' } })

    // A session opened with a scenario declining a face seen before: `face_seen`, and a day after it
    // opened the sweep deletes it in Didit.
    const declined = await post(seen, '/face/session')
    assert.deepEqual(await post(seen, '/face/stamp', { sessionId: declined.body.sessionId, stampNumber: (await stampNumber()).toString() }), { status: 403, body: { error: 'face_seen' } })
    assert.equal((await didit.decision(declined.body.sessionId))?.status, 'Declined')
    clock += OPEN_FOR_MS
    await seen.sweep()
    assert.equal(await didit.decision(declined.body.sessionId), null, 'deleted in Didit')
  } finally {
    await verifier.close()
    await seen.close()
    fake.kill()
  }
})
