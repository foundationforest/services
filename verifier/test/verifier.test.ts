// The verifier end to end, in one process: a stand-in Didit, an embedder that knows people by name, a
// real SQLite file, real HTTP, and stamps checked the way the standard checks them, a verification
// made and checked against the key `GET /` publishes. One test runs the stand-in Didit the e2e loop runs
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

import { hkdf, seedNumber, serviceKey, stampNumberOf } from '@foundationforest/keys'
import { checkVerification, proveVerification, stampFromJson, stampSigned } from '@foundationforest/proofs'
import { b64u, canonical, parseCanonical } from '@foundationforest/folders'

import { buy, finish, serviceOf } from '../../host/client/client.ts'
import * as hostCredits from '../../host/credits/seller.ts'

import { DiditClient } from '../src/didit.ts'
import { RECIPES, faceFacts, idFacts } from '../src/facts.ts'
import { INFO, SEED_FILE, parseSeed, seedFrom } from '../src/seed.ts'
import { SIGNED_FOR_MS } from '../src/server.ts'
import { readConfig, startVerifier, type Verifier } from '../src/service.ts'
import {
  FACE_WORKFLOW,
  FakeFaceCheck,
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
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new face session whose check came to `decision`; returns its id. */
  session(decision: ReturnType<typeof passed>): Promise<string>
  /** A new ID session whose check came to `decision`; returns its id. */
  idSession(decision: ReturnType<typeof passed>): Promise<string>
  /** Moves the verifier's clock on. */
  later(ms: number): void
}

/**
 * The verifier, with `seed` in its seed file beside the database when given; with none there, it
 * makes one.
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
    PORT: '0',
    ...options.env,
  })
  const faces = new FakeFaceCheck()
  const ids = new FakeFaceCheck()
  const logs: string[] = []
  let clock = Date.now()
  const verifier = await startVerifier(config, { faceCheck: faces, idCheck: ids, embedder: namedFaces(), log: (line) => logs.push(line), now: () => clock })
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
    const { status, body } = await post('/id/session')
    assert.equal(status, 201)
    ids.set(body.sessionId, decision)
    return body.sessionId as string
  }
  return { verifier, faces, ids, dbPath, logs, post, session, idSession, later: (ms) => void (clock += ms) }
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
    const keys = { face: serviceKey(await hkdf(seed.bytes, 'face')).address, id: serviceKey(await hkdf(seed.bytes, 'id')).address }
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
    const label = 'tutoring/seller'
    const proof = await proveVerification({ seed, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
    assert.equal(await check(published.face.key), true)
    assert.equal(await check(published.id.key), false, 'a face stamp is no ID stamp')
    assert.deepEqual(h.logs, [], 'nothing is logged')
  } finally {
    await h.verifier.close()
  }
})

test('an ID stamp: signed by the ID key, its facts the ID recipe, the fields beside it, and a verification for that key only', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const n = stampNumberOf(seedNumber(seed), VERIFIER_NAME)
    const res = await idStamp(h, await h.idSession(passedId('ada', doc('Lovelace', { firstName: ' ADA ', lastName: 'LoveLace' }))), n)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const json = res.body.stamp
    assert.deepEqual(Object.keys(json).sort(), ['birth', 'country', 'embedding', 'facts', 'model', 'name', 'signature', 'stampNumber', 'verifier', 'verifierName'])
    assert.deepEqual([json.name, json.birth, json.country], ['ada lovelace', '1990-04-01', 826], 'the name written one way, the birth date, the country as its ISO numeric code')
    const published = await about(h)
    const stamp = stampFromJson(json)
    assert.equal(stamp.verifier, published.id.key, 'the ID key GET / publishes')
    assert.ok(stampSigned(stamp))
    assert.equal(stamp.facts, idFacts('test-model', faceOf('ada'), { name: 'ada lovelace', birth: '1990-04-01', country: 826 }))

    const label = 'tutoring/buyer'
    const proof = await proveVerification({ seed, stamp, label, artifacts: ARTIFACTS })
    const check = (verifier: string) => checkVerification({ proof: proof.proof, verifier, verifierName: VERIFIER_NAME, label, profile: proof.address })
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

test('the ID check is offered with no price: its session opens as a face session does, on the ID check’s Didit', async () => {
  const h = await start()
  try {
    const opened = await h.post('/id/session')
    assert.equal(opened.status, 201)
    assert.deepEqual([h.ids.created, h.faces.created], [1, 0], 'on the ID check’s Didit, and only there')
    h.ids.set(opened.body.sessionId, passedId('ada'))
    assert.equal((await idStamp(h, opened.body.sessionId, await stampNumber())).status, 200)
    for (const body of [{ payment: 'ab'.repeat(16) }, { x: 1 }]) assert.deepEqual(await h.post('/id/session', body), { status: 400, body: { error: 'expected_empty_body' } })
    assert.equal(h.ids.created, 1, 'a refused request never reaches Didit')
  } finally {
    await h.verifier.close()
  }
})

test('the file keeps which session gave which stamp number and which check it was, the stamp it signed, and each person as a fingerprint: nothing else', async () => {
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
      // The stamp's facts and signature are kept; the fields beside it are not.
      never: ['Lovelace', 'lovelace', '1990-04-01', 'test-model', a.stamp.embedding, res.body.stamp.embedding],
    })
    assert.equal(readFileSync(h.dbPath).includes(Buffer.from(faceOf('alice'))), false, 'no embedding')
  } finally {
    await h.verifier.close().catch(() => {})
  }
})

/** A stamp's own fields: what the verifier keeps of it, and hands back. */
const own = ({ stampNumber, facts, verifier, verifierName, signature }: Record<string, unknown>) => ({ stampNumber, facts, verifier, verifierName, signature })
const stampBack = (h: Harness, n: bigint) => h.post('/stamp', { stampNumber: n.toString() })

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
  assert.throws(() => readConfig({}), /missing environment variables: DIDIT_API_KEY, DIDIT_FACE_WORKFLOW_ID, DIDIT_ID_WORKFLOW_ID$/)
  const base = { DIDIT_API_KEY: 'k', DIDIT_FACE_WORKFLOW_ID: 'f', DIDIT_ID_WORKFLOW_ID: 'i' }
  const config = readConfig(base)
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
    const idStamp = await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), gift: seven.reference })
    assert.equal(idStamp.status, 200)
    assert.equal(idStamp.body.gift.ticket.split('.')[1], '7', 'the ID check’s credits')
    const paid = await host.seller.collect(seven.buy, `ticket ${idStamp.body.gift.ticket}`)
    assert.equal((await finish(seven.pending, paid.body as Uint8Array)).length, 7)
    assert.deepEqual((await h.post('/id/stamp', { sessionId: id, stampNumber: m.toString(), gift: (await buy(host.service, 7)).reference })).body.gift, { error: 'given' })
    h.later(SIGNED_FOR_MS)
    await h.verifier.sweep()
    await h.verifier.close()
    assertKept(h.dbPath, { sessions: [[sessionId, n, 'face'], [bob, m, 'face'], [id, m, 'id']], fingerprints: [[1, m]], gifts: [n, m], idGifts: [m], never: [mine.reference, six.reference, seven.reference, ticket] })
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
    const res = await faceOnly.post('/id/stamp', { sessionId: id, stampNumber: (await stampNumber()).toString(), gift: 'x' })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_stampNumber' }])
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
  assert.equal(JSON.parse(published).id.key, serviceKey(await seed.mix('id')).address, 'and the ID key')
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
    // The ID check, the same way.
    const id = await h.post('/id/session', { returnUrl: 'https://app.example/checked?from=id' })
    assert.equal(id.status, 201)
    assert.equal(h.ids.callbacks.get(id.body.sessionId), 'https://app.example/checked?from=id')
    assert.deepEqual(await h.post('/id/session', { returnUrl: 'https://other.example/' }), { status: 400, body: { error: 'bad_return_url' } })
    assert.equal(h.ids.created, 1)
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
  })
  const didit = new DiditClient({ apiKey: 'fake-didit', workflowId: FACE_WORKFLOW, check: 'face', baseUrl })
  let clock = Date.now()
  const verifier = await startVerifier(config, { log: () => {}, now: () => clock })
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
      const id = await post(verifier, '/id/session')
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
