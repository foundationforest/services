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
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { hkdf, seedNumber, serviceKey, stampNumberOf } from '@foundationforest/keys'
import { checkFacts, checkVerification, factListOf, factsNumber, proveFacts, proveVerification, signStamp, stampFromJson, stampSigned, stampToJson, toBytes32 } from '@foundationforest/proofs'
import { b64u, canonical, parseCanonical } from '@foundationforest/folders'

import { buy, finish, serviceOf } from '../../host/client/client.ts'
import * as hostCredits from '../../host/credits/seller.ts'

import { PAYMENT_DONE } from '../src/codes.ts'
import { DiditClient, DiditUnavailable, type Decision, stampHash } from '../src/didit.ts'
import { ID_FACTS, RECIPE, faceList, idList, saltsOf } from '../src/facts.ts'
import { INFO, SEED_FILE, parseSeed, seedFrom } from '../src/seed.ts'
import { DELETE_AFTER_MS, DELETED_KEPT_MS, FACE_KEPT_MS, HOLD_FOR_MS, HOLDS_EVERY_MS, OPEN_FOR_MS, PAYMENT_KEPT_MS, SIGNED_FOR_MS, lockPayment } from '../src/server.ts'
import { AGREE, CANCEL_RIGHT, CONSENT, DELETION, FACE_CONSENT, readConfig, startVerifier, type Verifier } from '../src/service.ts'
import { FACE_TRIES, ID_TRIES, Store } from '../src/store.ts'
import { type Payments, PaymentUnavailable, StripeClient } from '../src/stripe.ts'
import {
  FACE_WORKFLOW,
  PRICES,
  FakeApplication,
  FakeFaceCheck,
  FakePayments,
  ID_WORKFLOW,
  VERIFIER_NAME,
  assertKept,
  checkoutOf,
  doc,
  faceOf,
  namedFaces,
  stampNumber,
  passed,
  passedId,
  refusedWith,
  seedJson,
} from './fakes.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** The verification circuit's setup files, committed in the standard. */
const setupOf = (circuit: string) => ({ wasm: join(here, `../../standard/proofs/${circuit}/setup/${circuit}.wasm`), zkey: join(here, `../../standard/proofs/${circuit}/setup/${circuit}.zkey`) })
const ARTIFACTS = setupOf('verification')

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
  /** The face check's Didit, in the application it shares with the ID check's. */
  faces: FakeFaceCheck
  /** The ID check's Didit. */
  ids: FakeFaceCheck
  /** Stripe. */
  payments: FakePayments
  /** The payment each ID session was opened with, as the verifier answered it. */
  paidFor: Map<string, string>
  /** The ID sessions a payment opened, in order. */
  sessionsOf(payment: string): string[]
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new face session for stamp number `n`, whose check came to `decision`; returns its id. */
  session(decision: Decision, n: bigint): Promise<string>
  /** A payment for stamp number `n`, as `POST /id/payment` answers it, paid at Stripe, not yet sent to the verifier's other routes. */
  paid(n: bigint): Promise<string>
  /** A payment that opened an ID session, for a stamp number of its own, so the verifier knows it was paid, and gave no stamp. */
  knownPayment(): Promise<string>
  /** A new ID session for stamp number `n`, whose check came to `decision`, opened with `payment`, which must be `n`'s, or a new one; returns its id. */
  idSession(decision: Decision, n: bigint, payment?: string): Promise<string>
  /**
   * Forgets every stamp number's free face tries, by hand, in the file: the tries are their own test,
   * and the judging tests run many refused face checks on one stamp number.
   */
  forgetTries(): void
  /** Moves the verifier's clock on. */
  later(ms: number): void
  /** The verifier's clock. */
  now(): number
}

/**
 * The verifier, with `seed` in its seed file beside the database when given; with none there, it
 * makes one. Its ID check is for sale, through a stand-in Stripe (its Prices unknown while
 * `pricesDown`), unless `forSale` is false: then through `payments` if given, and otherwise not. It
 * sends people back to https://app.example unless `env` says otherwise.
 */
async function start(options: { env?: Record<string, string | undefined>; seed?: string; dbPath?: string; forSale?: boolean; payments?: Payments; pricesDown?: boolean } = {}): Promise<Harness> {
  const dbPath = options.dbPath ?? join(tempDir(), 'verifier.sqlite')
  if (options.seed) writeFileSync(join(dirname(dbPath), SEED_FILE), options.seed, { mode: 0o600 })
  const config = readConfig({
    VERIFIER_NAME,
    DIDIT_API_KEY: 'not-used',
    DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DATABASE_PATH: dbPath,
    PORT: '0',
    APP_ORIGINS: 'https://app.example',
    ...options.env,
  })
  let clock = Date.now()
  const application = new FakeApplication()
  const faces = new FakeFaceCheck(application)
  const ids = new FakeFaceCheck(application)
  const payments = new FakePayments(() => clock)
  payments.pricesDown = options.pricesDown ?? false
  const paidFor = new Map<string, string>()
  const logs: string[] = []
  const verifier = await startVerifier(config, {
    faceCheck: faces,
    idCheck: ids,
    embedder: namedFaces(),
    ...(options.forSale !== false ? { payments } : options.payments && { payments: options.payments }),
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
  const session = async (decision: Decision, n: bigint) => {
    const { status, body } = await post('/face/session', { stampNumber: n.toString() })
    assert.equal(status, 201, JSON.stringify(body))
    faces.set(body.sessionId, decision)
    return body.sessionId as string
  }
  const paid = async (n: bigint) => {
    const { status, body } = await post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/paid' })
    assert.equal(status, 201, JSON.stringify(body))
    payments.pay(checkoutOf(body.payment))
    return body.payment as string
  }
  const idSession = async (decision: Decision, n: bigint, payment?: string) => {
    payment ??= await paid(n)
    const { status, body } = await post('/id/session', { payment })
    assert.equal(status, 201, JSON.stringify(body))
    ids.set(body.sessionId, decision)
    paidFor.set(body.sessionId, payment)
    return body.sessionId as string
  }
  const knownPayment = async () => {
    const n = await stampNumber()
    const payment = await paid(n)
    await idSession(passedId('nobody'), n, payment)
    return payment
  }
  const forgetTries = () => {
    const db = new DatabaseSync(dbPath)
    db.exec('DELETE FROM face_tries')
    db.close()
  }
  const sessionsOf = (payment: string) => [...paidFor].filter(([, p]) => p === payment).map(([id]) => id)
  return { verifier, faces, ids, payments, paidFor, sessionsOf, dbPath, logs, post, session, paid, knownPayment, idSession, forgetTries, later: (ms) => void (clock += ms), now: () => clock }
}

const faceStamp = (h: Harness, sessionId: string, n: bigint) => h.post('/face/stamp', { sessionId, stampNumber: n.toString() })
/** A face session for `n` whose check came to `decision`, asked for its stamp. */
const faceCheck = async (h: Harness, decision: Decision, n: bigint) => faceStamp(h, await h.session(decision, n), n)
/** An ID stamp asked with `payment`, or else the one its session was opened with. */
const idStamp = (h: Harness, sessionId: string, n: bigint, payment = h.paidFor.get(sessionId)) => h.post('/id/stamp', { sessionId, stampNumber: n.toString(), payment })
const about = async (h: Harness) => (await fetch(h.verifier.url + '/')).json()
/** A stamp's own fields: what the verifier keeps of it, and hands back, without its list. */
const own = ({ stampNumber, facts, verifier, verifierName, signature }: Record<string, unknown>) => ({ stampNumber, facts, verifier, verifierName, signature })
const stampBack = (h: Harness, n: bigint) => h.post('/stamp', { stampNumber: n.toString() })

/** A face stamp for `person`, as an app gets one. */
async function face(h: Harness, person: string, n: bigint, over: Partial<Decision> = {}) {
  const sessionId = await h.session(passed(person, over), n)
  const res = await faceStamp(h, sessionId, n)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { sessionId, stamp: res.body.stamp }
}

test('GET /: the name, for each check the key that signs its stamps, as an address, the names of its facts and its consent screen, the face deletion’s text, the recipe, the line the person ticks, and the ID check’s right to cancel', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const res = await fetch(h.verifier.url + '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const text = await res.text()
    assert.equal(canonical(parseCanonical(text)), text, 'canonical JSON')
    // A new recipe is a new key: the texts are `face-facts` and `id-facts`, never `face`, `id` or `id-fields`, which derived the keys of the recipes before.
    const keys = { face: serviceKey(await hkdf(seed.bytes, 'face-facts')).address, id: serviceKey(await hkdf(seed.bytes, 'id-facts')).address }
    for (const old of ['face', 'id', 'id-fields']) assert.ok(![keys.face, keys.id].includes(serviceKey(await hkdf(seed.bytes, old)).address), old)
    assert.deepEqual(JSON.parse(text), {
      name: VERIFIER_NAME,
      face: { key: keys.face, facts: ['model', 'embedding'], consent: FACE_CONSENT, deletion: DELETION },
      id: { key: keys.id, facts: [...ID_FACTS], forSale: true, testPayments: true, price: PRICES.price, addedPrice: PRICES.addedPrice, cancelRight: CANCEL_RIGHT },
      recipe: "the standard's facts as a list (proofs/README.md, Facts as a list): factsNumber of the list beside the stamp, under factList",
      consent: CONSENT,
      agree: 'I am 18 or older and I agree',
    })
    // The ID check's consent screen stays where today's app reads it; each check has its own.
    assert.notEqual(FACE_CONSENT, CONSENT)
    // What the ID check's consent says of the scrambled copy, word for word, and none of what it said before.
    const passage = "To count each person once, Forest's verifier keeps beside your stamp a scrambled copy of your first name, first last name and birth date. It can't be read back: it can only tell whether a given name and birth date match. Until five years after Didit first kept your face, an ID check on another passkey that shows your name and birth date is checked against your face: the same face is refused, a different face passes. If you have deleted your face, such a match is refused. Five years after Didit first kept your face, the copy is deleted. So if you lose this passkey, no new one can get an ID stamp for you until then, whether or not you delete your face. Your own check is refused the same way if it matches someone already counted. Beside it, Forest keeps only the stamps it signed you"
    assert.ok(CONSENT.includes(passage))
    for (const old of ['for good', 'Beside them', 'personal number', 'lifetime', 'CURP', 'Mexico', 'both copies', 'second one', 'unless the two IDs show different numbers', 'ID details', 'two scrambled codes']) assert.equal(CONSENT.includes(old), false, old)
    // It claims nothing of a changed name: a lifelong number or a face is never said to catch one.
    for (const text of [CONSENT, FACE_CONSENT, DELETION]) assert.equal(/name change|changed name|new name|changes? (of )?(your )?name/i.test(text), false)
    assert.equal(DELETION, "Deleting your face waits 28 days, and you can undo it until then. Then Didit erases your checks, the template of your face and what it keeps with it (after an ID check, your name, birth date and your ID's country). Your stamps stay, and the scrambled copy stays until five years after Didit first kept your face, then is deleted. Until then a new passkey still can't get an ID stamp for you, the same as if you had kept it.")
    assert.equal(JSON.parse(text).face.deletion, DELETION)
    assert.equal(AGREE, 'I am 18 or older and I agree')
    assert.equal(JSON.parse(text).recipe, RECIPE)
    assert.deepEqual(JSON.parse(text).id.facts.slice(0, 4), ['model', 'embedding', 'address', 'date_of_birth'])
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
    // Stripe at an address on this machine that answers nothing, so nothing here reaches Stripe itself.
    const payments = key && new StripeClient({ secretKey: key, publishableKey: key.includes('_test_') ? 'pk_test_51standin' : 'pk_live_51standin', price: 'price_1standin', addedPrice: 'price_2standin', baseUrl: 'http://127.0.0.1:9' })
    const h = await start({ forSale: false, payments })
    try {
      const { id } = await about(h)
      assert.deepEqual({ forSale: id.forSale, testPayments: id.testPayments }, { forSale, testPayments }, key ?? 'no key')
      assert.deepEqual([id.price, id.addedPrice], [null, null], 'no price before Stripe has said it')
    } finally {
      await h.verifier.close()
    }
  }
})

test('GET /: the two prices, once Stripe has said them; the verifier starts without them, asks at every sweep, and makes no payment before; the face check never waits for Stripe', async () => {
  const h = await start({ pricesDown: true })
  try {
    assert.deepEqual([(await about(h)).id.price, (await about(h)).id.addedPrice], [null, null])
    assert.deepEqual(h.logs, ["verifier: Stripe has not said the ID check's prices, asked again at the next sweep (Error)"], 'logged, by its kind')
    const n = await stampNumber()
    assert.deepEqual(await h.post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/paid' }), { status: 502, body: { error: 'payment_unavailable' } }, 'no payment before the person can be shown its price')
    assert.equal(h.payments.added.size, 0, 'nor a page at Stripe')
    assert.equal((await face(h, 'alice', n)).stamp.verifier, h.verifier.keys.face, 'the face check, as ever')
    await h.verifier.sweep()
    assert.equal(h.logs.length, 2, 'asked again at the sweep, and still unknown')

    // Stripe answers: the next sweep has them, GET / says them, still canonical, and the payment is made.
    h.payments.pricesDown = false
    await h.verifier.sweep()
    const text = await (await fetch(h.verifier.url + '/')).text()
    assert.equal(canonical(parseCanonical(text)), text)
    assert.deepEqual([JSON.parse(text).id.price, JSON.parse(text).id.addedPrice], [PRICES.price, PRICES.addedPrice])
    assert.equal((await h.post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/paid' })).status, 201)
    // Known, they are never asked again.
    h.payments.pricesDown = true
    await h.verifier.sweep()
    assert.equal(h.logs.length, 2)
  } finally {
    await h.verifier.close()
  }
})

test('a face stamp: signed by the face key, its facts the standard’s list of the face model and the embedding, and a verification from it holds for that key only', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const person = new Uint8Array(randomBytes(32))
    const n = stampNumberOf(seedNumber(person), VERIFIER_NAME)
    const { sessionId, stamp: json } = await face(h, 'alice', n)
    assert.deepEqual(Object.keys(json).sort(), ['factList', 'facts', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.stampNumber, n)
    assert.equal(stamp.verifierName, VERIFIER_NAME, 'under its name')
    assert.equal(stamp.verifier, published.face.key, 'the face key GET / publishes')
    assert.ok(stampSigned(stamp), "the standard's check: the verifier signed it")
    // The list beside it, which the standard's factListOf reads: the model, and alice's face as base64url text.
    const list = factListOf(stamp)
    assert.deepEqual(list.map(({ name, value }) => ({ name, value })), [{ name: 'model', value: 'test-model' }, { name: 'embedding', value: b64u.encode(faceOf('alice')) }])
    assert.equal(stamp.facts, factsNumber(list))
    // Each salt is the session's, derived from the verifier's secret (facts.ts).
    assert.deepEqual(list, faceList('test-model', faceOf('alice'), saltsOf(await hkdf(seed.bytes, 'fact-salt'), sessionId)))

    // The stamp does what it is for: a verification, made with the standard's own code, that holds for its verifier.
    const label = 'lessons/seller'
    const proof = await proveVerification({ seed: person, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
    assert.equal(await check(published.face.key), true)
    assert.equal(await check(published.id.key), false, 'a face stamp is no ID stamp')
    assert.deepEqual(h.logs, [], 'nothing is logged')

    // Asked again within its hour, the same session gives the same stamp, list and all.
    assert.deepEqual((await faceStamp(h, sessionId, n)).body.stamp, json)
  } finally {
    await h.verifier.close()
  }
})

test('an ID stamp: signed by the ID key, its facts the standard’s list of the model, the embedding and every field Didit read, which the facts proof shows to one reader', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const person = new Uint8Array(randomBytes(32))
    const n = stampNumberOf(seedNumber(person), VERIFIER_NAME)
    const read = doc('Lovelace', { first_name: ' ADA ', last_name: 'LoveLace', 'extra_fields.profession': 'Mathematician' })
    const sessionId = await h.idSession(passedId('ada', read), n)
    const res = await idStamp(h, sessionId, n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const json = res.body.stamp
    assert.deepEqual(Object.keys(json).sort(), ['factList', 'facts', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.verifier, published.id.key, 'the ID key GET / publishes')
    assert.ok(stampSigned(stamp))
    const list = factListOf(stamp)
    assert.deepEqual(Object.fromEntries(list.slice(2).map(({ name, value }) => [name, value])), read, "every field Didit read, as it read it, by Didit's names")
    assert.deepEqual(list.map((f) => f.name), ['model', 'embedding', ...Object.keys(read).sort()], 'the model and the embedding, then the fields in the order of their names')
    assert.deepEqual(list, idList('test-model', faceOf('ada'), read, saltsOf(await hkdf(seed.bytes, 'fact-salt'), sessionId)))
    assert.equal(stamp.facts, factsNumber(list))

    const label = 'lessons/buyer'
    const proof = await proveVerification({ seed: person, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
    assert.equal(await check(published.id.key), true)
    assert.equal(await check(published.face.key), false, 'an ID stamp is no face stamp')

    // An ID check is a face check and a document: n held no face stamp, so the same selfie gives it one
    // from the face key, its list the face key's own, the same salts as the ID stamp's first two facts.
    const faceStamp = stampFromJson(res.body.face)
    assert.deepEqual([faceStamp.verifier, faceStamp.stampNumber], [published.face.key, n])
    assert.ok(stampSigned(faceStamp))
    assert.deepEqual(factListOf(faceStamp), list.slice(0, 2), 'the model and the embedding, as the ID stamp has them')
    const faceProof = await proveVerification({ seed: person, stamp: faceStamp, label, artifacts: ARTIFACTS })
    assert.equal(await checkVerification({ proof: faceProof.proof, verifier: published.face.key, verifierName: VERIFIER_NAME, label, profile: faceProof.address }), true, 'both badges')
    assert.deepEqual((await stampBack(h, n)).body.face, own(res.body.face), 'the one POST /stamp gives')

    // What the list is for: the standard's facts proof shows two of its facts, and nothing else, to one reader.
    const reader = 'a reader’s profile'
    const shown = await proveFacts({ seed: person, stamp, label, show: [{ name: 'last_name', value: 'LoveLace' }, { name: 'date_of_birth', value: '1990-04-01' }], time: Date.now(), to: reader, artifacts: setupOf('facts') })
    assert.equal(await checkFacts({ proof: shown, verifier: published.id.key, verifierName: VERIFIER_NAME, label, profile: shown.profile, to: reader, oldest: Date.now() - 60_000 }), true)

    // A field Didit did not read is simply absent: the person is not turned away.
    const { address: _, ...homeless } = doc('Krasniqi')
    const m = await stampNumber()
    const without = await idStamp(h, await h.idSession(passedId('besa', homeless), m), m)
    assert.equal(without.status, 200, JSON.stringify(without.body))
    const withoutList = factListOf(stampFromJson(without.body.stamp))
    assert.equal(withoutList.some((f) => f.name === 'address'), false)
    assert.equal(withoutList.length, 2 + Object.keys(homeless).length)
    // But for what the scrambled copy needs (fingerprint.ts): without it, it would count nobody.
    const { date_of_birth: ___, ...ageless } = doc('Hoxha')
    for (const read of [ageless, doc('', { first_name: ' - ', full_name: '' }), doc('Gashi', { date_of_birth: '1990-02-30' })]) {
      const o = await stampNumber()
      assert.deepEqual(await idStamp(h, await h.idSession(passedId('besa', read), o), o), { status: 403, body: { error: 'id_unclear' } }, JSON.stringify(read))
    }
  } finally {
    await h.verifier.close()
  }
})

test('an ID stamp for each document: the first at the price, each after at the added-ID price, none replacing another; Didit refusing a person it has seen ends the payment on its first try', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const first = await h.idSession(passedId('ada', doc('Lovelace')), n1)
    assert.equal(h.payments.added.get(checkoutOf(h.paidFor.get(first)!)), false, 'a stamp number with no ID stamp pays the price')
    const signed = await idStamp(h, first, n1)
    assert.equal(signed.status, 200)
    assert.equal(h.payments.state(h.paidFor.get(first)!), 'taken', 'a new ID stamp takes the hold')
    assert.equal(signed.body.face.verifier, h.verifier.keys.face, 'and n1 held no face stamp: one from the same selfie')

    // Her document again, for another stamp number: Didit matched her face to n1's, and her copy is
    // n1's. Refused; the payment ends on its first try, its hold cancelled, as no other try can pass.
    const refused = await h.idSession(passedId('ada', doc('Lovelace'), { knownFaces: [h.ids.vendorData.get(first)!] }), n2)
    assert.deepEqual(await idStamp(h, refused, n2), { status: 403, body: { error: 'known_person' } })
    assert.equal(h.payments.state(h.paidFor.get(refused)!), 'cancelled', 'its hold cancelled')
    assert.deepEqual(await h.post('/id/session', { payment: h.paidFor.get(refused) }), { status: 409, body: { error: 'payment_used' } }, 'and its payment used up')

    // For the same stamp number, another document of hers: a new ID stamp, at the added-ID price, its hold taken, and no face stamp, as n1 holds one.
    const renewed = doc('Lovelace', { issuing_state: 'IRL', document_number: 'CD7654321' })
    const payment = await h.paid(n1)
    assert.equal(h.payments.added.get(checkoutOf(payment)), true, 'a stamp number with an ID stamp pays the added-ID price')
    const added = await h.idSession(passedId('ada', renewed), n1, payment)
    const second = await idStamp(h, added, n1)
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.notEqual(second.body.stamp.facts, signed.body.stamp.facts)
    assert.equal(second.body.face, null)
    assert.equal(h.payments.state(payment), 'taken')
    // The same document checked again: another stamp for it. The person paid; an index counts the ID key once.
    const checkedAgain = await h.idSession(passedId('ada', renewed), n1)
    const again = await idStamp(h, checkedAgain, n1)
    assert.equal(again.status, 200)
    assert.notEqual(again.body.stamp.facts, second.body.stamp.facts)

    // POST /stamp hands back every one, without its list, and the face stamp the first gave.
    const back = (await stampBack(h, n1)).body
    assert.deepEqual(back.face, own(signed.body.face))
    assert.deepEqual(new Set(back.id.map((stamp: { facts: string }) => stamp.facts)), new Set([signed, second, again].map((r) => r.body.stamp.facts)))
    for (const stamp of back.id) assert.deepEqual(Object.keys(stamp).sort(), ['facts', 'signature', 'stampNumber', 'verifier', 'verifierName'])

    // Each session, sent again within its hour: its own stamps, with their lists; after it, used.
    assert.deepEqual((await idStamp(h, first, n1)).body, signed.body, 'the first, its face stamp too')
    assert.deepEqual((await idStamp(h, added, n1)).body, second.body)
    h.later(SIGNED_FOR_MS)
    assert.deepEqual(await idStamp(h, first, n1), { status: 409, body: { error: 'session_used' } })

    // Didit keeps no ID check: after its hour the sweep deletes each, as it does the refused one, and
    // keeps a template of the first's face alone, as Didit then held none of n1's.
    await h.verifier.sweep()
    assert.deepEqual([[...h.ids.deleted].sort(), h.ids.keptFaces], [[refused, first, added, checkedAgain].sort(), [first]])
    assert.ok([first, added].every((sessionId) => !h.ids.sessions.has(sessionId)), 'gone from Didit')
    // A later face check for n1: a new face stamp, the first still the one handed back, and its face not kept, as Didit holds n1's.
    const later = await face(h, 'ada', n1)
    assert.deepEqual((await stampBack(h, n1)).body.face, own(signed.body.face))
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted, h.faces.keptFaces], [[later.sessionId], []])
  } finally {
    await h.verifier.close()
  }
})

test('one free face check a stamp number: a face session Didit finished that an app asked a stamp of and that gave none is its try, once; then no more face sessions, and the ID check', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const left = async (k: bigint) => (await stampBack(h, k)).body.faceTriesLeft
    assert.equal(await left(n), FACE_TRIES, 'none used')
    // A session opened before the tries are used, finished later.
    const early = await h.session(passed('cleo', { status: 'In Progress' }), n)

    // Never finished, never asked about, or not this stamp number's: no try.
    for (const status of ['Not Started', 'In Progress', 'Expired', 'Abandoned']) {
      assert.equal((await faceCheck(h, passed('cleo', { status }), n)).status, 403, status)
    }
    await h.session(passed('cleo', { status: 'Declined' }), n)
    assert.deepEqual(await faceStamp(h, await h.session(passed('cleo', { status: 'Declined' }), await stampNumber()), n), { status: 409, body: { error: 'session_used' } })
    assert.equal(await left(n), FACE_TRIES)

    // Declined, asked twice: its one try, once.
    const declined = await h.session(passed('cleo', { status: 'Declined' }), n)
    assert.equal(FACE_TRIES, 1)
    for (let i = 0; i < 2; i++) assert.deepEqual(await faceStamp(h, declined, n), { status: 403, body: { error: 'other' } })
    assert.equal(await left(n), 0)
    // In Review is refused as Declined is, and is a try too.
    const k = await stampNumber()
    assert.deepEqual(await faceCheck(h, refusedWith(['AGE_BELOW_MINIMUM'], { status: 'In Review' }), k), { status: 403, body: { error: 'too_young' } })
    assert.equal(await left(k), 0)

    // No more face sessions for n, with a return page or not, and Didit is not asked.
    const created = h.faces.created
    for (const body of [{ stampNumber: n.toString() }, { stampNumber: n.toString(), returnUrl: 'https://app.example/back' }]) {
      assert.deepEqual(await h.post('/face/session', body), { status: 409, body: { error: 'face_tries_used' } })
    }
    assert.equal(h.faces.created, created)
    // One opened before still gives its stamp, and gives no try back.
    h.faces.set(early, passed('cleo'))
    assert.equal((await faceStamp(h, early, n)).status, 200)
    assert.equal(await left(n), 0)

    // Another stamp number, as a new passkey has, starts over; after its try, the ID check gives it
    // its ID stamp and a face stamp from the same selfie.
    const m = await stampNumber()
    assert.equal(await left(m), FACE_TRIES)
    assert.deepEqual(await faceCheck(h, passed('dov', { faceImage: null }), m), { status: 403, body: { error: 'face_unclear' } })
    assert.equal(await left(m), 0)
    const id = await idStamp(h, await h.idSession(passedId('dov', doc('Dov')), m), m)
    assert.equal(id.status, 200, JSON.stringify(id.body))
    assert.deepEqual((await stampBack(h, m)).body, { face: own(id.body.face), id: [own(id.body.stamp)], faceTriesLeft: 0, deletion: null })
  } finally {
    await h.verifier.close()
  }
})

test('one Didit user a stamp number: every session, face or ID, under its keyed hash alone; it gives its stamp, and its refusal, to no other', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const [n, m] = [await stampNumber(), await stampNumber()]
    const key = await hkdf(seed.bytes, 'vendor-data')
    const face = await h.session(passed('alice'), n)
    const id = await h.idSession(passedId('alice', doc('Lovelace')), n)
    const another = await h.session(passed('alice'), n)
    assert.deepEqual([h.faces.vendorData.get(face), h.ids.vendorData.get(id), h.faces.vendorData.get(another)], [stampHash(key, n), stampHash(key, n), stampHash(key, n)], 'the keyed hash of the stamp number and nothing else, for both checks')
    assert.equal(h.faces.vendorData.get(await h.session(passed('bob'), m)), stampHash(key, m), 'another stamp number, another hash')

    // Asked for another stamp number: refused, the session left for its own, and no payment ended.
    assert.deepEqual(await faceStamp(h, face, m), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual(await idStamp(h, id, m), { status: 409, body: { error: 'session_used' } })
    assert.equal(h.payments.state(h.paidFor.get(id)!), 'held')
    assert.equal((await faceStamp(h, face, n)).status, 200, 'its own stamp number')
    assert.equal((await idStamp(h, id, n)).status, 200, 'and its ID check, the same Didit user')
    // A refusal the same: its code goes to its own stamp number alone, asked before or after it is kept.
    const refused = await h.session(refusedWith(['DUPLICATED_FACE']), m)
    assert.deepEqual(await faceStamp(h, refused, n), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual(await faceStamp(h, refused, m), { status: 403, body: { error: 'known_face' } })
    assert.deepEqual(await faceStamp(h, refused, n), { status: 409, body: { error: 'session_used' } }, 'kept, for m alone')

    // A session under any other vendor_data, as every session carried before: no stamp for anyone.
    const c = await stampNumber()
    const old = await h.session(passed('carol', { vendorData: `face-${stampHash(key, c)}-${randomUUID()}` }), c)
    assert.deepEqual(await faceStamp(h, old, c), { status: 409, body: { error: 'session_used' } })

    // Nothing of it is kept: no stamp number's hash is in the file.
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()
    const file = readFileSync(h.dbPath)
    for (const text of [stampHash(key, n), stampHash(key, m), stampHash(key, c)]) assert.equal(file.includes(Buffer.from(text)), false, text.slice(0, 24))
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('Didit decides who is the same person: a stamp only for what it approved; its refusal, Declined or In Review, one code by its risks, kept, and the session deleted at once', async () => {
  const h = await start()
  try {
    const refused = (error: string) => ({ status: 403, body: { error } })
    // Each code, from the risks that set the status, the first in order when several apply.
    const codes: [string[], string][] = [
      [['POSSIBLE_DUPLICATED_USER'], 'other'],
      [['DUPLICATED_FACE'], 'known_face'],
      [['AGE_BELOW_MINIMUM'], 'too_young'],
      [['LOW_FACE_MATCH_SIMILARITY'], 'face_mismatch'],
      [['DOCUMENT_EXPIRED'], 'id_unclear'],
      [['LOW_LIVENESS_SCORE'], 'face_unclear'],
      [['FACE_IN_BLOCKLIST'], 'other'],
      [[], 'other'],
      [['LOW_LIVENESS_SCORE', 'DUPLICATED_FACE', 'POSSIBLE_DUPLICATED_USER'], 'known_face'],
    ]
    for (const status of ['Declined', 'In Review']) {
      for (const [risks, error] of codes) assert.deepEqual(await faceCheck(h, refusedWith(risks, { status }), await stampNumber()), refused(error), `${status} ${risks}`)
    }
    // Approved is a stamp, whatever Didit's warnings say: the verifier keeps no rule of its own.
    assert.equal((await faceCheck(h, passed('twin', { risks: ['DUPLICATED_FACE'] }), await stampNumber())).status, 200)

    // An ID check refused as a person or a face Didit has seen ends its payment on its first try, its
    // hold cancelled; any other refusal leaves the hold for the next try.
    const idRefused = async (risks: string[], status = 'Declined', document: Record<string, string> | null = null) => {
      const k = await stampNumber()
      const sessionId = await h.idSession(refusedWith(risks, { workflowId: ID_WORKFLOW, status, document }), k)
      return [(await idStamp(h, sessionId, k)).body.error, h.payments.state(h.paidFor.get(sessionId)!)]
    }
    assert.deepEqual(await idRefused(['DUPLICATED_FACE']), ['known_face', 'cancelled'])
    assert.deepEqual(await idRefused(['FRONT_CAMERA_DUPLICATED_FACE'], 'In Review'), ['known_face', 'cancelled'])
    // Didit's own name check is no known_person, and ends no payment: it is another refusal, and the tries go on.
    assert.deepEqual(await idRefused(['POSSIBLE_DUPLICATED_USER']), ['other', 'held'])
    // Too young, a birth date Didit read under 18: the same. One Didit did not read: an ID it could not read, and the tries go on.
    assert.deepEqual(await idRefused(['MINIMUM_AGE_NOT_MET'], 'Declined', doc('Young', { date_of_birth: '2015-06-01' })), ['too_young', 'cancelled'])
    assert.deepEqual(await idRefused(['MINIMUM_AGE_NOT_MET'], 'Declined', doc('Unread', { date_of_birth: '' })), ['id_unclear', 'held'])
    assert.deepEqual(await idRefused(['MINIMUM_AGE_NOT_MET']), ['id_unclear', 'held'])
    for (const [risks, error] of [[['LOW_FACE_MATCH_SIMILARITY'], 'face_mismatch'], [['IMAGE_TOO_BLURRY'], 'id_unclear'], [['NO_FACE_DETECTED'], 'face_unclear'], [[], 'other']] as const) {
      assert.deepEqual(await idRefused([...risks]), [error, 'held'], error)
    }

    // A refusal is kept: asked again, the same code, with no question to Didit, and one try, once.
    const m = await stampNumber()
    const seen = await h.session(refusedWith(['DUPLICATED_FACE']), m)
    assert.deepEqual(await faceStamp(h, seen, m), refused('known_face'))
    const asked = h.faces.asked
    assert.deepEqual(await faceStamp(h, seen, m), refused('known_face'))
    assert.equal(h.faces.asked, asked, 'Didit is not asked again')
    assert.equal((await stampBack(h, m)).body.faceTriesLeft, 0, 'its one try')
    // A selfie Didit approved in which the face model finds no face: refused the same way, face_unclear.
    const b = await stampNumber()
    const blank = await h.session(passed('none'), b)
    assert.deepEqual(await faceStamp(h, blank, b), refused('face_unclear'))
    // The next sweep deletes both in Didit, face and all; the app still gets their codes.
    await h.verifier.sweep()
    assert.ok([seen, blank].every((sessionId) => h.faces.deleted.includes(sessionId) && !h.faces.keptFaces.includes(sessionId)))
    assert.deepEqual(await faceStamp(h, seen, m), refused('known_face'))
    assert.deepEqual(await faceStamp(h, blank, b), refused('face_unclear'))
  } finally {
    await h.verifier.close()
  }
})

test('a session gives its stamp to one stamp number, and again only within the hour after, on either check', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const { sessionId, stamp } = await face(h, 'alice', n1)
    const id = await h.idSession(passedId('alice', doc('Byron')), n1)
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
    const n = await stampNumber()
    const sessionId = await h.session(passed('erin'), n)
    const release = h.faces.hold()
    const both = [faceStamp(h, sessionId, n), faceStamp(h, sessionId, await stampNumber())]
    while (h.faces.waiting < 2) await new Promise((r) => setImmediate(r))
    release()
    const statuses = (await Promise.all(both)).map((r) => r.status).sort()
    assert.deepEqual(statuses, [200, 409])
  } finally {
    await h.verifier.close()
  }
})

test('the sweep: after its hour, a session that gave a stamp deleted in Didit, face or ID, keeping its face template when Didit held none of its stamp number’s; a refused one deleted at once, asked about by the app or not; any other a day after it opened, face and all', async () => {
  const h = await start()
  try {
    const [n, r, t, u] = [await stampNumber(), await stampNumber(), await stampNumber(), await stampNumber()]
    // Refused, and the app asked: a face check Declined, an ID check Declined.
    const declined = await h.session(passed('gone', { status: 'Declined' }), r)
    assert.deepEqual(await faceStamp(h, declined, r), { status: 403, body: { error: 'other' } })
    const idDeclined = await h.idSession(refusedWith(['DOCUMENT_EXPIRED'], { workflowId: ID_WORKFLOW }), r)
    assert.deepEqual(await idStamp(h, idDeclined, r), { status: 403, body: { error: 'id_unclear' } })
    // Refused, and the app never asks: a face check In Review, an ID check Declined.
    const unasked = await h.session(refusedWith(['DUPLICATED_FACE'], { status: 'In Review' }), t)
    const idUnasked = await h.idSession(refusedWith(['DUPLICATED_FACE'], { workflowId: ID_WORKFLOW }), r)
    // Unfinished, and approved but never asked about.
    const unfinished = await h.session(passed('known', { status: 'In Progress' }), u)
    assert.deepEqual(await faceStamp(h, unfinished, u), { status: 403, body: { error: 'not_approved' } })
    const lost = await h.session(passed('lost'), n)

    const signed = await face(h, 'ana', n)
    const id = await h.idSession(passedId('ana', doc('Pfeiffer')), n)
    assert.equal((await idStamp(h, id, n)).status, 200)
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'a request deletes nothing')

    // The next sweep asks Didit about every session open, and deletes each it refused at once, face and all.
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted.toSorted(), h.ids.deleted.toSorted()], [[declined, unasked].toSorted(), [idDeclined, idUnasked].toSorted()])
    assert.deepEqual([h.faces.keptFaces, h.ids.keptFaces], [[], []])
    // The app asking later gets the code the sweep read, for that stamp number alone, with no question to Didit.
    const asked = h.faces.asked + h.ids.asked
    assert.deepEqual(await faceStamp(h, unasked, t), { status: 403, body: { error: 'known_face' } })
    assert.deepEqual(await idStamp(h, idUnasked, r), { status: 403, body: { error: 'known_face' } })
    assert.equal(h.faces.asked + h.ids.asked, asked)
    assert.equal(h.payments.state(h.paidFor.get(idUnasked)!), 'cancelled', 'its hold cancelled once the app asks with its payment')
    assert.deepEqual(await faceStamp(h, unasked, n), { status: 409, body: { error: 'session_used' } })

    h.later(SIGNED_FOR_MS - 1)
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.length, 2, 'nothing more within the hour')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deleted.at(-1), signed.sessionId, 'a face session that gave a stamp, once the hour is over')
    assert.deepEqual([h.faces.keptFaces, h.ids.keptFaces], [[signed.sessionId], []], 'keeping its face template: Didit held none of n’s')
    assert.equal(h.ids.deleted.at(-1), id, 'an ID session that gave a stamp too, keeping no face: Didit holds n’s')
    assert.deepEqual(h.logs, [], 'Didit kept each face template: nothing to say')
    assert.deepEqual(await faceStamp(h, signed.sessionId, n), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual(await idStamp(h, id, n), { status: 409, body: { error: 'session_used' } }, 'its hour over, forgotten')

    // A day after they opened: every other session, unfinished or never asked about, face and all.
    h.later(OPEN_FOR_MS - SIGNED_FOR_MS - 1)
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.length, 3, 'not before the day is over')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deleted.slice(3).toSorted(), [unfinished, lost].toSorted())
    assert.deepEqual(h.ids.deleted.toSorted(), [idDeclined, idUnasked, id].toSorted(), 'each once')
    assert.deepEqual([h.faces.keptFaces, h.ids.keptFaces], [[signed.sessionId], []], 'keeping nothing of them')
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.length, 5, 'each once')
    assert.deepEqual(await faceStamp(h, unasked, t), { status: 403, body: { error: 'unknown_session' } }, 'a refusal forgotten with its day')

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

    // Didit not saying what a session came to: asked again at the next sweep.
    const q = await stampNumber()
    const quiet = await h.session(refusedWith(['DUPLICATED_FACE']), q)
    h.faces.down = true
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: Didit did not say what 1 session came to, asked again at the next sweep (Error)')
    h.faces.down = false
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.at(-1), quiet)

    // m's second face stamp keeps no face: its first does, so m's own kept faces stay few.
    const second = await face(h, 'lena', m)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted.at(-1), h.faces.keptFaces.at(-1)], [second.sessionId, later.sessionId], 'deleted, its face with it')

    // Didit deleting a session without keeping the face template it was asked to keep: logged, by Didit's outcome only.
    h.faces.outcome = 'deleted'
    const o = await stampNumber()
    const otto = await face(h, 'otto', o)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: Didit kept no face template for a deleted session (deleted)')

    // The file names a session in clear only until its day: signed within its hour, open, or refused.
    const pia = await face(h, 'lena', m)
    const open = await h.session(passed('quinn'), await stampNumber())
    const s = await stampNumber()
    const payment = await h.paid(s)
    const idOpen = await h.idSession(passedId('rui', doc('Rui')), s, payment)
    await h.verifier.close()
    assertKept(h.dbPath, {
      sessions: [[signed.sessionId, n, 'face'], [id, n, 'id'], [later.sessionId, m, 'face'], [second.sessionId, m, 'face'], [otto.sessionId, o, 'face'], [pia.sessionId, m, 'face']],
      toDelete: [pia.sessionId],
      opened: [[quiet, null], [open, null], [idOpen, payment]],
      refused: [[quiet, 'known_face']],
      faceTries: [[r, 1], [t, 1]],
      payments: [[h.paidFor.get(idDeclined)!, 1, false], [h.paidFor.get(idUnasked)!, ID_TRIES, true], [h.paidFor.get(id)!, ID_TRIES, true], [payment, 1, false]],
      // One face a stamp number, each its first stamp's: n's, m's and o's, Didit's answer for o's notwithstanding.
      faces: [signed.sessionId, later.sessionId, otto.sessionId].map((sessionId) => h.faces.vendorData.get(sessionId)!),
      fingerprints: [[h.ids.vendorData.get(id)!, 1]],
      never: [],
    })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('releasing a session whose stamp number holds no stamp and has no other session open deletes its Didit user first, so Didit keeps a name and a birth date only for a person with a stamp', async () => {
  const h = await start()
  try {
    const users = () => [...h.faces.deletedUsers, ...h.ids.deletedUsers]
    const vendorDataOf = (sessionId: string) => (h.faces.vendorData.get(sessionId) ?? h.ids.vendorData.get(sessionId))!
    const deleted = (sessionId: string) => h.faces.deleted.includes(sessionId) || h.ids.deleted.includes(sessionId)

    // A stamp number with no stamp, refused on both checks, the app asking or not: its user goes, once.
    const r = await stampNumber()
    const refusedFace = await h.session(refusedWith(['LOW_LIVENESS_SCORE']), r)
    assert.equal((await faceStamp(h, refusedFace, r)).status, 403)
    const refusedId = await h.idSession(refusedWith(['IMAGE_TOO_BLURRY'], { workflowId: ID_WORKFLOW }), r)
    await h.verifier.sweep()
    assert.deepEqual(users(), [vendorDataOf(refusedFace)])
    assert.ok(deleted(refusedFace) && deleted(refusedId))

    // One that holds a stamp: its refused session goes, and its user stays.
    const n = await stampNumber()
    await face(h, 'ana', n)
    const refusedN = await h.session(refusedWith(['LOW_LIVENESS_SCORE']), n)
    await h.verifier.sweep()
    assert.ok(deleted(refusedN))
    assert.equal(users().includes(vendorDataOf(refusedN)), false)

    // One with another session open, Didit's approval not yet asked for: its user stays while it is open;
    // at its day the open one is released too, and then, with none open, the user goes.
    const k = await stampNumber()
    const refusedK = await h.session(refusedWith(['DUPLICATED_FACE']), k)
    const openK = await h.idSession(passedId('kim', doc('Kim')), k)
    await h.verifier.sweep()
    assert.ok(deleted(refusedK))
    assert.equal(users().includes(vendorDataOf(refusedK)), false)
    h.later(OPEN_FOR_MS)
    await h.verifier.sweep()
    assert.ok(deleted(openK))
    assert.ok(users().includes(vendorDataOf(openK)))

    // Didit not answering a user's deletion: its session stays too, and both are tried again.
    const q = await stampNumber()
    const refusedQ = await h.session(refusedWith([]), q)
    h.faces.usersDown = true
    await h.verifier.sweep()
    assert.equal(deleted(refusedQ), false)
    assert.equal(h.logs.at(-1), 'verifier: 1 Didit user could not be deleted, kept for the next sweep (Error)')
    h.faces.usersDown = false
    await h.verifier.sweep()
    assert.ok(deleted(refusedQ) && users().includes(vendorDataOf(refusedQ)))

    // Didit not saying what an open session came to: whose it is is not known, so nothing is released.
    const p = await stampNumber()
    const refusedP = await h.session(refusedWith([]), p)
    assert.equal((await faceStamp(h, refusedP, p)).status, 403)
    const openX = await h.idSession(passedId('xia', doc('Xia')), await stampNumber())
    h.ids.down = true
    await h.verifier.sweep()
    assert.equal(deleted(refusedP), false)
    h.ids.down = false
    await h.verifier.sweep()
    assert.ok(deleted(refusedP) && users().includes(vendorDataOf(refusedP)))
    assert.equal(users().includes(vendorDataOf(openX)), false, 'and the open one’s stays')
  } finally {
    await h.verifier.close()
  }
})

test('the scrambled copy: an ID check whose first name, first last name and birth date match another stamp number’s copy is refused, known_person, when Didit matched its face, from any country, or when its person deleted that face; a stranger who shares them, and the same stamp number again, pass', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const key = await hkdf(seed.bytes, 'vendor-data')
    const [a, b, c, d, e] = [await stampNumber(), await stampNumber(), await stampNumber(), await stampNumber(), await stampNumber()]
    const ada = doc('Lovelace')
    assert.equal((await idStamp(h, await h.idSession(passedId('ada', ada), a), a)).status, 200)

    // Another passkey of hers, b: Didit matched her face to a's. Refused, its payment ended at once, as no try can pass.
    const again = await h.idSession(passedId('ada', ada, { knownFaces: [stampHash(key, a)] }), b)
    assert.deepEqual(await idStamp(h, again, b), { status: 403, body: { error: 'known_person' } })
    assert.equal(h.payments.state(h.paidFor.get(again)!), 'cancelled')
    // Her ID from a second country, another type, a second given and family name, its own numbers: the same first name, first last name and birth date, and her face.
    const abroad = doc('Lovelace Byron', { first_name: 'Ada Augusta', issuing_state: 'IRL', document_type: 'Identity Card', personal_number: '1234567TA', document_number: 'CD7654321' })
    assert.deepEqual(await idStamp(h, await h.idSession(passedId('ada', abroad, { knownFaces: [stampHash(key, a)] }), b), b), { status: 403, body: { error: 'known_person' } })
    assert.deepEqual((await stampBack(h, b)).body.id, [], 'b holds no ID stamp')
    // Kept as refused, so the sweep deletes the session in Didit at once.
    await h.verifier.sweep()
    assert.ok(h.ids.deleted.includes(again))

    // A stranger who shares her details: Didit matched another face, not a's, so c gets its stamp, and both are kept.
    assert.equal((await idStamp(h, await h.idSession(passedId('eve', ada, { knownFaces: ['f'.repeat(64)] }), c), c)).status, 200)
    // a adding another ID: always fine, whatever Didit matched.
    assert.equal((await idStamp(h, await h.idSession(passedId('ada', abroad, { knownFaces: [stampHash(key, c)] }), a), a)).status, 200)

    // Two checks of one person at once, under two stamp numbers, Didit matching each to the other: one passes.
    const [f, g] = [await stampNumber(), await stampNumber()]
    const zoe = doc('Zed', { first_name: 'Zoe' })
    const fs = await h.idSession(passedId('zoe', zoe, { knownFaces: [stampHash(key, g)] }), f)
    const gs = await h.idSession(passedId('zoe', zoe, { knownFaces: [stampHash(key, f)] }), g)
    assert.deepEqual((await Promise.all([idStamp(h, fs, f), idStamp(h, gs, g)])).map((r) => r.status).sort(), [200, 403])

    // a deletes her face: 28 days on, Didit holds none of hers, and the file keeps that she deleted it...
    assert.equal((await h.post('/delete', { stampNumber: a.toString() })).status, 200)
    h.later(DELETE_AFTER_MS)
    await h.verifier.sweep()
    assert.ok(h.faces.deletedUsers.includes(stampHash(key, a)))
    // ...so a match alone refuses d, whose face Didit matched to nobody's, though c, the stranger, was never matched,
    assert.deepEqual(await idStamp(h, await h.idSession(passedId('ada', abroad), d), d), { status: 403, body: { error: 'known_person' } })
    // and one that does not match passes: another birth date.
    assert.equal((await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace', { date_of_birth: '1990-04-02' })), e), e)).status, 200)

    // Each stamp number with an ID stamp keeps its copy: a's two IDs, one row, as they give the same three details; c's, e's, and one of f's and g's.
    await h.verifier.close()
    const db = new DatabaseSync(h.dbPath, { readOnly: true })
    const rows = db.prepare('SELECT owner, count(*) AS n FROM fingerprints GROUP BY owner').all().map((r) => [Buffer.from(r.owner as Uint8Array).toString('hex'), r.n as number] as const)
    db.close()
    const passedOne = [f, g].find((k) => rows.some(([owner]) => owner === stampHash(key, k)))!
    assert.deepEqual(new Map(rows), new Map([[stampHash(key, a), 1], [stampHash(key, c), 1], [stampHash(key, passedOne), 1], [stampHash(key, e), 1]]))
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('the match rule: a match of the copy is refused while Didit holds the earlier face only when Didit names it, a different face passes; once its person deleted the face, always; a changed name matches nothing; a stamp number that holds an ID stamp is never refused; the face check is open to a person refused the ID check', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const key = await hkdf(seed.bytes, 'vendor-data')
    const face = (k: bigint) => stampHash(key, k)
    const ana = (over: Record<string, string> = {}) => doc('Ruiz Peña', { first_name: 'Ana Sofía', date_of_birth: '1990-05-12', issuing_state: 'MEX', ...over })
    const passport = (over: Record<string, string> = {}) => doc('RUIZ', { first_name: 'ANA', date_of_birth: '1990-05-12', issuing_state: 'ESP', document_type: 'Passport', ...over })
    const check = async (read: Record<string, string>, over: object = {}) => {
      const k = await stampNumber()
      const res = await idStamp(h, await h.idSession(passedId('x', read, over), k), k)
      return [res.status, res.body.error ?? null, k] as const
    }
    const status = async (read: Record<string, string>, over: object = {}) => (await check(read, over)).slice(0, 2)
    const REFUSED = [403, 'known_person']
    const PASSED = [200, null]

    // The earlier person, n; her face is held at Didit.
    const [, , n] = await check(ana())
    assert.deepEqual(await status(passport(), { knownFaces: [face(n)] }), REFUSED, 'Didit names her face: the same face, from another country')
    assert.deepEqual(await status(passport(), { knownFaces: ['f'.repeat(64)] }), PASSED, 'a different face: a stranger with the same name and birth date')
    assert.deepEqual(await status(passport()), PASSED, 'Didit named no face')
    // Another first name, first last name or birth date matches nothing, Didit naming her face or not.
    for (const other of [passport({ first_name: 'ANIA' }), passport({ last_name: 'RUIS' }), passport({ date_of_birth: '1990-05-13' })]) assert.deepEqual(await status(other, { knownFaces: [face(n)] }), PASSED, JSON.stringify(other))
    // A changed name matches no copy: her face is never checked, and she gets a second ID stamp, though Didit names it.
    assert.deepEqual(await status(passport({ last_name: 'PENA RUIZ' }), { knownFaces: [face(n)] }), PASSED)

    // She deletes her face. 28 days on, Didit holds none of her; the file keeps that she deleted it.
    assert.equal((await h.post('/delete', { stampNumber: n.toString() })).status, 200)
    h.later(DELETE_AFTER_MS)
    await h.verifier.sweep()
    assert.ok(h.faces.deletedUsers.includes(face(n)))
    // Refused with no face to compare, whatever the new ID shows besides the name and the birth date, and whoever the person is.
    assert.deepEqual(await status(passport()), REFUSED, 'a match')
    assert.deepEqual(await status(ana({ personal_number: 'ANOTHER', document_number: 'OTHER1' })), REFUSED, 'another number on the new ID makes no difference')
    assert.deepEqual(await status(passport(), { knownFaces: ['f'.repeat(64)] }), REFUSED, 'nor does another face')
    // The match is of the name and the birth date alone: another of either passes.
    assert.deepEqual(await status(passport({ date_of_birth: '1990-05-13' })), PASSED)
    assert.deepEqual(await status(passport({ last_name: 'PENA RUIZ' })), PASSED, 'a changed name')

    // A person refused the ID check can still get a face stamp: the face check compares faces, and Didit holds none of hers.
    const k = await stampNumber()
    const refused = await h.idSession(passedId('x', passport()), k)
    assert.deepEqual(await idStamp(h, refused, k), { status: 403, body: { error: 'known_person' } })
    assert.equal((await faceCheck(h, passed('ana'), k)).status, 200)

    // A stamp number that holds an ID stamp is never refused, whatever matches: her own passport, an added ID.
    const added = await h.idSession(passedId('x', passport()), n)
    assert.equal((await idStamp(h, added, n)).status, 200, 'her own copy matches, and her face is deleted: still not refused')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a face deleted: POST /delete waits 28 days and can be undone till then; then every session Didit holds of the stamp number is erased and its Didit user deleted, the stamps and scrambled copy kept, and POST /stamp says so for 90 days', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const key = await hkdf(seed.bytes, 'vendor-data')
    const day = (at: number) => new Date(at).toISOString().slice(0, 10)
    const n = await stampNumber()
    const mine = stampHash(key, n)
    const ask = (path: string, k = n) => h.post(path, { stampNumber: k.toString() })
    // Nothing to delete for a stamp number with no stamp, and nothing to undo; a body of anything else refused.
    assert.deepEqual(await ask('/delete'), { status: 409, body: { error: 'nothing_to_delete' } })
    assert.deepEqual(await ask('/delete/undo'), { status: 409, body: { error: 'nothing_to_undo' } })
    for (const path of ['/delete', '/delete/undo']) {
      assert.deepEqual(await h.post(path, { stampNumber: n.toString(), now: true }), { status: 400, body: { error: 'expected_exactly_stampNumber' } })
      assert.deepEqual(await h.post(path, { stampNumber: '-1' }), { status: 400, body: { error: 'bad_stamp_number' } })
    }

    const signed = await face(h, 'ada', n)
    const idSession = await h.idSession(passedId('ada', doc('Lovelace')), n)
    const id = await idStamp(h, idSession, n)
    assert.equal(id.status, 200)
    const first = { deletion: { state: 'requested', runsOn: day(h.now() + DELETE_AFTER_MS) } }
    assert.deepEqual(await ask('/delete'), { status: 200, body: first })
    h.later(OPEN_FOR_MS)
    assert.deepEqual(await ask('/delete'), { status: 200, body: first }, 'asked again while it waits: the same day')
    assert.deepEqual((await stampBack(h, n)).body.deletion, first.deletion)
    // Undone; asked again, a new day.
    assert.deepEqual(await ask('/delete/undo'), { status: 200, body: { deletion: { state: 'undone' } } })
    assert.equal((await stampBack(h, n)).body.deletion, null)
    assert.deepEqual(await ask('/delete/undo'), { status: 409, body: { error: 'nothing_to_undo' } })
    const runsOn = day(h.now() + DELETE_AFTER_MS)
    assert.deepEqual((await ask('/delete')).body, { deletion: { state: 'requested', runsOn } })

    // A session Didit still holds of n that the verifier does not know of, as one opened by hand, and one of someone else's.
    const unknown = randomUUID()
    h.faces.sessions.set(unknown, passed('ada', { vendorData: mine }))
    const theirs = randomUUID()
    h.faces.sessions.set(theirs, passed('bob', { vendorData: 'b'.repeat(64) }))
    h.later(DELETE_AFTER_MS - 1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.erased, h.faces.deletedUsers], [[], []], 'nothing before its time')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.erased, h.faces.deletedUsers], [[unknown], []], 'every session Didit holds of n erased, and nobody else’s')
    await h.verifier.sweep()
    assert.deepEqual([h.faces.erased, h.faces.deletedUsers], [[unknown], [mine]], 'and once Didit lists none, its user')
    assert.ok(h.faces.sessions.has(theirs))
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deletedUsers, [mine], 'once')
    const back = (await stampBack(h, n)).body
    assert.deepEqual([back.face, back.id], [own(signed.stamp), [own(id.body.stamp)]], 'the stamps stay')
    assert.deepEqual(back.deletion, { state: 'done', doneOn: day(h.now()) })
    assert.deepEqual(await ask('/delete/undo'), { status: 409, body: { error: 'nothing_to_undo' } }, 'too late to undo')

    // Its next face check keeps a template again: Didit holds none of n's.
    const next = await face(h, 'ada', n)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.equal(h.faces.keptFaces.at(-1), next.sessionId)

    // Didit not answering a list or an erasure: tried again at the next sweep, logged without the stamp number.
    const m = await stampNumber()
    const bob = await face(h, 'bob', m)
    await ask('/delete', m)
    h.later(DELETE_AFTER_MS)
    h.faces.erasingDown = true
    await h.verifier.sweep()
    assert.deepEqual(h.logs, ['verifier: 1 face deletion could not be finished in Didit, tried again at the next sweep (Error)'])
    h.faces.erasingDown = false
    await h.verifier.sweep()
    assert.equal(h.faces.deletedUsers.at(-1), stampHash(key, m))

    // 90 days after it ran, the deletion is forgotten; and every payment, 30 days after its first session.
    h.later(DELETED_KEPT_MS)
    await h.verifier.sweep()
    assert.equal((await stampBack(h, n)).body.deletion, null)
    await h.verifier.close()
    assertKept(h.dbPath, {
      sessions: [[signed.sessionId, n, 'face'], [idSession, n, 'id'], [next.sessionId, n, 'face'], [bob.sessionId, m, 'face']],
      // n's new face, held again; m's, deleted, kept so for good; both deletions, and the payment, forgotten.
      faces: [mine],
      deletedFaces: [stampHash(key, m)],
      fingerprints: [[mine, 1]],
      never: [],
    })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a face’s five years over: its Didit user, its stamp number’s scrambled copy and its row all go together, tried again if Didit does not answer; a match of them is then no match, though Didit still names the face', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const key = await hkdf(seed.bytes, 'vendor-data')
    const [n, m] = [await stampNumber(), await stampNumber()]
    const first = await h.idSession(passedId('ada', doc('Lovelace')), n)
    assert.equal((await idStamp(h, first, n)).status, 200)
    const copies = () => {
      const db = new DatabaseSync(h.dbPath, { readOnly: true })
      try {
        return [db.prepare('SELECT count(*) AS n FROM fingerprints').get()!.n, db.prepare('SELECT count(*) AS n FROM faces').get()!.n]
      } finally {
        db.close()
      }
    }
    assert.deepEqual(copies(), [1, 1], 'a name copy and a face')
    h.later(FACE_KEPT_MS - 1)
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deletedUsers, [], 'not before')
    assert.deepEqual(copies(), [1, 1])
    // Till then a match of n's copy, with Didit naming n's face, is refused.
    const before = await h.idSession(passedId('ada', doc('Lovelace'), { knownFaces: [stampHash(key, n)] }), m)
    assert.deepEqual(await idStamp(h, before, m), { status: 403, body: { error: 'known_person' } })
    h.later(1)
    h.faces.usersDown = true
    await h.verifier.sweep()
    assert.deepEqual(h.logs, ['verifier: 1 Didit user could not be deleted, kept for the next sweep (Error)'])
    assert.deepEqual(copies(), [1, 1], 'the copy stays while its user does')
    h.faces.usersDown = false
    await h.verifier.sweep()
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deletedUsers, [stampHash(key, n)], 'once')
    assert.deepEqual(copies(), [0, 0], 'its copy and its row go with its user')
    // The same check now: Didit names n's face, there is no copy of n's to match, and m gets its stamp.
    const later = await h.idSession(passedId('ada', doc('Lovelace'), { knownFaces: [stampHash(key, n)] }), m)
    assert.equal((await idStamp(h, later, m)).status, 200)
    await h.verifier.close()
    // m's face and copy kept, as Didit held none of m's; n's gone, its stamp kept.
    assertKept(h.dbPath, {
      sessions: [[first, n, 'id'], [later, m, 'id']],
      toDelete: [later],
      // The refused check, deleted in Didit at once and its code kept till its day.
      opened: [[before, null]],
      refused: [[before, 'known_person']],
      payments: [[h.paidFor.get(later)!, ID_TRIES, true], [h.paidFor.get(before)!, ID_TRIES, true]],
      faces: [stampHash(key, m)],
      fingerprints: [[stampHash(key, m), 1]],
      never: [],
    })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a lost passkey stays locked out until five years after Didit first kept the face, whether or not the face was deleted; then the mark that it was deleted goes with the copies, and a new passkey counts as new', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const key = await hkdf(seed.bytes, 'vendor-data')
    const [kept, gone] = [await stampNumber(), await stampNumber()]
    // Two people, both signed at once: one keeps their face, one deletes it.
    assert.equal((await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace')), kept), kept)).status, 200)
    assert.equal((await idStamp(h, await h.idSession(passedId('bob', doc('Byron', { first_name: 'George' })), gone), gone)).status, 200)
    assert.equal((await h.post('/delete', { stampNumber: gone.toString() })).status, 200)
    h.later(DELETE_AFTER_MS)
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deletedUsers, [stampHash(key, gone)], 'its user went with the deletion')
    // The mark of the deletion keeps the date its years end, and nothing is kept "for good".
    const db = () => new DatabaseSync(h.dbPath, { readOnly: true })
    const rows = () => {
      const d = db()
      try {
        return d.prepare('SELECT deleted, until FROM faces ORDER BY deleted').all().map((r) => [r.deleted, r.until])
      } finally {
        d.close()
      }
    }
    assert.deepEqual(rows().map(([deleted]) => deleted), [0, 1])
    assert.equal(rows()[0]![1], rows()[1]![1], 'both end on the same day: five years after the checks were signed')

    // Locked out, a new passkey for either: the held face's by Didit naming it, the deleted one's with no face to name.
    h.later(FACE_KEPT_MS - DELETE_AFTER_MS - 1)
    await h.verifier.sweep()
    const attempt = async (read: Record<string, string>, over: object) => {
      const k = await stampNumber()
      return (await idStamp(h, await h.idSession(passedId('x', read, over), k), k)).status
    }
    assert.equal(await attempt(doc('Lovelace'), { knownFaces: [stampHash(key, kept)] }), 403, 'the face Didit holds, named')
    assert.equal(await attempt(doc('Byron', { first_name: 'George' }), {}), 403, 'the face its person deleted')
    // The day: the held one's user goes, the deleted one's has gone; its copy and its row with it.
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deletedUsers.sort(), [stampHash(key, kept), stampHash(key, gone)].sort(), 'each user once')
    assert.deepEqual(rows(), [])
    const d = db()
    assert.equal(d.prepare('SELECT count(*) AS n FROM fingerprints').get()!.n, 0)
    d.close()
    // A new passkey now counts as new, for either.
    assert.equal(await attempt(doc('Lovelace'), { knownFaces: [stampHash(key, kept)] }), 200)
    assert.equal(await attempt(doc('Byron', { first_name: 'George' }), {}), 200)
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('at start, a file that kept one value with no kind and a deleted face with no date loses that value, whose rows nothing dates, and keeps its faces and its stamps', async () => {
  const dbPath = join(tempDir(), 'verifier.sqlite')
  const old = new DatabaseSync(dbPath)
  old.exec(`
    CREATE TABLE fingerprints (value BLOB NOT NULL, owner BLOB NOT NULL, PRIMARY KEY (value, owner)) WITHOUT ROWID;
    CREATE TABLE faces (owner BLOB PRIMARY KEY, until INTEGER NOT NULL, deleted INTEGER NOT NULL) WITHOUT ROWID;
  `)
  old.prepare('INSERT INTO fingerprints VALUES (?, ?)').run(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))
  old.prepare('INSERT INTO faces VALUES (?, ?, 0)').run(new Uint8Array(32).fill(2), Date.now() + 1000)
  old.close()
  const h = await start({ dbPath })
  try {
    await h.verifier.close()
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = Object.fromEntries(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all().map((t) => [t.name, t.sql]))
    assert.equal(tables.fingerprints, 'CREATE TABLE fingerprints (value BLOB NOT NULL, kind TEXT NOT NULL, owner BLOB NOT NULL, PRIMARY KEY (value, owner)) WITHOUT ROWID')
    assert.equal(db.prepare('SELECT count(*) AS n FROM fingerprints').get()!.n, 0, 'a value with no kind, and no date to end it by, is not kept')
    assert.equal(db.prepare('SELECT count(*) AS n FROM faces').get()!.n, 1)
    db.close()
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a payment’s hash is kept 30 days after its first session, then forgotten; forgotten, it opens nothing, as Stripe says when it was made', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const payment = await h.paid(n)
    await h.idSession(passedId('ada', doc('Lovelace'), { status: 'In Progress' }), n, payment)
    h.later(PAYMENT_KEPT_MS - 1)
    await h.verifier.sweep()
    const kept = () => {
      const db = new DatabaseSync(h.dbPath, { readOnly: true })
      try {
        return db.prepare('SELECT count(*) AS n FROM payments').get()!.n
      } finally {
        db.close()
      }
    }
    assert.equal(kept(), 1)
    h.later(1)
    await h.verifier.sweep()
    assert.equal(kept(), 0)
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 402, body: { error: 'not_paid' } })
  } finally {
    await h.verifier.close()
  }
})

test('refusals, malformed requests, and Didit not answering', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const refused: [ReturnType<typeof passed>, string][] = [
      [passed('g', { workflowId: ID_WORKFLOW }), 'wrong_workflow'],
      [passed('g', { status: 'Declined' }), 'other'],
      [passed('g', { status: 'Declined', risks: ['DUPLICATED_FACE'] }), 'known_face'],
      [passed('g', { status: 'In Review', risks: ['LOW_FACE_LUMINANCE'] }), 'face_unclear'],
      [passed('g', { status: 'Expired' }), 'expired'],
      [passed('g', { status: 'Abandoned' }), 'expired'],
      [passed('g', { status: 'Not Started' }), 'not_approved'],
      [passed('g', { status: 'In Progress' }), 'not_approved'],
      [passed('g', { liveness: [] }), 'wrong_workflow'],
      [passed('g', { liveness: [{ status: 'Declined' }] }), 'wrong_workflow'],
      [passed('g', { faceImage: null }), 'face_unclear'],
      [passed('none'), 'face_unclear'],
    ]
    for (const [decision, error] of refused) {
      assert.deepEqual(await faceCheck(h, decision, await stampNumber()), { status: 403, body: { error } }, error)
    }
    assert.deepEqual(await faceStamp(h, '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a', n), { status: 403, body: { error: 'unknown_session' } })

    const idRefused: [Partial<ReturnType<typeof passed>>, string][] = [
      [{ workflowId: FACE_WORKFLOW }, 'wrong_workflow'],
      [{ status: 'Declined', documents: [{ status: 'Declined' }] }, 'other'],
      [{ status: 'Declined', risks: ['LOW_FACE_MATCH_SIMILARITY'] }, 'face_mismatch'],
      [{ status: 'Expired' }, 'expired'],
      [{ documents: [] }, 'wrong_workflow'],
      [{ documents: [{ status: 'Declined' }] }, 'wrong_workflow'],
      [{ faceMatches: [] }, 'wrong_workflow'],
      [{ faceMatches: [{ status: 'In Review' }] }, 'wrong_workflow'],
      [{ document: null }, 'wrong_workflow'],
      [{ faceImage: null }, 'face_unclear'],
    ]
    for (const [over, error] of idRefused) {
      const person = `p-${randomBytes(4).toString('hex')}`
      const k = await stampNumber()
      assert.deepEqual(await idStamp(h, await h.idSession(passedId(person, doc(person), over), k), k), { status: 403, body: { error } }, error)
    }
    // A face session is not an ID session, and no payment opened it; and the other way round, one application's sessions on another workflow.
    assert.deepEqual(await idStamp(h, await h.session(passed('alice'), n), n, await h.knownPayment()), { status: 402, body: { error: 'not_paid' } })
    assert.deepEqual(await faceStamp(h, await h.idSession(passedId('alice'), n), n), { status: 403, body: { error: 'wrong_workflow' } })

    const sessionId = await h.session(passed('gina'), n)
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
      [{ sessionId, stampNumber: '5', payment: checkoutOf(payment) }, 400, 'bad_payment'],
      [{ sessionId, stampNumber: '5', payment: 'x'.repeat(5000) }, 413, 'too_large'],
    ]
    for (const [body, status, error] of idBad) assert.deepEqual(await h.post('/id/stamp', body), { status, body: { error } }, error)
    // A session is opened for a stamp number, and nothing else.
    const opening: [unknown, string][] = [
      [{}, 'expected_exactly_stampNumber'],
      [{ x: 1 }, 'expected_exactly_stampNumber'],
      [{ stampNumber: 5 }, 'expected_exactly_stampNumber'],
      [{ stampNumber: '5', x: 1 }, 'expected_exactly_stampNumber'],
      [{ stampNumber: '05' }, 'bad_stamp_number'],
      [{ stampNumber: (2n ** 254n).toString() }, 'bad_stamp_number'],
    ]
    for (const [body, error] of opening) assert.deepEqual(await h.post('/face/session', body), { status: 400, body: { error } }, error)
    assert.deepEqual(await h.post('/nowhere'), { status: 404, body: { error: 'not_found' } })
    assert.deepEqual(await h.post('/verifier.json'), { status: 404, body: { error: 'not_found' } })
    assert.equal((await fetch(h.verifier.url + '/face/stamp')).status, 405)
    h.faces.down = true
    assert.deepEqual(await h.post('/face/session', { stampNumber: n.toString() }), { status: 502, body: { error: 'face_check_unavailable' } })
  } finally {
    await h.verifier.close()
  }
})

test('the ID check is paid through Stripe: a Checkout page for a stamp number, sending the person back to an app; the payment carries the stamp number, locked, and opens sessions for it alone', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const n = await stampNumber()
    const made = await h.post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/paid?for=id' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual(Object.keys(made.body).sort(), ['payment', 'url'])
    const { payment } = made.body
    // Its Checkout Session's id, a dot, and the stamp number locked under the key the text `payment` derives: Stripe never sees it.
    assert.match(payment, /^cs_test_[A-Za-z0-9]+\.[A-Za-z0-9_-]{80}$/)
    assert.equal(made.body.url, `https://checkout.stripe.example/c/pay/${checkoutOf(payment)}`)
    assert.equal(payment.includes(n.toString()), false)
    assert.equal(h.payments.returnUrls.get(checkoutOf(payment)), 'https://app.example/paid?for=id', 'Stripe is told where to send the person back')
    for (const returnUrl of ['https://other.example/', 'not a url']) {
      assert.deepEqual(await h.post('/id/payment', { stampNumber: n.toString(), returnUrl }), { status: 400, body: { error: 'bad_return_url' } }, returnUrl)
    }
    for (const [body, code] of [
      [{}, 'expected_exactly_stampNumber'],
      [{ stampNumber: n.toString(), x: 1 }, 'expected_exactly_stampNumber'],
      [{ returnUrl: 'https://app.example/' }, 'expected_exactly_stampNumber_and_returnUrl'],
      [{ stampNumber: n.toString(), returnUrl: 3 }, 'expected_exactly_stampNumber_and_returnUrl'],
      [{ stampNumber: n.toString(), returnUrl: 'https://app.example/', x: 1 }, 'expected_exactly_stampNumber_and_returnUrl'],
    ] as const) {
      assert.deepEqual(await h.post('/id/payment', body), { status: 400, body: { error: code } }, JSON.stringify(body))
    }
    assert.deepEqual(await h.post('/id/payment', { stampNumber: '05', returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_stamp_number' } })

    // Not paid yet: no session, and Stripe is asked again next time.
    const session = (p: string) => h.post('/id/session', { payment: p })
    assert.deepEqual(await session(payment), { status: 402, body: { error: 'not_paid' } })
    const key = await hkdf(seed.bytes, 'payment')
    assert.deepEqual(await session(lockPayment(key, 'cs_test_unknown', n)), { status: 402, body: { error: 'not_paid' } }, 'one Stripe does not have')
    h.payments.pay(payment)
    const opened = await session(payment)
    assert.equal(opened.status, 201)
    assert.deepEqual([h.ids.created, h.faces.created], [1, 0], 'on the ID check’s Didit, and only there')
    assert.equal(h.ids.vendorData.get(opened.body.sessionId), stampHash(await hkdf(seed.bytes, 'vendor-data'), n), 'for the payment’s own stamp number')
    assert.equal(h.payments.state(payment), 'held', 'paying only holds the price')
    const asked = h.payments.asked
    assert.equal((await session(payment)).status, 201)
    assert.equal(h.payments.asked, asked + 1, 'Stripe is asked each time whether it still holds the money')

    // Didit not answering gives the try back.
    h.ids.down = true
    assert.deepEqual(await session(payment), { status: 502, body: { error: 'face_check_unavailable' } })
    h.ids.down = false
    assert.equal((await session(payment)).status, 201, `the try given back: ${ID_TRIES} sessions in all`)
    const asking = h.payments.asked
    assert.deepEqual(await session(payment), { status: 409, body: { error: 'payment_used' } }, 'no more tries')
    assert.equal(h.payments.asked, asking, 'nor a question to Stripe')
    assert.equal(h.ids.created, ID_TRIES)

    // One clock: a payment opens sessions only in its first day; a hold cancelled at Stripe opens none.
    const slow = await h.paid(n)
    assert.equal((await session(slow)).status, 201)
    h.later(OPEN_FOR_MS - 1)
    assert.equal((await session(slow)).status, 201, 'within its day')
    h.later(1)
    assert.deepEqual(await session(slow), { status: 402, body: { error: 'not_paid' } }, 'a day after it was held')
    const dropped = await h.paid(n)
    await h.payments.cancel(checkoutOf(dropped))
    assert.deepEqual(await session(dropped), { status: 402, body: { error: 'not_paid' } }, 'its hold cancelled')
    assert.equal(h.ids.created, ID_TRIES + 2)

    // The payment alone; one the verifier did not make, or altered, opens nothing.
    const fresh = await h.paid(n)
    const [id, locked] = fresh.split('.') as [string, string]
    const other = await h.paid(await stampNumber())
    const flipped = `${locked.slice(0, 20)}${locked[20] === 'A' ? 'B' : 'A'}${locked.slice(21)}`
    const bad: [unknown, string][] = [
      [{}, 'expected_exactly_payment'],
      [{ payment: 5 }, 'expected_exactly_payment'],
      [{ payment: fresh, x: 1 }, 'expected_exactly_payment'],
      [{ payment: fresh, stampNumber: n.toString() }, 'expected_exactly_payment'],
      [{ payment: fresh, returnUrl: 5 }, 'expected_exactly_payment_and_returnUrl'],
      [{ returnUrl: 'https://app.example/' }, 'expected_exactly_payment_and_returnUrl'],
      [{ payment: fresh, returnUrl: 'https://other.example/' }, 'bad_return_url'],
      [{ payment: 'pi_3Mtw' }, 'bad_payment'],
      [{ payment: id }, 'bad_payment'],
      [{ payment: `${id}.${flipped}` }, 'bad_payment'],
      [{ payment: `${checkoutOf(other)}.${locked}` }, 'bad_payment'],
      [{ payment: lockPayment(new Uint8Array(32), id, n) }, 'bad_payment'],
      [{ payment: `cs_test_a/b.${locked}` }, 'bad_payment'],
    ]
    for (const [body, error] of bad) assert.deepEqual(await h.post('/id/session', body), { status: 400, body: { error } }, JSON.stringify(body))

    const unasked = await h.paid(n)
    h.payments.down = true
    assert.deepEqual(await h.post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/' }), { status: 502, body: { error: 'payment_unavailable' } })
    assert.deepEqual(await session(unasked), { status: 502, body: { error: 'payment_unavailable' } })
    assert.equal(h.ids.created, ID_TRIES + 2, 'a refused request never reaches Didit')
  } finally {
    await h.verifier.close()
  }
})

test('one payment, one ID stamp, from a session it opened: a try that will never pass leaves the hold for the next, the last ends it, and a stamp takes it', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const payment = await h.paid(n)
    // Declined, then expired: two tries, and the payment still gives its stamp.
    const declined = await h.idSession(passedId('ada', doc('Lovelace'), { status: 'Declined' }), n, payment)
    assert.deepEqual(await idStamp(h, declined, n), { status: 403, body: { error: 'other' } })
    const expired = await h.idSession(passedId('ada', doc('Lovelace'), { status: 'Expired' }), n, payment)
    assert.deepEqual(await idStamp(h, expired, n), { status: 403, body: { error: 'expired' } })
    assert.equal(h.payments.state(payment), 'held', 'its hold stays for the next try')
    const third = await h.idSession(passedId('ada', doc('Lovelace')), n, payment)
    const signed = await idStamp(h, third, n)
    assert.equal(signed.status, 200, JSON.stringify(signed.body))
    assert.equal(h.payments.state(payment), 'taken', 'a new stamp takes it')

    // Used up: no more sessions, and no stamp for any other session.
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 409, body: { error: 'payment_used' } })
    const b = await stampNumber()
    const other = await h.idSession(passedId('bea', doc('Brontë')), b)
    assert.deepEqual(await idStamp(h, other, b, payment), { status: 409, body: { error: 'payment_used' } }, 'one stamp a payment')
    // Sent again within its hour, the session gives the same stamp, and uses nothing.
    assert.deepEqual((await idStamp(h, third, n)).body, signed.body)

    // A payment Stripe was never asked about, or one that did not open the session: no stamp, and Didit is not asked.
    const sibling = await h.idSession(passedId('cy', doc('Twombly')), await stampNumber())
    h.ids.down = true
    assert.deepEqual(await idStamp(h, other, b, await h.paid(b)), { status: 402, body: { error: 'not_paid' } })
    assert.deepEqual(await idStamp(h, other, b, h.paidFor.get(sibling)), { status: 402, body: { error: 'not_paid' } }, 'a session another payment opened')
    h.ids.down = false
    assert.equal((await idStamp(h, other, b)).status, 200, 'with its own')

    // The last try refused ends the payment: its hold cancelled, at once.
    const d = await stampNumber()
    const last = await h.paid(d)
    for (let i = 0; i < ID_TRIES; i++) {
      const session = await h.idSession(passedId('dee', doc('Dee'), { status: 'Declined' }), d, last)
      assert.deepEqual(await idStamp(h, session, d), { status: 403, body: { error: 'other' } })
      assert.equal(h.payments.state(last), i < ID_TRIES - 1 ? 'held' : 'cancelled', `try ${i + 1}`)
    }
    // Only its newest session ends it: an older one refused after the last was opened leaves the hold
    // for that one, which may still pass.
    const f = await stampNumber()
    const late = await h.paid(f)
    const lateTries = []
    for (let i = 0; i < ID_TRIES; i++) lateTries.push(await h.idSession(passedId('fay', doc('Fay'), { status: 'Declined' }), f, late))
    h.ids.set(lateTries.at(-1)!, passedId('fay', doc('Fay')))
    for (const older of lateTries.slice(0, -1)) assert.deepEqual(await idStamp(h, older, f), { status: 403, body: { error: 'other' } })
    assert.equal(h.payments.state(late), 'held', 'an older try ends nothing')
    assert.equal((await idStamp(h, lateTries.at(-1)!, f)).status, 200, 'and the newest gives its stamp')
    assert.equal(h.payments.state(late), 'taken')

    // An unfinished try, or a session that is none of the ID check's, ends nothing.
    const e = await stampNumber()
    const unfinished = await h.paid(e)
    const sessions = []
    for (let i = 0; i < ID_TRIES; i++) sessions.push(await h.idSession(passedId('eli', doc('Eli'), { status: 'In Progress' }), e, unfinished))
    assert.deepEqual(await idStamp(h, sessions.at(-1)!, e), { status: 403, body: { error: 'not_approved' } })
    h.ids.set(sessions.at(-1)!, passedId('eli', doc('Eli'), { workflowId: FACE_WORKFLOW }))
    assert.deepEqual(await idStamp(h, sessions.at(-1)!, e), { status: 403, body: { error: 'wrong_workflow' } })
    // Asked for another stamp number than the one it was opened for: no try of the payment's either.
    h.ids.set(sessions.at(-1)!, passedId('eli', doc('Eli'), { status: 'Declined' }))
    assert.deepEqual(await idStamp(h, sessions.at(-1)!, n), { status: 409, body: { error: 'session_used' } })
    assert.equal(h.payments.state(unfinished), 'held')
    h.ids.set(sessions[0]!, passedId('eli', doc('Eli')))
    assert.equal((await idStamp(h, sessions[0]!, e)).status, 200, 'and its first session, once done, gives its stamp')
  } finally {
    await h.verifier.close()
  }
})

test('Stripe or Didit failing a request: a 502, and one log line saying why by its status and codes alone, never its words, a key or an id', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const unasked = await h.paid(n)
    const payment = await h.knownPayment()
    const sessionId = await h.session(passed('gina'), n)
    const unavailable = (error: string) => ({ status: 502, body: { error } })

    // Stripe refusing a new payment, as it refuses `payment_method_types`.
    h.payments.down = true
    h.payments.fail = new PaymentUnavailable('Stripe answered 400 to a new payment', { status: 400, codes: ['invalid_request_error', 'payment_method_types_no_longer_supported', 'payment_method_types'] })
    assert.deepEqual(await h.post('/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/' }), unavailable('payment_unavailable'))
    // Stripe refusing the key, asked about a payment: of what it sent, only what is a code.
    const sent = ['invalid_request_error', 'Invalid API Key provided: sk_test_****ndin', 'sk_test_51standin', `sk_test_${'a'.repeat(99)}`, checkoutOf(unasked), unasked, sessionId, 'X', 'a'.repeat(65), { code: 'x' }]
    h.payments.fail = new PaymentUnavailable('Stripe answered 401 to a payment', { status: 401, codes: sent })
    assert.deepEqual(await h.post('/id/session', { payment: unasked }), unavailable('payment_unavailable'))
    // Stripe not reached: the error's kind alone.
    h.payments.fail = new PaymentUnavailable('Stripe could not be reached')
    assert.deepEqual(await h.post('/id/session', { payment: unasked }), unavailable('payment_unavailable'))
    h.payments.down = false

    // Didit refusing to open a session, then to say what one decided; the photo's address refusing.
    h.faces.down = true
    h.faces.fail = new DiditUnavailable('Didit answered 402 to a new session', { status: 402, codes: ['insufficient_credits'] })
    assert.deepEqual(await h.post('/face/session', { stampNumber: n.toString() }), unavailable('face_check_unavailable'))
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
    const m = await stampNumber()
    const held = await h.paid(m)
    const taking = await h.idSession(passedId('ivo', doc('Ivo')), m, held)
    h.payments.down = true
    h.payments.fail = new PaymentUnavailable('Stripe answered 500 to a capture', { status: 500, codes: ['api_error'] })
    assert.deepEqual(await idStamp(h, taking, m), unavailable('payment_unavailable'))
    assert.equal(h.logs.at(-1), 'verifier: payment_unavailable (PaymentUnavailable 500 api_error)')
    assert.equal(h.payments.state(held), 'held')
    h.payments.down = false
    assert.equal((await idStamp(h, taking, m)).status, 200)
    // Failing to cancel one: the refusal still answered, and the hold left for the hourly search.
    const o = await stampNumber()
    const again = await h.idSession(refusedWith(['DUPLICATED_FACE'], { workflowId: ID_WORKFLOW }), o)
    h.payments.down = true
    assert.deepEqual(await idStamp(h, again, o), { status: 403, body: { error: 'known_face' } })
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

/**
 * The payment page's own script, run as a browser would run it inside an app's frame, with `hash` its
 * address after the `#`: a stand-in for Stripe's script and for the app around it. What it gave
 * Stripe, where it mounted the Checkout, and each message it posted, with the origin it was posted to.
 */
async function runPage(html: string, hash: string) {
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)![1]!
  const seen = { key: '', options: {} as Record<string, any>, mounted: '', posted: [] as [unknown, string][] }
  runInNewContext(script, {
    location: { hash },
    parent: { postMessage: (message: unknown, origin: string) => seen.posted.push([message, origin]) },
    Stripe: (key: string) => {
      seen.key = key
      return {
        createEmbeddedCheckoutPage: async (options: Record<string, any>) => {
          seen.options = options
          return { mount: (where: string) => (seen.mounted = where) }
        },
      }
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  return seen
}

test('the payment page: the same payment, made to embed, answered with its client secret; the one page Stripe’s script loads on, which only the apps may frame, and which posts one message, to the apps alone, once the person has paid; the verifier still asks Stripe', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const n = await stampNumber()
    const made = await h.post('/id/payment', { stampNumber: n.toString() })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual(Object.keys(made.body).sort(), ['clientSecret', 'payment'])
    const { payment, clientSecret } = made.body
    assert.match(payment, /^cs_test_[A-Za-z0-9]+\.[A-Za-z0-9_-]{80}$/, 'the payment as the hosted page’s is: its stamp number locked in it')
    assert.equal(h.payments.clientSecrets.get(checkoutOf(payment)), clientSecret, 'Stripe’s client secret, as Stripe answered it')
    assert.equal(h.payments.returnUrls.get(checkoutOf(payment)), undefined, 'made to embed, with no page to send the person back to')
    assert.equal(h.payments.added.get(checkoutOf(payment)), false, 'at the price, as the stamp number holds no ID stamp')

    // The page's message is no proof: the app sends the payment, and the verifier asks Stripe.
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 402, body: { error: 'not_paid' } })
    h.payments.pay(payment)
    const opened = await h.post('/id/session', { payment })
    assert.equal(opened.status, 201, JSON.stringify(opened.body))
    assert.equal(h.ids.vendorData.get(opened.body.sessionId), stampHash(await hkdf(seed.bytes, 'vendor-data'), n), 'for the payment’s own stamp number')
    h.ids.set(opened.body.sessionId, passedId('ada', doc('Lovelace')))
    assert.equal((await idStamp(h, opened.body.sessionId, n, payment)).status, 200)
    assert.equal(h.payments.state(payment), 'taken', 'the stamp takes the hold, as for the hosted page')
    const added = await h.post('/id/payment', { stampNumber: n.toString() })
    assert.equal(h.payments.added.get(checkoutOf(added.body.payment)), true, 'and the next is at the added-ID price')

    // The page: the same for every payment, whose client secret comes after its `#`, never to the verifier.
    const res = await fetch(h.verifier.url + '/id/pay')
    assert.equal(res.status, 200)
    assert.deepEqual(
      Object.fromEntries(['content-type', 'cache-control', 'content-security-policy', 'permissions-policy', 'access-control-allow-origin'].map((name) => [name, res.headers.get(name)])),
      {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': 'frame-ancestors https://app.example',
        'permissions-policy': 'payment=(self "https://js.stripe.com" "https://checkout.stripe.com")',
        'access-control-allow-origin': null,
      },
    )
    const html = await res.text()
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src), ['https://js.stripe.com/endive/stripe.js'], 'Stripe’s script, of the release STRIPE_VERSION is in, and no other')
    assert.equal(/"\*"|'\*'/.test(html), false, 'no message to any origin')
    const page = await runPage(html, '#' + clientSecret)
    assert.equal(page.key, 'pk_test_standin', 'the key’s publishable key')
    assert.deepEqual(Object.keys(page.options).sort(), ['fetchClientSecret', 'onComplete'])
    assert.equal(await page.options.fetchClientSecret(), clientSecret, 'the client secret from after the #')
    assert.equal(page.mounted, '#checkout')
    assert.deepEqual(page.posted, [], 'no message before the person has paid')
    page.options.onComplete()
    page.options.onComplete()
    assert.deepEqual(page.posted, [[PAYMENT_DONE, 'https://app.example']], 'one message, to the app’s origin alone')
    assert.equal(PAYMENT_DONE, 'payment_done')

    // Stripe's script is on that page alone, and the client secret in no log.
    assert.equal((await (await fetch(h.verifier.url + '/')).text()).includes('js.stripe.com'), false)
    assert.equal(h.logs.some((line) => line.includes(clientSecret) || line.includes(checkoutOf(payment))), false)
    assert.deepEqual(await h.post('/id/pay'), { status: 405, body: { error: 'get_only' } })
    assert.equal((await fetch(h.verifier.url + '/id/pay?x')).status, 404, 'nothing comes in its address')
  } finally {
    await h.verifier.close()
  }
})

test('the payment page may be framed by each app in APP_ORIGINS and posts to each, so only the one framing it gets the message; with none, nobody may frame it', async () => {
  for (const [origins, ancestors, posted] of [
    ['https://app.example, http://localhost:5173', 'frame-ancestors https://app.example http://localhost:5173', ['https://app.example', 'http://localhost:5173']],
    [undefined, "frame-ancestors 'none'", []],
  ] as const) {
    const h = await start({ env: { APP_ORIGINS: origins } })
    try {
      const res = await fetch(h.verifier.url + '/id/pay')
      assert.equal(res.headers.get('content-security-policy'), ancestors)
      const page = await runPage(await res.text(), '#cs_test_a1_secret_b2')
      page.options.onComplete()
      assert.deepEqual(page.posted, posted.map((origin) => [PAYMENT_DONE, origin]))
    } finally {
      await h.verifier.close()
    }
  }
})

test('POST /id/cancel: a payment that gave no stamp has its hold cancelled at once, and opens no more sessions; one that gave a stamp, or holds nothing, is not', async () => {
  const h = await start()
  try {
    const cancel = (body: unknown) => h.post('/id/cancel', body)
    // Paid, a session open: the hold cancelled, the payment used up, its session giving no stamp.
    const n = await stampNumber()
    const payment = await h.paid(n)
    const sessionId = await h.idSession(passedId('ada', doc('Lovelace')), n, payment)
    assert.deepEqual(await cancel({ payment }), { status: 200, body: { cancelled: true } })
    assert.equal(h.payments.state(payment), 'cancelled')
    assert.deepEqual(await cancel({ payment }), { status: 200, body: { cancelled: true } }, 'cancelled before: the same answer')
    assert.deepEqual(await h.post('/id/session', { payment }), { status: 409, body: { error: 'payment_used' } })
    assert.deepEqual(await idStamp(h, sessionId, n), { status: 409, body: { error: 'payment_used' } })
    // Paid and no session yet: cancelled too, and Stripe holding nothing, it opens none.
    const m = await stampNumber()
    const unused = await h.paid(m)
    assert.deepEqual(await cancel({ payment: unused }), { status: 200, body: { cancelled: true } })
    assert.deepEqual(await h.post('/id/session', { payment: unused }), { status: 402, body: { error: 'not_paid' } })
    // A payment that gave a stamp: its price taken, nothing to cancel.
    const k = await stampNumber()
    const stamped = await h.idSession(passedId('kim', doc('Kim')), k)
    assert.equal((await idStamp(h, stamped, k)).status, 200)
    assert.deepEqual(await cancel({ payment: h.paidFor.get(stamped) }), { status: 409, body: { error: 'payment_used' } })
    assert.equal(h.payments.state(h.paidFor.get(stamped)!), 'taken')
    // Not paid yet, or not this verifier's.
    const { body: made } = await h.post('/id/payment', { stampNumber: (await stampNumber()).toString() })
    assert.deepEqual(await cancel({ payment: made.payment }), { status: 402, body: { error: 'not_paid' } })
    for (const [body, error] of [[{}, 'expected_exactly_payment'], [{ payment, x: 1 }, 'expected_exactly_payment'], [{ payment: checkoutOf(payment) }, 'bad_payment'], [{ payment: 5 }, 'expected_exactly_payment']] as const) {
      assert.deepEqual(await cancel(body), { status: 400, body: { error } }, JSON.stringify(body))
    }
    // Stripe not answering: a 502, logged by its kind, and nothing used.
    const p = await stampNumber()
    const held = await h.paid(p)
    h.payments.down = true
    assert.deepEqual(await cancel({ payment: held }), { status: 502, body: { error: 'payment_unavailable' } })
    h.payments.down = false
    assert.equal(h.payments.state(held), 'held')
    assert.equal((await fetch(h.verifier.url + '/id/cancel')).status, 405)
  } finally {
    await h.verifier.close()
  }
})

test('without Stripe the ID check is not for sale; the face check is free', async () => {
  const h = await start({ forSale: false })
  try {
    for (const [path, body] of [
      ['/id/payment', { stampNumber: '5', returnUrl: 'https://app.example/' }],
      ['/id/session', { payment: 'cs_test_a1' }],
      ['/id/stamp', { sessionId: '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a', stampNumber: '5', payment: 'cs_test_a1' }],
      ['/id/cancel', { payment: 'cs_test_a1' }],
    ] as const) {
      assert.deepEqual(await h.post(path, body), { status: 503, body: { error: 'not_for_sale' } }, path)
    }
    const page = await fetch(h.verifier.url + '/id/pay')
    assert.deepEqual([page.status, await page.json()], [503, { error: 'not_for_sale' }], 'and no payment page')
    assert.equal(h.ids.created, 0)
    assert.equal((await face(h, 'alice', await stampNumber())).stamp.verifier, h.verifier.keys.face)
  } finally {
    await h.verifier.close()
  }
})

test('the file keeps which session gave which stamp number and which check it was, and the stamps it signed: nothing of who the person is', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const a = await face(h, 'alice', n1)
    const b = await face(h, 'bob', n2)
    const id = await h.idSession(passedId('alice', doc('Lovelace', { 'extra_fields.profession': 'Analyst' })), n1)
    const res = await idStamp(h, id, n1)
    assert.equal(res.status, 200)
    // A later check for the same stamp number, another document, gives its own ID stamp, and writes nothing of its document either.
    const later = await h.idSession(passedId('alice', doc('Lovelace', { document_number: 'CD7654321', place_of_birth: 'Marylebone' })), n1)
    const added = await idStamp(h, later, n1)
    assert.equal(added.status, 200)
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
      // Each stamp number's face, its first; and n1's scrambled copy, one row for both its IDs, as they read the same details.
      faces: [a.sessionId, b.sessionId].map((s) => h.faces.vendorData.get(s)!),
      fingerprints: [[h.ids.vendorData.get(id)!, 1]],
      // The stamp's facts and signature are kept; the list beside it is not, nor any of its names, values or salts, nor any vendor_data as Didit writes it.
      never: [
        ...['Lovelace', 'lovelace', '1990-04-01', 'AB1234567', 'CD7654321', '12 St James Square', 'Marylebone', 'Analyst', 'date_of_birth', 'document_number', 'embedding'],
        ...['test-model', ...[a.stamp, res.body.stamp, added.body.stamp].flatMap((stamp) => stamp.factList.flatMap((f: { value: string; salt: string }) => [f.value, f.salt]))],
        ...[a.sessionId, b.sessionId, id, later].map((s) => (h.faces.vendorData.get(s) ?? h.ids.vendorData.get(s))!),
      ],
    })
    assert.equal(readFileSync(h.dbPath).includes(Buffer.from(faceOf('alice'))), false, 'no embedding')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('the stamps asked back by their stamp number are the ones signed, without their lists, for both keys, with the free face tries left, and after their sessions are deleted in Didit', async () => {
  const dbPath = join(tempDir(), 'verifier.sqlite')
  let h = await start({ dbPath })
  try {
    const [n, m] = [await stampNumber(), await stampNumber()]
    const signedFace = await face(h, 'alice', n)
    const id = await h.idSession(passedId('alice', doc('Lovelace')), n)
    const signedId = await idStamp(h, id, n)
    assert.equal(signedId.status, 200)
    const back = await stampBack(h, n)
    assert.equal(back.status, 200)
    assert.deepEqual(back.body, { face: own(signedFace.stamp), id: [own(signedId.body.stamp)], faceTriesLeft: FACE_TRIES, deletion: null }, 'each the one signed, without the list beside it')
    for (const stamp of [back.body.face, ...back.body.id]) assert.deepEqual(Object.keys(stamp).sort(), ['facts', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    const published = await about(h)
    assert.deepEqual([back.body.face.verifier, back.body.id[0].verifier], [published.face.key, published.id.key])
    assert.ok(stampSigned(stampFromJson(back.body.face)) && stampSigned(stampFromJson(back.body.id[0])))

    // A number with a face stamp only: no ID stamp.
    const bob = await face(h, 'bob', m)
    assert.deepEqual((await stampBack(h, m)).body, { face: own(bob.stamp), id: [], faceTriesLeft: FACE_TRIES, deletion: null })
    // A later check for the same number, with its own face, answers its own stamp; the first stays the one handed back.
    const later = await face(h, 'alice', n)
    assert.notEqual(later.stamp.facts, signedFace.stamp.facts)
    assert.deepEqual((await stampBack(h, n)).body, back.body)

    // The sessions deleted in Didit, face and ID, and the verifier started again on the same file: the stamps still come back.
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

test('at start, a kept stamp its key did not sign is forgotten, for both keys, and its stamp number’s next checks keep new ones', async () => {
  const seed = seedJson()
  const dbPath = join(tempDir(), 'verifier.sqlite')
  const n = await stampNumber()
  // A face stamp and an ID stamp kept for n from the keys the texts `face` and `id-fields` derive, the recipes before these.
  const file = new Store(dbPath)
  for (const [kind, text] of [['face', 'face'], ['id', 'id-fields']] as const) {
    const before = signStamp(await hkdf(seed.bytes, text), { stampNumber: n, facts: 5n, verifierName: VERIFIER_NAME })
    assert.equal(file.remember({ sessionId: randomUUID(), stampNumber: n, vendorData: 'ab'.repeat(32), kind, since: 0, signedAt: Date.now(), faceUntil: Date.now(), stamp: before }), 'ok')
  }
  file.close()

  let h = await start({ seed: seed.json, dbPath })
  try {
    assert.deepEqual(await stampBack(h, n), { status: 200, body: { face: null, id: [], faceTriesLeft: FACE_TRIES, deletion: null } }, 'both forgotten')
    // n holds no stamp now: its face check needs no face of its own, and gets a new face stamp.
    const signedFace = await face(h, 'ada', n)
    assert.equal(signedFace.stamp.verifier, h.verifier.keys.face)
    assert.notEqual(signedFace.stamp.facts, '5')
    const res = await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace')), n), n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.stamp.verifier, h.verifier.keys.id)
    assert.notEqual(res.body.stamp.facts, '5')
    assert.deepEqual(Object.fromEntries(factListOf(stampFromJson(res.body.stamp)).slice(2).map((f) => [f.name, f.value])), doc('Lovelace'), 'a new stamp, with its list')
    assert.ok(stampSigned(stampFromJson(res.body.stamp)))

    // Started again: the stamps its own keys signed stay.
    await h.verifier.close()
    h = await start({ dbPath })
    assert.deepEqual((await stampBack(h, n)).body, { face: own(signedFace.stamp), id: [own(res.body.stamp)], faceTriesLeft: FACE_TRIES, deletion: null })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('at start, a file an earlier version wrote moves to these tables: its stamps kept, one row each, its signed sessions keep their faces, its payments counted from now, and its old fingerprints dropped', async () => {
  const seed = seedJson()
  const dbPath = join(tempDir(), 'verifier.sqlite')
  const n = await stampNumber()
  const sessionId = randomUUID()
  const clock = Date.now()
  // The earlier tables: one stamp per stamp number and key, and no `keep_face`, with a face stamp and an ID stamp of n's, signed by this verifier's keys.
  const before = new DatabaseSync(dbPath)
  before.exec(`
    CREATE TABLE stamps (stamp_number BLOB NOT NULL, kind TEXT NOT NULL, facts BLOB NOT NULL, r8 BLOB NOT NULL, s BLOB NOT NULL, PRIMARY KEY (stamp_number, kind)) WITHOUT ROWID;
    CREATE TABLE to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE payments (hash BLOB PRIMARY KEY, tries INTEGER NOT NULL, stamped INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE fingerprints (fingerprint BLOB PRIMARY KEY, stamp_number BLOB NOT NULL) WITHOUT ROWID;
  `)
  before.prepare('INSERT INTO payments VALUES (?, 3, 1)').run(new Uint8Array(32))
  before.prepare('INSERT INTO fingerprints VALUES (?, ?)').run(new Uint8Array(32), toBytes32(n))
  const signed: Record<string, ReturnType<typeof signStamp>> = {}
  for (const [kind, text] of [['face', 'face-facts'], ['id', 'id-facts']] as const) {
    const stamp = (signed[kind] = signStamp(await hkdf(seed.bytes, text), { stampNumber: n, facts: kind === 'face' ? 7n : 8n, verifierName: VERIFIER_NAME }))
    const r8 = Buffer.concat([toBytes32(stamp.signature.R8[0]), toBytes32(stamp.signature.R8[1])])
    before.prepare('INSERT INTO stamps VALUES (?, ?, ?, ?, ?)').run(toBytes32(n), kind, toBytes32(stamp.facts), r8, toBytes32(stamp.signature.S))
  }
  before.prepare('INSERT INTO to_delete VALUES (?, ?, ?)').run(sessionId, 'face', clock - SIGNED_FOR_MS)
  before.close()

  const h = await start({ seed: seed.json, dbPath })
  try {
    const json = (stamp: ReturnType<typeof signStamp>) => JSON.parse(JSON.stringify(stampToJson(stamp)))
    assert.deepEqual((await stampBack(h, n)).body, { face: own(json(signed.face!)), id: [own(json(signed.id!))], faceTriesLeft: FACE_TRIES, deletion: null })
    // Its signed session still keeps its face when the sweep deletes it.
    h.faces.set(sessionId, passed('ada'))
    await h.verifier.sweep()
    assert.deepEqual(h.faces.keptFaces, [sessionId])
    await h.verifier.close()
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = Object.fromEntries(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all().map((t) => [t.name, t.sql]))
    db.close()
    assert.equal(tables.stamps, 'CREATE TABLE stamps (stamp_number BLOB NOT NULL, kind TEXT NOT NULL, facts BLOB NOT NULL, r8 BLOB NOT NULL, s BLOB NOT NULL, PRIMARY KEY (stamp_number, kind, facts)) WITHOUT ROWID')
    assert.equal(tables.to_delete, 'CREATE TABLE to_delete (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, signed_at INTEGER NOT NULL, keep_face INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID')
    assert.equal(tables.fingerprints, 'CREATE TABLE fingerprints (value BLOB NOT NULL, kind TEXT NOT NULL, owner BLOB NOT NULL, PRIMARY KEY (value, owner)) WITHOUT ROWID')
    assert.match(tables.payments, /^CREATE TABLE payments \(hash BLOB PRIMARY KEY, tries INTEGER NOT NULL, stamped INTEGER NOT NULL, at INTEGER NOT NULL DEFAULT \d+\) WITHOUT ROWID$/)
    assert.equal('stamps_before' in tables, false)
    const kept = new DatabaseSync(dbPath, { readOnly: true })
    const payment = kept.prepare('SELECT tries, stamped, at FROM payments').all()
    const codes = kept.prepare('SELECT count(*) AS n FROM fingerprints').get()!.n
    kept.close()
    assert.equal(payment.length, 1)
    assert.ok((payment[0]!.at as number) >= clock, 'counted from when it moved, so it goes 30 days later')
    assert.equal(codes, 0, 'none of the old fingerprints is left')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('a stamp number nothing was kept for holds no stamp and both free face tries, and a body with any other field is refused', async () => {
  const h = await start()
  try {
    assert.deepEqual(await stampBack(h, await stampNumber()), { status: 200, body: { face: null, id: [], faceTriesLeft: FACE_TRIES, deletion: null } })
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
  assert.throws(() => readConfig({}), /missing environment variables: DIDIT_API_KEY, DIDIT_FACE_WORKFLOW_ID, DIDIT_ID_WORKFLOW_ID$/)
  assert.throws(() => readConfig({ DIDIT_FACE_API_KEY: 'kf', DIDIT_ID_API_KEY: 'ki', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_WORKFLOW_ID: 'i' }), /missing environment variables: DIDIT_API_KEY$/, 'one key, for the one application both checks run in')
  const base = { DIDIT_API_KEY: 'k', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_WORKFLOW_ID: 'i' }
  const config = readConfig(base)
  assert.equal(config.diditApiKey, 'k')
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

  // Stripe: with its key the ID check is for sale, for the two Prices named, with its publishable key,
  // of the same mode, for the payment page; the Prices alone sell nothing; no key is ever quoted.
  const price = 'price_1UXRbDILoxkbMfX4cfwRfCOI'
  const addedPrice = 'price_1UXRbDILoxkbMfX4added00'
  const prices = { STRIPE_ID_PRICE: price, STRIPE_ADDED_ID_PRICE: addedPrice }
  const test = { ...prices, STRIPE_PUBLISHABLE_KEY: 'pk_test_51pub' }
  assert.equal(config.stripe, undefined)
  assert.equal(readConfig({ ...base, ...test }).stripe, undefined)
  for (const key of ['sk_test_51abc', 'rk_test_51abc', 'sk_live_51abc', 'rk_live_51abc']) {
    const publishableKey = key.includes('_test_') ? 'pk_test_51pub' : 'pk_live_51pub'
    assert.deepEqual(readConfig({ ...base, STRIPE_SECRET_KEY: key, ...prices, STRIPE_PUBLISHABLE_KEY: publishableKey }).stripe, { secretKey: key, publishableKey, price, addedPrice })
  }
  for (const missing of [{}, { STRIPE_ID_PRICE: price }, { STRIPE_ADDED_ID_PRICE: addedPrice }]) {
    assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_51abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_51pub', ...missing }), /STRIPE_SECRET_KEY needs STRIPE_ID_PRICE and STRIPE_ADDED_ID_PRICE/)
  }
  assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_51abc', ...prices }), /STRIPE_SECRET_KEY needs STRIPE_PUBLISHABLE_KEY/)
  for (const [secretKey, publishableKey] of [['sk_test_51abc', 'pk_live_51pub'], ['rk_live_51abc', 'pk_test_51pub']]) {
    assert.throws(
      () => readConfig({ ...base, STRIPE_SECRET_KEY: secretKey, ...prices, STRIPE_PUBLISHABLE_KEY: publishableKey }),
      (error: Error) => /STRIPE_PUBLISHABLE_KEY is of another mode than STRIPE_SECRET_KEY/.test(error.message) && !error.message.includes('51abc') && !error.message.includes('51pub'),
    )
  }
  assert.throws(
    () => readConfig({ ...base, STRIPE_PUBLISHABLE_KEY: 'sk_test_51secret' }),
    (error: Error) => /STRIPE_PUBLISHABLE_KEY is a Stripe publishable key/.test(error.message) && !error.message.includes('51secret'),
  )
  assert.throws(
    () => readConfig({ ...base, STRIPE_SECRET_KEY: 'pk_test_51secret', ...prices }),
    (error: Error) => /STRIPE_SECRET_KEY is a Stripe secret key/.test(error.message) && !error.message.includes('51secret'),
  )
  assert.throws(() => readConfig({ ...base, STRIPE_ID_PRICE: 'prod_VYYiTk7BVWOSdv' }), /STRIPE_ID_PRICE is a Stripe Price/)
  assert.throws(() => readConfig({ ...base, STRIPE_ADDED_ID_PRICE: 'prod_VYYiTk7BVWOSdv' }), /STRIPE_ADDED_ID_PRICE is a Stripe Price/)
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
    const sessionId = await h.session(passed('alice'), n)
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
    const bob = await h.session(passed('bob'), m)
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
    const id = await h.idSession(passedId('bob', doc('Byron')), m)
    const seven = await buy(host.service, 7)
    const payment = h.paidFor.get(id)
    const idStamp = await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), payment, gift: seven.reference })
    assert.equal(idStamp.status, 200)
    assert.equal(idStamp.body.gift.ticket.split('.')[1], '7', 'the ID check’s credits')
    const paid = await host.seller.collect(seven.buy, `ticket ${idStamp.body.gift.ticket}`)
    assert.equal((await finish(seven.pending, paid.body as Uint8Array)).length, 7)
    assert.deepEqual((await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), payment, gift: (await buy(host.service, 7)).reference })).body.gift, { error: 'given' })

    // An ID check that gives a face stamp too gives the ID stamp's gift alone: it stands for both.
    const q = await stampNumber()
    const qid = await h.idSession(passedId('quin', doc('Quin')), q)
    const both = await h.post('/id/stamp', { sessionId: qid, stampNumber: q.toString(), payment: h.paidFor.get(qid), gift: (await buy(host.service, 7)).reference })
    assert.equal(both.body.face.verifier, h.verifier.keys.face)
    assert.equal(both.body.gift.ticket.split('.')[1], '7')
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()
    assertKept(h.dbPath, {
      sessions: [[sessionId, n, 'face'], [bob, m, 'face'], [id, m, 'id'], [qid, q, 'id']],
      gifts: [n, m],
      idGifts: [m, q],
      payments: [[payment!, ID_TRIES, true], [h.paidFor.get(qid)!, ID_TRIES, true]],
      faces: [h.faces.vendorData.get(sessionId)!, h.faces.vendorData.get(bob)!, h.ids.vendorData.get(qid)!],
      fingerprints: [[h.ids.vendorData.get(id)!, 1], [h.ids.vendorData.get(qid)!, 1]],
      never: [mine.reference, six.reference, seven.reference, ticket],
    })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('with no gift, a stamp asked for with one is refused; so is one from a check whose gift is 0', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const sessionId = await h.session(passed('alice'), n)
    const res = await h.post('/face/stamp', { sessionId, stampNumber: n.toString(), gift: 'x' })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_stampNumber' }])
    assert.equal((await about(h)).gift, undefined)
  } finally {
    await h.verifier.close()
  }
  // A check whose gift is 0 gives none, and refuses its stamp asked with one, the same way.
  const faceOnly = await start({ env: { HOST_URL: 'https://host.example', ID_CREDITS: '0' } })
  try {
    const n = await stampNumber()
    const id = await faceOnly.idSession(passedId('ada', doc('Lovelace')), n)
    const res = await faceOnly.post('/id/stamp', { sessionId: id, stampNumber: n.toString(), payment: faceOnly.paidFor.get(id), gift: 'x' })
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
  assert.equal(JSON.parse(published).face.key, serviceKey(await seed.derive('face-facts')).address, 'GET / names the face key derived from it')
  assert.equal(JSON.parse(published).id.key, serviceKey(await seed.derive('id-facts')).address, 'and the ID key')
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
  const h = await start()
  try {
    const stampNumber_ = (await stampNumber()).toString()
    const opened = await h.post('/face/session', { stampNumber: stampNumber_, returnUrl: 'https://app.example/checked?from=face' })
    assert.equal(opened.status, 201)
    assert.equal(h.faces.callbacks.get(opened.body.sessionId), 'https://app.example/checked?from=face', 'Didit is told where to send the person back')
    assert.equal(h.faces.callbacks.get((await h.post('/face/session', { stampNumber: stampNumber_ })).body.sessionId), undefined, 'none asked, none sent')
    for (const returnUrl of ['https://other.example/', 'http://app.example/', 'https://app.example.evil/', 'not a url']) {
      assert.deepEqual(await h.post('/face/session', { stampNumber: stampNumber_, returnUrl }), { status: 400, body: { error: 'bad_return_url' } }, returnUrl)
    }
    assert.deepEqual(await h.post('/face/session', { stampNumber: stampNumber_, returnUrl: 3 }), { status: 400, body: { error: 'expected_exactly_stampNumber_and_returnUrl' } })
    assert.deepEqual(await h.post('/face/session', { returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'expected_exactly_stampNumber_and_returnUrl' } })
    assert.deepEqual(await h.post('/face/session', { stampNumber: stampNumber_, returnUrl: 'https://app.example/', x: 1 }), { status: 400, body: { error: 'expected_exactly_stampNumber_and_returnUrl' } })
    assert.equal(h.faces.created, 2, 'a refused request never reaches Didit')
    // The ID check, the same way, and its payment's page too.
    const payment = await h.paid(BigInt(stampNumber_))
    const id = await h.post('/id/session', { payment, returnUrl: 'https://app.example/checked?from=id' })
    assert.equal(id.status, 201)
    assert.equal(h.ids.callbacks.get(id.body.sessionId), 'https://app.example/checked?from=id')
    assert.deepEqual(await h.post('/id/session', { payment, returnUrl: 'https://other.example/' }), { status: 400, body: { error: 'bad_return_url' } })
    assert.equal(h.ids.created, 1)
    assert.deepEqual(await h.post('/id/payment', { stampNumber: stampNumber_, returnUrl: 'https://app.example.evil/' }), { status: 400, body: { error: 'bad_return_url' } })
  } finally {
    await h.verifier.close()
  }
  const none = await start({ env: { APP_ORIGINS: undefined } })
  try {
    assert.deepEqual(await none.post('/face/session', { stampNumber: '5', returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_return_url' } }, 'with no APP_ORIGINS, no return URL is taken')
    assert.deepEqual(await none.post('/id/payment', { stampNumber: '5', returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_return_url' } }, 'so no payment page either')
  } finally {
    await none.verifier.close()
  }
})

test('the stand-in for tests: test/fake-didit.ts and the stand-in embedding, both checks for two people, each under one Didit user, and a face Didit has seen, refused', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const fake = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, 'fake-didit.ts')], {
    env: { ...process.env, FAKE_DIDIT_PORT: String(port), FAKE_DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW, FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve) => fake.stdout!.once('data', () => resolve()))
  const baseUrl = `http://127.0.0.1:${port}`
  const config = readConfig({
    VERIFIER_NAME,
    DIDIT_API_KEY: 'fake-didit',
    DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DIDIT_BASE_URL: baseUrl,
    FACE_MODEL: 'stand-in',
    APP_ORIGINS: 'https://app.example',
    DATABASE_PATH: join(tempDir(), 'verifier.sqlite'),
    PORT: '0',
  })
  const didit = new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, baseUrl })
  let clock = Date.now()
  const payments = new FakePayments()
  const verifier = await startVerifier(config, { log: () => {}, now: () => clock, payments })
  const seen = await startVerifier(
    { ...config, databasePath: join(tempDir(), 'verifier.sqlite') },
    { faceCheck: new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, baseUrl, scenario: 'duplicated_face' }), log: () => {}, now: () => clock },
  )
  try {
    const post = async (at: Verifier, path: string, body: unknown = {}) => {
      const res = await fetch(at.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    const signedFaces: string[] = []
    for (let person = 0; person < 2; person++) {
      const n = await stampNumber()
      const face = await post(verifier, '/face/session', { stampNumber: n.toString() })
      signedFaces.push(face.body.sessionId)
      const faceStamp = await post(verifier, '/face/stamp', { sessionId: face.body.sessionId, stampNumber: n.toString() })
      assert.equal(faceStamp.status, 200, JSON.stringify(faceStamp.body))
      assert.equal(factListOf(stampFromJson(faceStamp.body.stamp))[0]!.value, 'stand-in', 'the model the stamp names')
      assert.equal(faceStamp.body.stamp.verifier, verifier.keys.face)
      assert.ok(stampSigned(stampFromJson(faceStamp.body.stamp)))
      assert.equal((await didit.decision(face.body.sessionId))?.status, 'Approved', 'still in Didit once its stamp is signed')
      const again = await post(verifier, '/face/stamp', { sessionId: face.body.sessionId, stampNumber: n.toString() })
      assert.deepEqual(again.body.stamp, faceStamp.body.stamp, 'within the hour, the same stamp')
      const { body: paid } = await post(verifier, '/id/payment', { stampNumber: n.toString(), returnUrl: 'https://app.example/paid' })
      const { payment } = paid
      payments.pay(payment)
      const id = await post(verifier, '/id/session', { payment })
      assert.equal(id.status, 201, JSON.stringify(id.body))
      const idStamp = await post(verifier, '/id/stamp', { sessionId: id.body.sessionId, stampNumber: n.toString(), payment })
      assert.equal(idStamp.status, 200, JSON.stringify(idStamp.body))
      assert.equal(idStamp.body.stamp.verifier, verifier.keys.id)
      const list = factListOf(stampFromJson(idStamp.body.stamp))
      const fields = Object.fromEntries(list.map((f) => [f.name, f.value]))
      assert.deepEqual([fields.model, fields.date_of_birth, fields.issuing_state], ['stand-in', '1990-01-01', 'GBR'])
      assert.equal(stampFromJson(idStamp.body.stamp).facts, factsNumber(list))
      // Both checks under one Didit user: the same vendor_data.
      const decision = await new DiditClient({ apiKey: 'fake-didit', workflowId: ID_WORKFLOW, baseUrl }).decision(id.body.sessionId)
      assert.equal(decision!.vendorData, (await didit.decision(face.body.sessionId))!.vendorData)
      assert.ok(stampSigned(stampFromJson(idStamp.body.stamp)))
    }
    // An hour on, the sweep deletes every signed face session in Didit, asking it to keep the face template.
    clock += SIGNED_FOR_MS
    await verifier.sweep()
    assert.deepEqual(await didit.decision(signedFaces[0]!), null, 'deleted in Didit')
    assert.deepEqual(await post(verifier, '/face/stamp', { sessionId: signedFaces[0], stampNumber: (await stampNumber()).toString() }), { status: 409, body: { error: 'session_used' } })

    // A session opened with a scenario declining a face Didit has seen: `known_face`, from the risk that
    // set its status, and the next sweep deletes it in Didit.
    const seenNumber = (await stampNumber()).toString()
    const declined = await post(seen, '/face/session', { stampNumber: seenNumber })
    assert.deepEqual(await post(seen, '/face/stamp', { sessionId: declined.body.sessionId, stampNumber: seenNumber }), { status: 403, body: { error: 'known_face' } })
    assert.equal((await didit.decision(declined.body.sessionId))?.status, 'Declined', 'Didit decides')
    await seen.sweep()
    assert.equal(await didit.decision(declined.body.sessionId), null, 'deleted in Didit at once')

    // A face deleted: a user's sessions, listed by its vendor_data alone, each erased, keeping no template.
    const user = 'c0ffee00'.repeat(8)
    const opened = [await didit.createSession({ vendorData: user }), await didit.createSession({ vendorData: user })].map((session) => session.sessionId)
    await didit.createSession({ vendorData: 'd'.repeat(64) })
    assert.deepEqual((await didit.sessionsOf(user)).sort(), opened.sort())
    for (const sessionId of opened) await didit.eraseSession(sessionId)
    assert.deepEqual(await didit.sessionsOf(user), [])
    await didit.eraseSession(opened[0]!)
  } finally {
    await verifier.close()
    await seen.close()
    fake.kill()
  }
})
