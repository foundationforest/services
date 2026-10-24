// The verifier end to end, in one process: a stand-in Didit, an embedder that knows people by name, a
// real SQLite file, real HTTP, and stamps checked the way the standard checks them, a stamp proof made
// and checked against the key `GET /` publishes. One test runs the stand-in Didit the e2e loop runs
// (test/fake-didit.ts) itself, with the stand-in embedding.
//
//   npm test

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hkdf, seedScalar, serviceKey, verifierSecret } from '@foundationforest/keys'
import { checkStamp, proveStamp, stampFromJson, stampSigned } from '@foundationforest/stamp'
import { b64u, canonical, parseCanonical } from '@foundationforest/records'

import { buy, finish, serviceOf } from '../../e2e/credits/client.ts'
import * as hostCredits from '../../host/credits/seller.ts'

import { DiditClient } from '../src/didit.ts'
import { RateLimit, addressGroup } from '../src/limit.ts'
import { RECIPES, faceFacts, idFacts } from '../src/facts.ts'
import { INFO, SEED_FILE, parseSeed, seedFrom } from '../src/seed.ts'
import { SIGNED_FOR_MS } from '../src/server.ts'
import { readConfig, startVerifier, type Verifier } from '../src/service.ts'
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
  randomSignature,
  seedJson,
} from './fakes.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** The stamp circuit's setup files, committed in the standard. */
const setup = join(here, '../../standard/proofs/stamp/circuit/setup')
const ARTIFACTS = { wasm: join(setup, 'note.wasm'), zkey: join(setup, 'note.zkey') }

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forest-verifier-'))
  dirs.push(dir)
  return dir
}

/** A price for the ID check, in a test dollar, paid to an address of its own: the ID check is offered. */
const PRICED = {
  ID_PRICE: '2500000',
  ID_MINT: 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa',
  ID_PAY_TO: '3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH',
  RPC_URL: 'http://127.0.0.1:1',
}

type Harness = {
  verifier: Verifier
  faces: FakeFaceCheck
  /** The ID check's Didit. */
  ids: FakeFaceCheck
  payments: FakePayments
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new face session whose check came to `decision`; returns its id. */
  session(decision: ReturnType<typeof passed>): Promise<string>
  /** A new ID session whose check came to `decision`, as if opened once paid; returns its id. */
  idSession(decision: ReturnType<typeof passed>): Promise<string>
  /** Moves the verifier's clock on. */
  later(ms: number): void
}

/**
 * The verifier, with `seed` in its seed file beside the database when given; with none there, it
 * makes one. The ID check is offered (PRICED) unless `env` says otherwise.
 */
async function start(options: { env?: Record<string, string | undefined>; seed?: string; dbPath?: string } = {}): Promise<Harness> {
  const dbPath = options.dbPath ?? join(tempDir(), 'verifier.sqlite')
  if (options.seed) writeFileSync(join(dirname(dbPath), SEED_FILE), options.seed, { mode: 0o600 })
  const config = readConfig({
    VERIFIER_NAME,
    DIDIT_API_KEY: 'not-used',
    DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DATABASE_PATH: dbPath,
    // Every request here comes from one address; the limit has its own test.
    SESSION_LIMIT_PER_HOUR: '100000',
    PORT: '0',
    ...PRICED,
    ...options.env,
  })
  const faces = new FakeFaceCheck()
  const ids = new FakeFaceCheck()
  const payments = new FakePayments()
  const logs: string[] = []
  let clock = Date.now()
  const verifier = await startVerifier(config, { faceCheck: faces, idCheck: ids, payments, embedder: namedFaces(), log: (line) => logs.push(line), now: () => clock })
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
  const idSession = async (decision: ReturnType<typeof passed>) => {
    const { sessionId } = await ids.createSession()
    ids.set(sessionId, decision)
    return sessionId
  }
  return { verifier, faces, ids, payments, dbPath, logs, post, session, idSession, later: (ms) => void (clock += ms) }
}

const faceStamp = (h: Harness, sessionId: string, n: bigint) => h.post('/face/stamp', { sessionId, stampNumber: n.toString() })
const idStamp = (h: Harness, sessionId: string, n: bigint) => h.post('/id/stamp', { sessionId, stampNumber: n.toString() })
const about = async (h: Harness) => (await fetch(h.verifier.url + '/')).json()

/** A face stamp for `person`, as an app gets one. */
async function face(h: Harness, person: string, n: bigint) {
  const sessionId = await h.session(passed(person))
  const res = await faceStamp(h, sessionId, n)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { sessionId, stamp: res.body.stamp }
}

test('GET /: the name, and for each check the key that signs its stamps, as an address, and its facts recipe', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const res = await fetch(h.verifier.url + '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const text = await res.text()
    assert.equal(canonical(parseCanonical(text)), text, 'canonical JSON')
    const keys = { face: serviceKey(await hkdf(seed.bytes, 'issuer/face')).address, id: serviceKey(await hkdf(seed.bytes, 'issuer/id')).address }
    assert.deepEqual(JSON.parse(text), {
      name: VERIFIER_NAME,
      face: { key: keys.face, facts: 'Poseidon([h(model), h(embedding)])' },
      id: { key: keys.id, facts: 'Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])' },
      h: RECIPES.h,
    })
    assert.deepEqual(h.verifier.keys, keys)
    assert.notEqual(keys.face, keys.id, 'two keys, one for each check')
    assert.equal((await fetch(h.verifier.url + '/', { method: 'POST' })).status, 405)
  } finally {
    await h.verifier.close()
  }
})

test('a face stamp: signed by the face key, its facts the face recipe, and a stamp proof from it holds for that key only', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const { stampNumber: n } = await verifierSecret(seed, VERIFIER_NAME)
    const { stamp: json } = await face(h, 'alice', n)
    assert.deepEqual(Object.keys(json).sort(), ['embedding', 'facts', 'model', 'signature', 'stampNumber', 'verifier'])
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.stampNumber, n)
    assert.equal(stamp.verifier, published.face.key, 'the face key GET / publishes')
    assert.ok(stampSigned(stamp), "the standard's check: the verifier signed it")
    assert.deepEqual(b64u.decode(json.embedding), faceOf('alice'), "alice's face, beside the stamp")
    assert.equal(json.model, 'test-model')
    assert.equal(stamp.facts, faceFacts('test-model', faceOf('alice')), 'Poseidon([h(model), h(embedding)])')

    // The stamp does what it is for: a stamp proof, made with the standard's own code, that its verifier takes.
    const label = 'tutoring/seller'
    const proof = await proveStamp({ seedScalar: await seedScalar(seed), verifierName: VERIFIER_NAME, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkStamp({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address, tag: proof.tag })
    assert.equal(await check(published.face.key), true)
    assert.equal(await check(published.id.key), false, 'a face stamp is no ID stamp')
    assert.deepEqual(h.logs, [], 'nothing is logged')
  } finally {
    await h.verifier.close()
  }
})

test('an ID stamp: signed by the ID key, its facts the ID recipe, the fields beside it, and a stamp proof for that key only', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const { stampNumber: n } = await verifierSecret(seed, VERIFIER_NAME)
    const res = await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace', { firstName: ' ADA ', lastName: 'LoveLace' }))), n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const json = res.body.stamp
    assert.deepEqual(Object.keys(json).sort(), ['birth', 'country', 'embedding', 'facts', 'model', 'name', 'signature', 'stampNumber', 'verifier'])
    assert.deepEqual([json.name, json.birth, json.country], ['ada lovelace', '1990-04-01', 826], 'the name written one way, the birth date, the country as its ISO numeric code')
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.verifier, published.id.key, 'the ID key GET / publishes')
    assert.ok(stampSigned(stamp))
    assert.equal(stamp.facts, idFacts('test-model', faceOf('ada'), { name: 'ada lovelace', birth: '1990-04-01', country: 826 }))

    const label = 'tutoring/buyer'
    const proof = await proveStamp({ seedScalar: await seedScalar(seed), verifierName: VERIFIER_NAME, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkStamp({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address, tag: proof.tag })
    assert.equal(await check(published.id.key), true)
    assert.equal(await check(published.face.key), false, 'an ID stamp is no face stamp')

    // A country with no ISO numeric code enters as 0: the person is not turned away.
    const kosovo = await idStamp(h, await h.idSession(passedId('besa', doc('Krasniqi', { country: 'XKX' }))), await stampNumber())
    assert.equal(kosovo.status, 200, JSON.stringify(kosovo.body))
    assert.equal(kosovo.body.stamp.country, 0)
  } finally {
    await h.verifier.close()
  }
})

test('one name and birth date, one stamp number: refused for another, signed again for the same', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const first = await h.idSession(passedId('ada', doc('Lovelace')))
    assert.equal((await idStamp(h, first, n1)).status, 200)

    // The same name and birth date, written another way, from another country's document, for another stamp number: refused.
    const same = doc('lovelace ', { firstName: '  ADA', country: 'IRL' })
    assert.deepEqual(await idStamp(h, await h.idSession(passedId('ada', same)), n2), { status: 403, body: { error: 'duplicate_document' } })
    // For the same stamp number, from a new session: signed again.
    const again = await idStamp(h, await h.idSession(passedId('ada', same)), n1)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.stamp.stampNumber, n1.toString())
    // The first session, sent again within its hour: the same stamp; after it, used.
    assert.equal((await idStamp(h, first, n1)).status, 200)
    h.later(SIGNED_FOR_MS)
    assert.deepEqual(await idStamp(h, first, n1), { status: 409, body: { error: 'session_used' } })
    // Ada Lovelace born another day is someone else.
    assert.equal((await idStamp(h, await h.idSession(passedId('ada2', doc('Lovelace', { birth: '1815-12-10' }))), n2)).status, 200)
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

test('In Review is waiting: 202, nothing kept, and once a person approves it in Didit, the same session gives the stamp', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const review = { status: 'In Review', liveness: [{ status: 'In Review' }] }
    const sessionId = await h.session(passed('known', review))
    assert.deepEqual(await faceStamp(h, sessionId, n), { status: 202, body: { waiting: 'review' } })
    assert.deepEqual(await faceStamp(h, sessionId, await stampNumber()), { status: 202, body: { waiting: 'review' } }, 'nothing kept while waiting')
    h.faces.set(sessionId, passed('known'))
    assert.equal((await faceStamp(h, sessionId, n)).status, 200)
    assert.deepEqual(await faceStamp(h, await h.session(passed('known', { status: 'Declined' })), n), { status: 403, body: { error: 'not_approved' } }, 'declined: refused')

    const id = await h.idSession(passedId('ida', doc('Pfeiffer'), { status: 'IN_REVIEW' }))
    assert.deepEqual(await idStamp(h, id, n), { status: 202, body: { waiting: 'review' } }, 'the ID check too')
  } finally {
    await h.verifier.close()
  }
})

test('an hour after its stamp is first signed, the sweep deletes a session in Didit, keeping its face template; never one In Review or refused', async () => {
  const h = await start()
  try {
    const n = await stampNumber()
    const held = await h.session(passed('known', { status: 'In Review', liveness: [{ status: 'In Review' }] }))
    assert.equal((await faceStamp(h, held, n)).status, 202)
    const declined = await h.session(passed('gone', { status: 'Declined' }))
    assert.equal((await faceStamp(h, declined, n)).status, 403)
    const idHeld = await h.idSession(passedId('ida', doc('Pfeiffer'), { status: 'In Review' }))
    assert.equal((await idStamp(h, idHeld, n)).status, 202)

    const signed = await face(h, 'ana', n)
    const id = await h.idSession(passedId('ida', doc('Pfeiffer')))
    assert.equal((await idStamp(h, id, n)).status, 200)
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'nothing is deleted before the stamp is answered')

    h.later(SIGNED_FOR_MS - 1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[], []], 'nor within the hour')
    h.later(1)
    await h.verifier.sweep()
    assert.deepEqual([h.faces.deleted, h.ids.deleted], [[signed.sessionId], [id]], 'deleted once the hour is over')
    assert.deepEqual(h.logs, [], 'Didit kept each face template: nothing to say')
    assert.ok(h.faces.sessions.has(held) && h.ids.sessions.has(idHeld) && h.faces.sessions.has(declined), 'a session In Review, or refused, is never deleted')
    assert.deepEqual(await faceStamp(h, signed.sessionId, n), { status: 409, body: { error: 'session_used' } })
    await h.verifier.sweep()
    assert.deepEqual(h.faces.deleted, [signed.sessionId], 'each once')

    // Didit not answering a deletion: the session stays for the next sweep.
    const m = await stampNumber()
    const later = await face(h, 'lena', m)
    h.later(SIGNED_FOR_MS)
    h.faces.deleteDown = true
    await h.verifier.sweep()
    assert.deepEqual(h.logs, ['verifier: 1 signed session could not be deleted in Didit, kept for the next sweep (Error)'], 'logged, without the session')
    h.faces.deleteDown = false
    await h.verifier.sweep()
    assert.equal(h.faces.deleted.at(-1), later.sessionId)

    // Didit deleting a session without keeping its face template: logged, by Didit's outcome only.
    h.faces.outcome = 'deleted'
    const mo = await face(h, 'mo', m)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.equal(h.logs.at(-1), 'verifier: Didit kept no face template for a deleted session (deleted)')

    // The file names a session in clear only until Didit has deleted it.
    const pia = await face(h, 'pia', m)
    await h.verifier.close()
    assertKept(h.dbPath, {
      sessions: [[signed.sessionId, n, 'face'], [id, n, 'id'], [later.sessionId, m, 'face'], [mo.sessionId, m, 'face'], [pia.sessionId, m, 'face']],
      toDelete: [pia.sessionId],
      fingerprints: [[1, n]],
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
      [passed('g', { status: 'Not Started' }), 'not_approved'],
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
      [{ documents: [] }, 'no_document'],
      [{ documents: [{ status: 'Declined' }] }, 'document_not_passed'],
      [{ faceMatches: [] }, 'no_face_match'],
      [{ faceMatches: [{ status: 'In Review' }] }, 'face_match_not_passed'],
      [{ document: null }, 'no_document_data'],
      [{ document: doc('x', { birth: '01/04/1990' }) }, 'no_document_data'],
      [{ document: doc('x', { birth: '1990-02-30' }) }, 'no_document_data'],
      [{ document: doc('', { firstName: '', fullName: ' ' }) }, 'no_document_data'],
      [{ faceImage: null }, 'no_face'],
    ]
    for (const [over, error] of idRefused) {
      const person = `p-${randomBytes(4).toString('hex')}`
      assert.deepEqual(await idStamp(h, await h.idSession(passedId(person, doc(person), over)), await stampNumber()), { status: 403, body: { error } }, error)
    }
    // A face session is not an ID session, and the other way round.
    assert.deepEqual(await idStamp(h, await h.session(passed('alice')), n), { status: 403, body: { error: 'unknown_session' } })
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
    for (const [body, status, error] of bad) {
      assert.deepEqual(await h.post('/face/stamp', body), { status, body: { error } }, error)
      assert.deepEqual(await h.post('/id/stamp', body), { status, body: { error } }, error)
    }
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

test('with no price, the ID check is not offered', async () => {
  const h = await start({ env: { ID_PRICE: undefined, ID_MINT: undefined, ID_PAY_TO: undefined, RPC_URL: undefined } })
  try {
    assert.deepEqual(await h.post('/id/session'), { status: 404, body: { error: 'not_offered' } })
    assert.deepEqual(await idStamp(h, await h.idSession(passedId('ada')), await stampNumber()), { status: 404, body: { error: 'not_offered' } })
    assert.equal(h.ids.created, 1, 'only the session this test opened itself')
    assert.ok((await about(h)).id.key, 'its key is still published')
    assert.equal((await face(h, 'alice', await stampNumber())).stamp.model, 'test-model', 'the face check is')
  } finally {
    await h.verifier.close()
  }
})

test('the file keeps which session gave which stamp number and which check it was, and each person as a fingerprint: nothing else', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await stampNumber(), await stampNumber()]
    const a = await face(h, 'alice', n1)
    const b = await face(h, 'bob', n2)
    const id = await h.idSession(passedId('alice', doc('Lovelace')))
    const res = await idStamp(h, id, n1)
    assert.equal(res.status, 200)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()

    assertKept(h.dbPath, {
      sessions: [[a.sessionId, n1, 'face'], [b.sessionId, n2, 'face'], [id, n1, 'id']],
      fingerprints: [[1, n1]],
      never: ['Lovelace', 'lovelace', '1990-04-01', a.stamp.embedding, res.body.stamp.embedding, a.stamp.signature.s, a.stamp.facts],
    })
    assert.equal(readFileSync(h.dbPath).includes(Buffer.from(faceOf('alice'))), false, 'no embedding')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('the ID check opens once a payment naming its reference has landed, and each payment opens one', async () => {
  const seed = seedJson()
  const h = await start({ seed: seed.json })
  try {
    const asked = await h.post('/id/session')
    assert.equal(asked.status, 402)
    assert.equal(asked.body.error, 'payment_required')
    const { payment } = asked.body
    assert.deepEqual(Object.keys(payment).sort(), ['amount', 'id', 'mint', 'reference', 'to'])
    assert.match(payment.id, /^[0-9a-f]{32}$/)
    assert.deepEqual([payment.to, payment.mint, payment.amount], [PRICED.ID_PAY_TO, PRICED.ID_MINT, PRICED.ID_PRICE])
    assert.equal(payment.reference, (await seedFrom(seed.bytes).ed25519(INFO.reference(payment.id))).address, "the reference: a key mixed from the verifier's seed")
    const other = (await h.post('/id/session')).body.payment
    assert.notEqual(other.reference, payment.reference, 'one reference per payment')
    assert.equal(h.ids.created, 0, 'no session yet')
    assert.equal((await h.post('/face/session')).status, 201, 'the face check stays free')

    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 402, body: { error: 'not_paid' } })
    h.payments.down = true
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 502, body: { error: 'payment_check_unavailable' } })
    h.payments.down = false

    const signature = randomSignature()
    h.payments.paid.set(payment.reference, [signature])
    const opened = await h.post('/id/session', { payment: payment.id })
    assert.equal(opened.status, 201)
    assert.equal(h.ids.created, 1)
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), opened, 'a lost answer: asked again, the same session')
    assert.equal(h.ids.created, 1, 'and no second one opened')
    h.payments.paid.set(other.reference, [signature])
    assert.deepEqual(await h.post('/id/session', { payment: other.id }), { status: 409, body: { error: 'payment_used' } }, 'one transaction pays for one check, for its own payment')
    const second = randomSignature()
    h.payments.paid.set(payment.reference, [second, signature])
    const twice = await h.post('/id/session', { payment: payment.id })
    assert.equal(twice.status, 201)
    assert.notEqual(twice.body.sessionId, opened.body.sessionId, 'a second payment naming the same reference opens a second')
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), twice, 'and its answer, lost, is the newest session')
    assert.ok(!JSON.stringify(h.ids.tags).includes(payment.id), 'Didit never holds the payment id, only its tag')

    // Didit opened a session and its answer was lost, or Didit did not answer at all: the payment is
    // never given back, and the next ask finds the session, or opens it.
    const third = (await h.post('/id/session')).body.payment
    h.payments.paid.set(third.reference, [randomSignature()])
    h.ids.lost = true
    assert.deepEqual(await h.post('/id/session', { payment: third.id }), { status: 502, body: { error: 'face_check_unavailable' } })
    const found = await h.post('/id/session', { payment: third.id })
    assert.deepEqual([found.status, found.body.sessionId], [201, h.ids.tags.at(-1)!.sessionId], 'the session Didit opened, found by its tag')
    const fourth = (await h.post('/id/session')).body.payment
    h.payments.paid.set(fourth.reference, [randomSignature()])
    h.ids.down = true
    assert.deepEqual(await h.post('/id/session', { payment: fourth.id }), { status: 502, body: { error: 'face_check_unavailable' } })
    h.ids.down = false
    assert.equal((await h.post('/id/session', { payment: fourth.id })).status, 201, 'Didit down: the payment is still good')
    const created = h.ids.created
    const [a, b] = await Promise.all([h.post('/id/session', { payment: fourth.id }), h.post('/id/session', { payment: fourth.id })])
    assert.deepEqual([a, h.ids.created], [b, created], 'two asks at once: one answer, no session opened')

    // The session it opened is an ID session like any other.
    h.ids.set(opened.body.sessionId, passedId('alice'))
    assert.equal((await idStamp(h, opened.body.sessionId, await stampNumber())).status, 200)

    // A payment whose session gave its stamp, and was deleted with it, is used: asked again, no new session.
    const fifth = (await h.post('/id/session')).body.payment
    h.payments.paid.set(fifth.reference, [randomSignature()])
    const its = await h.post('/id/session', { payment: fifth.id })
    h.ids.set(its.body.sessionId, passedId('fay', doc('Fairfax')))
    assert.equal((await idStamp(h, its.body.sessionId, await stampNumber())).status, 200)
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    assert.ok(h.ids.deleted.includes(its.body.sessionId))
    const before = h.ids.created
    assert.deepEqual(await h.post('/id/session', { payment: fifth.id }), { status: 409, body: { error: 'payment_used' } })
    assert.equal(h.ids.created, before, 'and no session opened')

    for (const [body, status, error] of [
      [{ payment: 'ABC' }, 400, 'bad_payment'],
      [{ payment: payment.id, more: 'x' }, 400, 'expected_exactly_payment'],
      [{ paid: payment.id }, 400, 'expected_exactly_payment'],
    ] as [unknown, number, string][]) {
      assert.deepEqual(await h.post('/id/session', body), { status, body: { error } })
    }
  } finally {
    await h.verifier.close()
  }
})

test('the configuration names what is missing', () => {
  assert.throws(() => readConfig({}), /missing environment variables: DIDIT_API_KEY, DIDIT_FACE_WORKFLOW_ID, DIDIT_ID_WORKFLOW_ID$/)
  const base = { DIDIT_API_KEY: 'k', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_WORKFLOW_ID: 'i' }
  const config = readConfig(base)
  assert.equal(config.verifierName, 'verifier.forest.foundation', 'the name, unless told otherwise')
  assert.equal(readConfig({ ...base, VERIFIER_NAME }).verifierName, VERIFIER_NAME)
  assert.equal(config.diditBaseUrl, 'https://verification.didit.me')
  assert.equal(config.faceModel, 'sface')
  assert.equal(config.sessionLimitPerHour, 5)
  assert.equal(config.clientAddressHeader, undefined)
  assert.equal(readConfig({ ...base, CLIENT_ADDRESS_HEADER: 'X-Real-IP' }).clientAddressHeader, 'x-real-ip')
  assert.equal(config.idPrice, undefined, 'the ID check is not offered unless a price is set')
  assert.equal(config.rpcUrl, undefined)

  // The stand-in embedding is for a stand-in Didit on this machine, and nowhere else.
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in' }), /FACE_MODEL=stand-in is for a stand-in Didit on this machine only/)
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'https://didit.example' }), /stand-in/)
  assert.equal(readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'http://127.0.0.1:8090' }).faceModel, 'stand-in')
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'other' }), /FACE_MODEL is sface or stand-in/)

  // The ID check's four settings: all, or none.
  assert.throws(() => readConfig({ ...base, ID_PRICE: '2500000' }), /missing environment variables: ID_PAY_TO, ID_MINT, RPC_URL$/)
  assert.throws(() => readConfig({ ...base, ID_PAY_TO: PRICED.ID_PAY_TO }), /missing environment variables: ID_PRICE, ID_MINT, RPC_URL$/)
  assert.throws(() => readConfig({ ...base, RPC_URL: 'http://rpc.example' }), /missing environment variables: ID_PRICE, ID_PAY_TO, ID_MINT$/)
  for (const price of ['0', '2.5', '-1', '01', 'free']) assert.throws(() => readConfig({ ...base, ...PRICED, ID_PRICE: price }), /ID_PRICE must be a whole number above 0/)
  assert.throws(() => readConfig({ ...base, ...PRICED, ID_PAY_TO: 'not-an-address' }), /ID_PAY_TO is not an address/)
  assert.throws(() => readConfig({ ...base, ...PRICED, ID_MINT: 'not-an-address' }), /ID_MINT is not an address/)
  assert.deepEqual(readConfig({ ...base, ...PRICED }).idPrice, { amount: 2_500_000n, payTo: PRICED.ID_PAY_TO, mint: PRICED.ID_MINT })

  // The welcome gift: none unless the host is named; ten credits unless set; none at 0.
  assert.equal(config.gift, undefined)
  assert.deepEqual(readConfig({ ...base, HOST_URL: 'https://host.example' }).gift, { origin: 'https://host.example', credits: 10 })
  assert.deepEqual(readConfig({ ...base, HOST_URL: 'https://host.example', HOST_CREDITS: '20' }).gift, { origin: 'https://host.example', credits: 20 })
  assert.equal(readConfig({ ...base, HOST_URL: 'https://host.example', HOST_CREDITS: '0' }).gift, undefined)
  assert.throws(() => readConfig({ ...base, HOST_URL: 'https://host.example/' }), /HOST_URL is an origin/)
  assert.throws(() => readConfig({ ...base, HOST_URL: 'https://host.example', HOST_CREDITS: '-1' }), /HOST_CREDITS/)

  // The apps a person may be sent back to: none unless named, each an origin.
  assert.deepEqual(config.appOrigins, [])
  assert.deepEqual(readConfig({ ...base, APP_ORIGINS: 'https://app.example, http://localhost:5173' }).appOrigins, ['https://app.example', 'http://localhost:5173'])
  assert.throws(() => readConfig({ ...base, APP_ORIGINS: 'https://app.example/' }), /APP_ORIGINS is an origin/)
  assert.throws(() => readConfig({ ...base, APP_ORIGINS: 'app.example' }), /APP_ORIGINS is an origin/)
})

test("the ID check's price is never paid to the verifier's own sponsor key", async () => {
  const seed = seedJson()
  const own = (await seedFrom(seed.bytes).ed25519(INFO.sponsor)).address
  await assert.rejects(start({ seed: seed.json, env: { ID_PAY_TO: own } }), /ID_PAY_TO is the verifier's own sponsor key/)
})

/** The host's own seller, taking the verifier's sponsor key. */
async function hostSeller(sponsor: string) {
  const pkcs8 = new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))
  // Tickets buy here; the RPC a Solana payment would be checked through is never asked.
  const payment = { address: '7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA', mint: 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa', rpc: async () => Promise.reject(new Error('no chain here')) }
  const origin = 'https://host.example'
  const seller = hostCredits.seller({ origin, key: await hostCredits.keyFrom(pkcs8), requestUri: '/credits/buy', price: '0.01', payment, maxBuy: 1000, sponsors: [sponsor], path: ':memory:' })
  return { seller, service: serviceOf(origin, seller.directory()) }
}

test('the welcome gift: at a stamp number’s first face stamp, a sponsor’s ticket for the app’s host buy, which the host collects; the verifier pays nothing', async () => {
  const seed = seedJson()
  const sponsor = (await seedFrom(seed.bytes).ed25519(INFO.sponsor)).address
  const host = await hostSeller(sponsor)
  const h = await start({ seed: seed.json, env: { HOST_URL: 'https://host.example', HOST_CREDITS: '5' } })
  try {
    // GET / says what the gift holds, so the app knows what to buy.
    assert.deepEqual((await about(h)).gift, { host: 'https://host.example', credits: 5, sponsor })
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

    // The stamp is never held back by the gift; none asked, none answered; the ID check gives none.
    assert.equal((await bobStamp()).gift, undefined)
    const id = await h.idSession(passedId('bob', doc('Byron')))
    assert.deepEqual(await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), gift: six.reference }), { status: 400, body: { error: 'expected_exactly_sessionId_and_stampNumber' } })
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()
    assertKept(h.dbPath, { sessions: [[sessionId, n, 'face'], [bob, m, 'face']], fingerprints: [], gifts: [n, m], never: [mine.reference, six.reference, ticket] })
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

test('with no gift, a stamp asked for with one is refused', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed('alice'))
    const res = await h.post('/face/stamp', { sessionId, stampNumber: (await stampNumber()).toString(), gift: 'x' })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_stampNumber' }])
    assert.equal((await about(h)).gift, undefined)
  } finally {
    await h.verifier.close()
  }
})

test('opening sessions is limited per address, and a refusal says only "try later"', async () => {
  const h = await start({ env: { SESSION_LIMIT_PER_HOUR: '3', CLIENT_ADDRESS_HEADER: 'x-real-ip' } })
  try {
    const from = (address: string) => h.post('/face/session', {}, { 'x-real-ip': address })
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.7')).status, 201)
    assert.deepEqual(await from('203.0.113.7'), { status: 429, body: { error: 'try_later' } })
    assert.equal(h.faces.created, 3, 'a refused request never reaches Didit')
    assert.equal((await from('203.0.113.8')).status, 201, 'another address has its own share')
    for (const a of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b', '2001:0db8:0001:0002:0:0:0:c']) assert.equal((await from(a)).status, 201)
    assert.equal((await from('2001:db8:1:2:9::d')).status, 429, 'an IPv6 address counts with the rest of its /64')
    assert.equal((await from('2001:db8:1:3::a')).status, 201, 'the next /64 is someone else')
    assert.equal((await h.post('/face/session', { x: 1 }, { 'x-real-ip': '203.0.113.9' })).status, 400)
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.9')).status, 201, 'a malformed request is not counted')

    // Stamps are not limited, and the address is never written: not in the log, not in the file.
    const sessionId = (await from('203.0.113.10')).body.sessionId
    h.faces.set(sessionId, passed('alice'))
    assert.equal((await h.post('/face/stamp', { sessionId, stampNumber: (await stampNumber()).toString() }, { 'x-real-ip': '203.0.113.7' })).status, 200)
    await h.verifier.close()
    assert.deepEqual(h.logs, [])
    const file = readFileSync(h.dbPath)
    for (const a of ['203.0.113.7', '203.0.113.8', '2001:db8']) assert.equal(file.includes(Buffer.from(a)), false)
  } finally {
    await h.verifier.close().catch(() => {})
  }

  const direct = await start({ env: { SESSION_LIMIT_PER_HOUR: '2' } })
  try {
    assert.equal((await direct.post('/face/session', {}, { 'x-real-ip': '198.51.100.1' })).status, 201)
    assert.equal((await direct.post('/face/session', {}, { 'x-real-ip': '198.51.100.2' })).status, 201)
    assert.equal((await direct.post('/face/session', {}, { 'x-real-ip': '198.51.100.3' })).status, 429, 'a header nobody named is ignored')
  } finally {
    await direct.verifier.close()
  }
})

test('the limit: a fresh share each hour, and nothing kept past it', () => {
  let now = 1_000_000
  const limit = new RateLimit({ max: 2, windowMs: 3_600_000, now: () => now })
  assert.equal(limit.take('192.0.2.1'), true)
  assert.equal(limit.take('192.0.2.1'), true)
  assert.equal(limit.take('192.0.2.1'), false)
  assert.equal(limit.take('::ffff:192.0.2.1'), false, 'the same IPv4 address, as a dual-stack socket reports it')
  assert.equal(limit.take('192.0.2.2'), true)
  now += 3_599_999
  assert.equal(limit.take('192.0.2.1'), false, 'still inside the hour')
  now += 1
  assert.equal(limit.take('192.0.2.1'), true, 'a new hour')
  now += 3_600_000
  limit.take('192.0.2.3')
  assert.equal(limit.size, 1, 'addresses whose hour has passed are forgotten')

  assert.equal(addressGroup('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(addressGroup('2001:0DB8:0000:0000:ffff:1:2:3'), '2001:db8:0:0::/64')
  assert.equal(addressGroup('fe80::1%eth0'), 'fe80:0:0:0::/64')
  assert.equal(addressGroup('::1'), '0:0:0:0::/64')
  assert.equal(addressGroup('::ffff:10.0.0.1'), '10.0.0.1')
  assert.equal(addressGroup('not an address'), 'not an address')
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
  assert.equal(JSON.parse(published).face.key, serviceKey(await seed.mix('issuer/face')).address, 'GET / names the face key mixed from it')
  assert.equal(JSON.parse(published).id.key, serviceKey(await seed.mix('issuer/id')).address, 'and the ID key')
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

test('a face check sends the person back only to an app the verifier names in APP_ORIGINS', async () => {
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
  } finally {
    await h.verifier.close()
  }
  const none = await start()
  try {
    assert.deepEqual(await none.post('/face/session', { returnUrl: 'https://app.example/' }), { status: 400, body: { error: 'bad_return_url' } }, 'with no APP_ORIGINS, no return URL is taken')
  } finally {
    await none.verifier.close()
  }
})

test('the stand-in for tests: test/fake-didit.ts and the stand-in embedding, both checks for two people, and review', async () => {
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
    DATABASE_PATH: join(tempDir(), 'verifier.sqlite'),
    PORT: '0',
    ...PRICED,
  })
  // Each payment counts as landed, under its own reference: the stand-in has no chain.
  const payments = { landed: async (reference: string) => [reference] }
  const didit = new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, check: 'face', baseUrl })
  let clock = Date.now()
  const verifier = await startVerifier(config, { payments, log: () => {}, now: () => clock })
  const reviewed = await startVerifier(
    { ...config, databasePath: join(tempDir(), 'verifier.sqlite') },
    { faceCheck: new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, check: 'face', baseUrl, scenario: 'review_duplicated_face' }), log: () => {} },
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
      const { payment } = (await post(verifier, '/id/session')).body
      const id = await post(verifier, '/id/session', { payment: payment.id })
      assert.equal(id.status, 201, JSON.stringify(id.body))
      const idStamp = await post(verifier, '/id/stamp', { sessionId: id.body.sessionId, stampNumber: n.toString() })
      assert.equal(idStamp.status, 200, JSON.stringify(idStamp.body))
      assert.equal(idStamp.body.stamp.verifier, verifier.keys.id)
      assert.deepEqual([idStamp.body.stamp.birth, idStamp.body.stamp.country], ['1990-01-01', 826])
      assert.ok(stampSigned(stampFromJson(idStamp.body.stamp)))
    }
    // An hour on, the sweep deletes every signed session in Didit, asking it to keep the face template.
    clock += SIGNED_FOR_MS
    await verifier.sweep()
    assert.deepEqual(await didit.decision(signedFaces[0]!), null, 'deleted in Didit')
    assert.deepEqual(await post(verifier, '/face/stamp', { sessionId: signedFaces[0], stampNumber: (await stampNumber()).toString() }), { status: 409, body: { error: 'session_used' } })

    // A session opened with a review scenario: Didit holds it In Review, the verifier says it is waiting,
    // and the session stays in Didit.
    const held = await post(reviewed, '/face/session')
    assert.deepEqual(await post(reviewed, '/face/stamp', { sessionId: held.body.sessionId, stampNumber: (await stampNumber()).toString() }), { status: 202, body: { waiting: 'review' } })
    assert.equal((await didit.decision(held.body.sessionId))?.status, 'In Review')
  } finally {
    await verifier.close()
    await reviewed.close()
    fake.kill()
  }
})
