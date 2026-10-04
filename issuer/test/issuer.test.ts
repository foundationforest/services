// The issuer end to end, in one process: a stand-in Didit, a real SQLite file, real HTTP, and the
// two files it publishes checked the way a reader checks them.
//
//   npm test

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { BN254_R, toBytes32 } from '../../forest/registry/client/src/field.ts'
import { listRoot } from '../../forest/registry/client/src/proof.ts'
import { base58, hex } from '../../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../../forest/records/src/canonical.ts'
import { issuerSigned } from '../../forest/registry/client/src/issuer.ts'

import { shuffle } from '../src/batch.ts'
import { loadKeypair, parseKeypair, writeKeyFile } from '../src/key.ts'
import { RateLimit, addressGroup } from '../src/limit.ts'
import { readConfig, startIssuer, type Issuer } from '../src/service.ts'
import { Store } from '../src/store.ts'
import {
  FakeFaceCheck,
  FakePayments,
  ID_WORKFLOW,
  WORKFLOW,
  assertFileHolds,
  assertNoLink,
  keypairJson,
  passed,
  passedId,
  randomSignature,
  randomStamp,
} from './fakes.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-'))
  dirs.push(dir)
  return dir
}

type Harness = {
  issuer: Issuer
  faces: FakeFaceCheck
  /** The ID check's Didit. */
  ids: FakeFaceCheck
  payments: FakePayments
  dbPath: string
  /** The list, in order, as the file holds it. */
  listed(): bigint[]
  get(path: string): Promise<Response>
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new session whose check came to `decision`; returns its id. */
  session(decision?: ReturnType<typeof passed>): Promise<string>
  /** The same for the ID check, while it is free. */
  idSession(decision?: ReturnType<typeof passed>): Promise<string>
}

async function start(
  options: {
    batchMax?: number
    intervalSeconds?: number
    env?: Record<string, string>
    /** The key, as its 64 numbers; a fresh one unless given. */
    key?: string
    /** The file, to start again on one an earlier issuer wrote. */
    dbPath?: string
    now?: () => number
  } = {},
): Promise<Harness> {
  const dbPath = options.dbPath ?? join(tempDir(), 'issuer.sqlite')
  const config = readConfig({
    DIDIT_API_KEY: 'not-used',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    ISSUER_KEYPAIR: options.key ?? keypairJson().json,
    DATABASE_PATH: dbPath,
    BATCH_MAX: String(options.batchMax ?? 1000),
    BATCH_INTERVAL_SECONDS: String(options.intervalSeconds ?? 3600),
    // Every request here comes from one address; the limit has its own test.
    SESSION_LIMIT_PER_HOUR: '100000',
    PORT: '0',
    ...options.env,
  })
  const faces = new FakeFaceCheck()
  const ids = new FakeFaceCheck()
  const payments = new FakePayments()
  const logs: string[] = []
  const issuer = await startIssuer(config, { faceCheck: faces, idCheck: ids, payments, log: (line) => logs.push(line), now: options.now })
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(issuer.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const session = async (decision = passed()) => {
    const { status, body } = await post('/session')
    assert.equal(status, 201)
    faces.set(body.sessionId, decision)
    return body.sessionId as string
  }
  const idSession = async (decision = passedId()) => {
    const { status, body } = await post('/id/session')
    assert.equal(status, 201)
    ids.set(body.sessionId, decision)
    return body.sessionId as string
  }
  const listed = () => issuer.store.stamps()
  const get = (path: string) => fetch(issuer.url + path)
  return { issuer, faces, ids, payments, dbPath, listed, get, logs, post, session, idSession }
}

const submit = (h: Harness, sessionId: string, stamp: bigint) => h.post('/submit', { sessionId, stamp: stamp.toString() })
const submitId = (h: Harness, sessionId: string, stamp: bigint) => h.post('/id/submit', { sessionId, stamp: stamp.toString() })

/** A price for the ID check, in the test dollar, paid to an address of its own. */
const PRICED = {
  ID_TIER_PRICE: '2500000',
  ID_TIER_MINT: 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa',
  ID_TIER_PAY_TO: '3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH',
  RPC_URL: 'http://127.0.0.1:1',
}

/** A paid ID session: a payment asked for, landed (as the test's RPC says), and the session opened with it. */
async function paidIdSession(h: Harness, decision = passedId(), signature = randomSignature()): Promise<{ sessionId: string; signature: string }> {
  const asked = await h.post('/id/session')
  assert.equal(asked.status, 402)
  h.payments.paid.set(asked.body.payment.reference, [signature])
  const opened = await h.post('/id/session', { payment: asked.body.payment.id })
  assert.equal(opened.status, 201)
  h.ids.set(opened.body.sessionId, decision)
  return { sessionId: opened.body.sessionId, signature }
}

test('a passed face check puts the stamp on the list', async () => {
  const h = await start()
  try {
    const created = await h.post('/session')
    assert.equal(created.status, 201)
    assert.match(created.body.url, /^https:\/\//)
    h.faces.set(created.body.sessionId, passed())

    const stamp = randomStamp()
    assert.deepEqual(await submit(h, created.body.sessionId, stamp), { status: 202, body: { status: 'queued' } })
    assert.deepEqual((await h.post('/status', { stamp: stamp.toString() })).body, { status: 'queued' })
    assert.deepEqual(h.listed(), [], 'nothing goes on the list before the batch')

    await h.issuer.batcher.flush()
    assert.deepEqual(h.listed(), [stamp])
    assert.deepEqual((await h.post('/status', { stamp: stamp.toString() })).body, { status: 'listed' })
    assert.deepEqual((await h.post('/status', { stamp: randomStamp().toString() })).body, { status: 'unknown' })
    assert.deepEqual(h.logs, ['issuer: batch of 1 added to the list'], 'the log holds a count and nothing else')
  } finally {
    await h.issuer.close()
  }
})

test('a failed liveness check is refused, and uses nothing up', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed({ status: 'Declined', liveness: [{ status: 'Declined' }] }))
    const stamp = randomStamp()
    assert.deepEqual(await submit(h, sessionId, stamp), { status: 403, body: { error: 'liveness_not_passed' } })
    assert.equal(h.issuer.store.count(), 0)

    // A liveness step still in review, in a session already approved, is not a pass either.
    h.faces.set(sessionId, passed({ liveness: [{ status: 'Approved' }, { status: 'In Review' }] }))
    assert.deepEqual(await submit(h, sessionId, stamp), { status: 403, body: { error: 'liveness_not_passed' } })

    // The session was not used up: once Didit says it passed, it counts.
    h.faces.set(sessionId, passed())
    assert.equal((await submit(h, sessionId, stamp)).status, 202)
  } finally {
    await h.issuer.close()
  }
})

test('a duplicate face is refused, whatever else the session says', async () => {
  const h = await start()
  try {
    for (const risk of ['DUPLICATED_FACE', 'POSSIBLE_DUPLICATED_FACE']) {
      // As Didit reports it: the liveness step declined, with the risk code.
      const declined = await h.session(
        passed({ status: 'Declined', liveness: [{ status: 'Declined' }], risks: ['LOW_FACE_QUALITY', risk] }),
      )
      assert.deepEqual(await submit(h, declined, randomStamp()), { status: 403, body: { error: 'duplicate_face' } })
      // And a workflow whose rules approved it anyway: the risk code alone refuses.
      const approved = await h.session(passed({ risks: [risk] }))
      assert.deepEqual(await submit(h, approved, randomStamp()), { status: 403, body: { error: 'duplicate_face' } })
    }
    assert.equal(h.issuer.store.count(), 0)
  } finally {
    await h.issuer.close()
  }
})

test('a session id counts once', async () => {
  const h = await start()
  try {
    const sessionId = await h.session()
    const first = randomStamp()
    assert.equal((await submit(h, sessionId, first)).status, 202)
    assert.deepEqual(await submit(h, sessionId, randomStamp()), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual(await submit(h, sessionId, first), { status: 409, body: { error: 'session_used' } })

    // Two requests with one session, both waiting on Didit at once: exactly one stamp is queued.
    const racing = await h.session()
    const release = h.faces.hold()
    const both = Promise.all([submit(h, racing, randomStamp()), submit(h, racing, randomStamp())])
    while (h.faces.waiting < 2) await new Promise((r) => setTimeout(r, 5))
    release()
    const statuses = (await both).map((r) => r.status).sort()
    assert.deepEqual(statuses, [202, 409])
    assert.equal(h.issuer.store.count(), 2, 'one stamp from each session')

    // After the batch, the used sessions are still refused.
    await h.issuer.batcher.flush()
    assert.deepEqual(await submit(h, sessionId, randomStamp()), { status: 409, body: { error: 'session_used' } })
  } finally {
    await h.issuer.close()
  }
})

test('every other refusal, and malformed requests', async () => {
  const h = await start()
  try {
    const cases: [ReturnType<typeof passed>, string][] = [
      [passed({ workflowId: 'another-workflow' }), 'wrong_workflow'],
      [passed({ status: 'In Review' }), 'not_approved'],
      [passed({ liveness: [] }), 'no_liveness'],
    ]
    for (const [decision, error] of cases) {
      assert.deepEqual(await submit(h, await h.session(decision), randomStamp()), { status: 403, body: { error } })
    }
    assert.deepEqual(await submit(h, crypto.randomUUID(), randomStamp()), {
      status: 403,
      body: { error: 'unknown_session' },
    })

    const good = await h.session()
    const bad: [unknown, string][] = [
      [{ sessionId: 'not-a-uuid', stamp: '5' }, 'bad_session_id'],
      [{ sessionId: good, stamp: '0' }, 'bad_stamp'],
      [{ sessionId: good, stamp: '007' }, 'bad_stamp'],
      [{ sessionId: good, stamp: '0x12' }, 'bad_stamp'],
      [{ sessionId: good, stamp: '-5' }, 'bad_stamp'],
      [{ sessionId: good, stamp: BN254_R.toString() }, 'bad_stamp'],
      [{ sessionId: good, stamp: 5 }, 'expected_exactly_sessionId_and_stamp'],
      [{ sessionId: good, stamp: '5', extra: 'x' }, 'expected_exactly_sessionId_and_stamp'],
      [{ sessionId: good }, 'expected_exactly_sessionId_and_stamp'],
      ['not json', 'not_json'],
      ['[1]', 'not_an_object'],
    ]
    for (const [body, error] of bad) assert.deepEqual(await h.post('/submit', body), { status: 400, body: { error } })
    assert.deepEqual(await h.post('/session', { vendor: 'x' }), { status: 400, body: { error: 'expected_empty_body' } })
    assert.deepEqual(await h.post('/status', { stamp: '1', more: '2' }), {
      status: 400,
      body: { error: 'expected_exactly_stamp' },
    })
    assert.deepEqual(await h.post('/submit', 'x'.repeat(2000)), { status: 413, body: { error: 'too_large' } })
    assert.deepEqual(await h.post('/status/123'), { status: 404, body: { error: 'not_found' } })
    assert.deepEqual(await h.post('/constructor'), { status: 404, body: { error: 'not_found' } })
    const get = await fetch(h.issuer.url + '/status')
    assert.equal(get.status, 405)
    const preflight = await fetch(h.issuer.url + '/submit', { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')

    // Didit not answering is a 502, and the session is still good afterwards.
    const stamp = randomStamp()
    h.faces.down = true
    assert.deepEqual(await submit(h, good, stamp), { status: 502, body: { error: 'face_check_unavailable' } })
    assert.deepEqual(await h.post('/session'), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.down = false
    assert.equal((await submit(h, good, stamp)).status, 202)

    // A stamp already waiting, or already on the list, is refused before Didit is asked.
    assert.deepEqual(await submit(h, await h.session(), stamp), { status: 409, body: { error: 'stamp_queued' } })
    await h.issuer.batcher.flush()
    assert.deepEqual(await submit(h, await h.session(), stamp), { status: 409, body: { error: 'already_listed' } })
    assert.equal(h.issuer.store.count(), 0)
  } finally {
    await h.issuer.close()
  }
})

test("a passed ID check puts the stamp on the ID list, signed by the key mixed from the issuer's seed under `id`", async () => {
  const key = keypairJson()
  const h = await start({ key: key.json })
  try {
    const sessionId = await h.idSession()
    const stamp = randomStamp()
    assert.deepEqual(await submitId(h, sessionId, stamp), { status: 202, body: { status: 'queued' } })
    assert.deepEqual((await h.post('/id/status', { stamp: stamp.toString() })).body, { status: 'queued' })
    assert.deepEqual((await h.post('/status', { stamp: stamp.toString() })).body, { status: 'unknown' }, 'the face list knows nothing of it')

    await h.issuer.id.batcher.flush()
    assert.deepEqual(h.issuer.id.store.stamps(), [stamp])
    assert.deepEqual(h.listed(), [], 'and it is not on the face list')
    assert.deepEqual((await h.post('/id/status', { stamp: stamp.toString() })).body, { status: 'listed' })
    assert.deepEqual(h.logs, ['issuer: batch of 1 added to the ID list'])

    const { file, stamps } = await readFile(h, '/id/list.json')
    const issuer = parseKeypair(key.json, 'test')
    assert.equal(file.issuer, (await issuer.derive('id')).address, "its own key, mixed from the issuer's seed")
    assert.notEqual(file.issuer, issuer.address)
    assert.deepEqual(stamps, [stamp])
    assert.equal((await readFile(h)).file.issuer, issuer.address, 'the face list is still signed by the issuer’s own key')

    // The ID key is the same every time the issuer starts on its key.
    assert.equal((await issuer.derive('id')).address, (await parseKeypair(key.json, 'again').derive('id')).address)
  } finally {
    await h.issuer.close()
  }
})

test('an ID check refuses a face seen in an earlier ID check, and takes one seen only in face checks', async () => {
  const h = await start()
  try {
    const earlierFace = `face-${crypto.randomUUID()}`
    const earlierId = `id-${crypto.randomUUID()}`
    const flagged = { risks: ['DUPLICATED_FACE'] }
    const cases: [ReturnType<typeof passed>, number][] = [
      // The same person moving up from the face list: Didit flags the face, the match says where from.
      [passedId({ ...flagged, matches: [earlierFace] }), 202],
      // A face session from before the tags, its vendor_data a bare uuid.
      [passedId({ risks: ['POSSIBLE_DUPLICATED_FACE'], matches: [crypto.randomUUID()] }), 202],
      // A second try at the ID list, with any document: refused, even if Didit approved it.
      [passedId({ ...flagged, matches: [earlierId] }), 403],
      [passedId({ ...flagged, matches: [earlierFace, earlierId] }), 403],
      [passedId({ matches: [earlierId] }), 403],
      // Flagged, with no match to say which check saw it: refused.
      [passedId({ ...flagged }), 403],
    ]
    for (const [decision, status] of cases) {
      const answer = await submitId(h, await h.idSession(decision), randomStamp())
      assert.equal(answer.status, status, JSON.stringify(decision))
      if (status === 403) assert.deepEqual(answer.body, { error: 'duplicate_face' })
    }

    // The face check is unchanged: any duplicate refuses, whichever check saw the face.
    const moved = await h.session(passed({ ...flagged, matches: [earlierId] }))
    assert.deepEqual(await submit(h, moved, randomStamp()), { status: 403, body: { error: 'duplicate_face' } })
  } finally {
    await h.issuer.close()
  }
})

test('every ID refusal, and a session counts only on the list its check fills', async () => {
  const h = await start()
  try {
    const cases: [ReturnType<typeof passed>, string][] = [
      [passedId({ documents: [] }), 'no_document'],
      [passedId({ documents: [{ status: 'Declined' }] }), 'document_not_passed'],
      [passedId({ documents: [{ status: 'Approved' }, { status: 'In Review' }] }), 'document_not_passed'],
      [passedId({ faceMatches: [] }), 'no_face_match'],
      [passedId({ faceMatches: [{ status: 'Declined' }] }), 'face_match_not_passed'],
      [passedId({ liveness: [] }), 'no_liveness'],
      [passedId({ status: 'In Review' }), 'not_approved'],
    ]
    for (const [decision, error] of cases) {
      assert.deepEqual(await submitId(h, await h.idSession(decision), randomStamp()), { status: 403, body: { error } })
    }

    // A face session sent to the ID list, or an ID session to the face list, is on the wrong workflow.
    const faceSession = await h.session()
    h.ids.set(faceSession, passed())
    assert.deepEqual(await submitId(h, faceSession, randomStamp()), { status: 403, body: { error: 'wrong_workflow' } })
    const idSession = await h.idSession()
    h.faces.set(idSession, passedId())
    assert.deepEqual(await submit(h, idSession, randomStamp()), { status: 403, body: { error: 'wrong_workflow' } })

    // Free, the ID check takes an empty body and nothing else, and counts against the same limit.
    assert.deepEqual(await h.post('/id/session', { payment: '0'.repeat(32) }), { status: 400, body: { error: 'expected_empty_body' } })
    assert.equal(h.payments.asked, 0, 'free, nothing is looked for on chain')
    assert.deepEqual(await h.post('/id/list.json'), { status: 405, body: { error: 'get_only' } })
    assert.equal(h.issuer.id.store.count(), 0)
  } finally {
    await h.issuer.close()
  }
})

test('with a price, an ID check opens once a payment naming its reference has landed, and each payment opens one', async () => {
  const key = keypairJson()
  const h = await start({ key: key.json, env: PRICED })
  try {
    // Asked with nothing, it answers with a payment to make.
    const asked = await h.post('/id/session')
    assert.equal(asked.status, 402)
    assert.equal(asked.body.error, 'payment_required')
    const { payment } = asked.body
    assert.deepEqual(Object.keys(payment).sort(), ['amount', 'id', 'mint', 'reference', 'to'])
    assert.match(payment.id, /^[0-9a-f]{32}$/)
    assert.deepEqual([payment.to, payment.mint, payment.amount], [PRICED.ID_TIER_PAY_TO, PRICED.ID_TIER_MINT, PRICED.ID_TIER_PRICE])
    const issuer = parseKeypair(key.json, 'test')
    assert.equal(payment.reference, (await issuer.derive(`reference/${payment.id}`)).address, "the reference: a key mixed from the issuer's seed")
    const other = (await h.post('/id/session')).body.payment
    assert.notEqual(other.id, payment.id)
    assert.notEqual(other.reference, payment.reference, 'one reference per payment')
    assert.equal(h.ids.created, 0, 'no session yet')
    assert.equal((await h.post('/session')).status, 201, 'the face check stays free')

    // Until a payment naming the reference has landed, nothing opens.
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 402, body: { error: 'not_paid' } })
    h.payments.down = true
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 502, body: { error: 'payment_check_unavailable' } })
    h.payments.down = false

    // Landed: one session, and the payment is used.
    const signature = randomSignature()
    h.payments.paid.set(payment.reference, [signature])
    const opened = await h.post('/id/session', { payment: payment.id })
    assert.equal(opened.status, 201)
    assert.match(opened.body.url, /^https:\/\//)
    assert.equal(h.ids.created, 1)
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 409, body: { error: 'payment_used' } })
    // One transaction naming two references still pays for one check.
    h.payments.paid.set(other.reference, [signature])
    assert.deepEqual(await h.post('/id/session', { payment: other.id }), { status: 409, body: { error: 'payment_used' } })
    // A second payment naming the same reference opens a second.
    h.payments.paid.set(payment.reference, [randomSignature(), signature])
    assert.equal((await h.post('/id/session', { payment: payment.id })).status, 201)
    assert.equal(h.ids.created, 2)

    // Didit down: no session, and the payment is still good afterwards.
    const third = (await h.post('/id/session')).body.payment
    h.payments.paid.set(third.reference, [randomSignature()])
    h.ids.down = true
    assert.deepEqual(await h.post('/id/session', { payment: third.id }), { status: 502, body: { error: 'face_check_unavailable' } })
    h.ids.down = false
    assert.equal((await h.post('/id/session', { payment: third.id })).status, 201)

    // The session it opened is an ID session like any other.
    h.ids.set(opened.body.sessionId, passedId())
    assert.equal((await submitId(h, opened.body.sessionId, randomStamp())).status, 202)

    const bad: [unknown, number, string][] = [
      [{ payment: 'ABC' }, 400, 'bad_payment'],
      [{ payment: payment.id.toUpperCase() }, 400, 'bad_payment'],
      [{ payment: payment.id, more: 'x' }, 400, 'expected_exactly_payment'],
      [{ paid: payment.id }, 400, 'expected_exactly_payment'],
    ]
    for (const [body, status, error] of bad) assert.deepEqual(await h.post('/id/session', body), { status, body: { error } })
  } finally {
    await h.issuer.close()
  }
})

test('a batch goes onto the list in random order', async () => {
  const h = await start()
  try {
    const submitted: bigint[] = []
    for (let i = 0; i < 30; i++) {
      const c = randomStamp()
      submitted.push(c)
      assert.equal((await submit(h, await h.session(), c)).status, 202)
    }
    await h.issuer.batcher.flush()

    const inserted = h.listed()
    assert.deepEqual([...inserted].sort(), [...submitted].sort(), 'every stamp, once')
    assert.notDeepEqual(inserted, submitted, 'not in the order they arrived')
    // The file keeps them in key order; the batch must not follow that either.
    const keyOrder = [...submitted].sort((a, b) => Buffer.compare(Buffer.from(toBytes32(a)), Buffer.from(toBytes32(b))))
    assert.notDeepEqual(inserted, keyOrder, 'not in the order the file keeps them')
  } finally {
    await h.issuer.close()
  }
})

test('shuffle is Fisher–Yates over the random index it is given', () => {
  // Always picking index 0 walks one exact permutation.
  assert.deepEqual(shuffle([1, 2, 3, 4], () => 0), [2, 3, 4, 1])
  // Always picking the top index leaves the order alone.
  assert.deepEqual(shuffle([1, 2, 3, 4], (n) => n - 1), [1, 2, 3, 4])
  // Each of the 6 orders of 3 items comes up, with the real random source.
  const seen = new Set<string>()
  for (let i = 0; i < 600; i++) seen.add(shuffle(['a', 'b', 'c']).join(''))
  assert.equal(seen.size, 6)
})

test('a batch runs once BATCH_MAX are waiting, and on the timer', async () => {
  const counted = await start({ batchMax: 5 })
  try {
    for (let i = 0; i < 4; i++) await submit(counted, await counted.session(), randomStamp())
    await counted.issuer.batcher.idle()
    assert.equal(counted.listed().length, 0, 'four wait')
    await submit(counted, await counted.session(), randomStamp())
    await counted.issuer.batcher.idle()
    assert.equal(counted.listed().length, 5, 'the fifth sends all five')
    assert.equal(counted.issuer.store.count(), 0)
  } finally {
    await counted.issuer.close()
  }

  const timed = await start({ intervalSeconds: 1 })
  try {
    await submit(timed, await timed.session(), randomStamp())
    await submit(timed, await timed.session(), randomStamp())
    for (let i = 0; i < 100 && timed.listed().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(timed.listed().length, 2, 'the timer sent the two waiting')
  } finally {
    await timed.issuer.close()
  }
})

test('a stamp queued again while it was being listed goes on the list once', async () => {
  const h = await start()
  try {
    const twice = randomStamp()
    await submit(h, await h.session(), twice)
    await h.issuer.batcher.flush()
    const roots = h.issuer.store.snapshots().length
    // As if a submit that checked the list before this batch listed it reached the queue after.
    assert.equal(h.issuer.store.accept(crypto.randomUUID(), twice), 'queued')
    const other = randomStamp()
    await submit(h, await h.session(), other)
    await h.issuer.batcher.flush()
    assert.deepEqual(h.listed(), [twice, other], 'each once')
    assert.equal(h.issuer.store.count(), 0)
    assert.equal(h.issuer.store.snapshots().length, roots + 1, 'one root for the one added')

    // A batch of nothing new adds no root.
    assert.equal(h.issuer.store.accept(crypto.randomUUID(), other), 'queued')
    await h.issuer.batcher.flush()
    assert.equal(h.issuer.store.count(), 0)
    assert.equal(h.issuer.store.snapshots().length, roots + 1)
  } finally {
    await h.issuer.close()
  }
})

test('a batch that fails adds nothing, and everything waits for the next', async () => {
  const h = await start()
  try {
    const all: bigint[] = []
    for (let i = 0; i < 10; i++) {
      const c = randomStamp()
      all.push(c)
      await submit(h, await h.session(), c)
    }
    const append = h.issuer.store.append
    h.issuer.store.append = () => {
      throw new RangeError('the disk is full')
    }
    await h.issuer.batcher.flush()
    assert.deepEqual(h.listed(), [])
    assert.equal(h.issuer.store.count(), 10)
    assert.equal(h.issuer.list.size, 0)
    for (const c of all) assert.deepEqual((await h.post('/status', { stamp: c.toString() })).body, { status: 'queued' })
    assert.match(h.logs.at(-1)!, /^issuer: batch of 10 not added to the list \(RangeError\); all wait$/)
    assert.deepEqual(JSON.parse(await (await h.get('/list.json')).text()).snapshots, [], 'no snapshot was published')

    h.issuer.store.append = append
    await h.issuer.batcher.flush()
    assert.deepEqual([...h.listed()].sort(), [...all].sort())
    const [only] = JSON.parse(await (await h.get('/list.json')).text()).snapshots
    assert.equal(BigInt('0x' + only.root), listRoot(h.listed()), 'the tree was not left grown by the failed batch')
  } finally {
    await h.issuer.close()
  }
})

test('after the batch, the file holds each list and no link from a session to a stamp', async () => {
  const h = await start({ env: PRICED })
  const sessionIds: string[] = []
  const stamps: bigint[] = []
  const id = { sessionIds: [] as string[], stamps: [] as bigint[], payments: [] as string[] }
  try {
    // The ID list too, each check paid for: its stamps, its sessions and its payments, the same way.
    for (let i = 0; i < 20; i++) {
      const { sessionId, signature } = await paidIdSession(h)
      const c = randomStamp()
      assert.equal((await submitId(h, sessionId, c)).status, 202)
      id.sessionIds.push(sessionId)
      id.stamps.push(c)
      id.payments.push(signature)
    }
    await h.issuer.id.batcher.flush()

    // 300 rows run the queue past one 4 KB page, so it has interior pages and has been rebalanced.
    for (let i = 0; i < 300; i++) {
      const sessionId = await h.session()
      const c = randomStamp()
      assert.equal((await submit(h, sessionId, c)).status, 202)
      sessionIds.push(sessionId)
      stamps.push(c)
    }
    assertFileHolds(h.dbPath, stamps)

    // A batch that fails, then one that lands.
    const append = h.issuer.store.append
    h.issuer.store.append = () => {
      throw new Error('the disk is full')
    }
    await h.issuer.batcher.flush()
    assert.equal(h.issuer.store.count(), 300)
    h.issuer.store.append = append
    await h.issuer.batcher.flush()
    assert.equal(h.listed().length, 300)
  } finally {
    await h.issuer.close()
  }
  assertNoLink(h.dbPath, { sessionIds, stamps }, id)
})

type Snapshot = { root: string; signature: string; size: number; time: number }
type ListFile = { v: number; issuer: string; stamps: string[]; snapshots: Snapshot[] }

/** Whether a snapshot is signed by this issuer, checked as a registry reader checks a row: `issuerSigned`. */
function signed(issuer: string, s: Snapshot): boolean {
  return issuerSigned({ issuer: base58.decode(issuer), root: hex.decode(s.root), issuerSignature: hex.decode(s.signature) })
}

/** The list file as a reader takes it: canonical text, the fields README.md names, every snapshot its prefix's and signed. */
async function readFile(h: Harness, path = '/list.json'): Promise<{ text: string; stamps: bigint[]; file: ListFile }> {
  const text = await (await h.get(path)).text()
  const file = parseCanonical(text) as ListFile
  assert.equal(canonical(file), text, 'canonical text')
  assert.deepEqual(Object.keys(file).sort(), ['issuer', 'snapshots', 'stamps', 'v'])
  assert.equal(file.v, 1)
  const stamps = file.stamps.map((s) => BigInt(s))
  for (const s of file.snapshots) {
    assert.deepEqual(Object.keys(s).sort(), ['root', 'signature', 'size', 'time'])
    assert.match(s.root, /^[0-9a-f]{64}$/)
    assert.equal(BigInt('0x' + s.root), listRoot(stamps.slice(0, s.size)), "each root is forest's listRoot of its first `size` stamps")
    assert.ok(signed(file.issuer, s), 'signed by the issuer the file names, over the root as 32 big-endian bytes')
  }
  assert.equal(file.snapshots.at(-1)?.size ?? 0, stamps.length, "the newest snapshot is the whole list's")
  return { text, stamps, file }
}

test("the list file: the stamps in order, and each snapshot signed with the issuer's key", async () => {
  let now = 1_790_000_000_000
  const key = keypairJson()
  const h = await start({ key: key.json, now: () => now })
  let before
  try {
    const empty = await readFile(h)
    assert.deepEqual(empty.stamps, [], 'an empty list at first')
    assert.deepEqual(empty.file.snapshots, [], 'and no snapshot')
    assert.equal(empty.file.issuer, base58.encode(key.publicKey), "the issuer is named by its key's address")

    for (let i = 0; i < 3; i++) await submit(h, await h.session(), randomStamp())
    await h.issuer.batcher.flush()
    const first = now
    now += 3_600_000
    for (let i = 0; i < 2; i++) await submit(h, await h.session(), randomStamp())
    await h.issuer.batcher.flush()

    before = await readFile(h)
    assert.deepEqual(before.stamps, h.listed(), 'the file holds the list, in its order')
    assert.deepEqual(
      before.file.snapshots.map((s) => [s.size, s.time]),
      [[3, first], [5, now]],
      'one snapshot per batch, oldest first, with the size and the time of its batch',
    )

    const res = await h.get('/list.json')
    assert.equal(res.headers.get('content-type'), 'application/json')
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'any page may read it')

    // A signature counts for its own root and issuer only.
    const [a, b] = before.file.snapshots as [Snapshot, Snapshot]
    assert.equal(signed(before.file.issuer, { ...a, root: b.root }), false)
    assert.equal(signed(base58.encode(keypairJson().publicKey), a), false)

    assert.deepEqual(await h.post('/list.json'), { status: 405, body: { error: 'get_only' } })
    assert.deepEqual(await h.post('/roots.json'), { status: 404, body: { error: 'not_found' } })
    assert.equal((await h.get('/status')).status, 405, 'the routes a person calls stay POST')
  } finally {
    await h.issuer.close()
  }

  // Started again on the same file and key: the same list, and the same file byte for byte.
  const again = await start({ key: key.json, dbPath: h.dbPath })
  try {
    const after = await readFile(again)
    assert.equal(after.text, before.text)
    for (const s of after.stamps) assert.deepEqual((await again.post('/status', { stamp: s.toString() })).body, { status: 'listed' })
  } finally {
    await again.issuer.close()
  }
})

test('a file written before the list moved off chain opens under the new names, its list kept', async () => {
  const dbPath = join(tempDir(), 'old.sqlite')
  const old = new DatabaseSync(dbPath)
  const stamps = [randomStamp(), randomStamp()]
  old.exec(`
    CREATE TABLE used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE queue (commitment BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE list (position INTEGER PRIMARY KEY, commitment BLOB NOT NULL);
    CREATE TABLE roots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL, notes TEXT);
  `)
  stamps.forEach((s, i) => old.prepare('INSERT INTO list (position, commitment) VALUES (?, ?)').run(i, toBytes32(s)))
  old.prepare('INSERT INTO roots (size, root, time, notes) VALUES (?, ?, ?, ?)').run(2, toBytes32(listRoot(stamps)), 1_790_000_000_000, 'sig1 sig2')
  old.close()

  const h = await start({ dbPath })
  try {
    const { stamps: listed, file } = await readFile(h)
    assert.deepEqual(listed, stamps)
    assert.deepEqual(file.snapshots.map((s) => s.size), [2])
    await submit(h, await h.session(), randomStamp())
    await h.issuer.batcher.flush()
    assert.equal((await readFile(h)).stamps.length, 3)
  } finally {
    await h.issuer.close()
  }
})

test('the store queues a stamp only with an unused session, in one step', () => {
  const store = new Store(join(tempDir(), 'store.sqlite'))
  try {
    const session = crypto.randomUUID()
    const c = randomStamp()
    assert.equal(store.accept(session, c), 'queued')
    assert.equal(store.accept(session, randomStamp()), 'session_used')
    assert.equal(store.accept(crypto.randomUUID(), c), 'stamp_queued')
    assert.deepEqual(store.queued(), [c], 'a refused accept leaves nothing behind')
    assert.equal(store.isUsed(session), true)
  } finally {
    store.close()
  }
})

test('the configuration names what is missing', () => {
  assert.throws(() => readConfig({}), /DIDIT_API_KEY, DIDIT_WORKFLOW_ID, DIDIT_ID_WORKFLOW_ID, ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH/)
  const base = { DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', DIDIT_ID_WORKFLOW_ID: 'i', ISSUER_KEYPAIR_PATH: 'p' }
  assert.throws(() => readConfig({ ...base, BATCH_MAX: '0' }), /BATCH_MAX/)
  const config = readConfig(base)
  assert.equal(config.batchMax, 50)
  assert.equal(config.batchIntervalMs, 3_600_000)
  assert.equal(config.diditBaseUrl, 'https://verification.didit.me')
  assert.equal(config.sessionLimitPerHour, 5)
  assert.equal(config.clientAddressHeader, undefined)
  assert.equal(readConfig({ ...base, CLIENT_ADDRESS_HEADER: 'X-Real-IP' }).clientAddressHeader, 'x-real-ip')
  assert.equal(config.idTierPrice, 0n, 'the ID check is free unless a price is set')

  // A price needs its dollar, the address it is paid to, and an RPC to find it through.
  assert.throws(() => readConfig({ ...base, ID_TIER_PRICE: '2500000' }), /missing environment variables: ID_TIER_MINT, ID_TIER_PAY_TO, RPC_URL/)
  for (const price of ['2.5', '-1', '01', 'free']) assert.throws(() => readConfig({ ...base, ID_TIER_PRICE: price }), /ID_TIER_PRICE must be a whole number/)
  assert.throws(() => readConfig({ ...base, ...PRICED, ID_TIER_PAY_TO: 'not-an-address' }), /ID_TIER_PAY_TO is not an address/)
  assert.equal(readConfig({ ...base, ...PRICED }).idTierPrice, 2_500_000n)
})

test("the ID check's price is never paid to one of the issuer's signing keys", async () => {
  const key = keypairJson()
  const issuer = parseKeypair(key.json, 'test')
  for (const signer of [issuer.address, (await issuer.derive('id')).address]) {
    await assert.rejects(start({ key: key.json, env: { ...PRICED, ID_TIER_PAY_TO: signer } }), /ID_TIER_PAY_TO is one of the issuer's signing keys/)
  }
})

test('opening sessions is limited per address, and a refusal says only "try later"', async () => {
  const h = await start({ env: { SESSION_LIMIT_PER_HOUR: '3', CLIENT_ADDRESS_HEADER: 'x-real-ip' } })
  try {
    const from = (address: string) => h.post('/session', {}, { 'x-real-ip': address })
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.7')).status, 201)
    assert.deepEqual(await from('203.0.113.7'), { status: 429, body: { error: 'try_later' } })
    assert.equal(h.faces.created, 3, 'a refused request never reaches Didit')
    assert.equal((await from('203.0.113.8')).status, 201, 'another address has its own share')

    // An IPv6 address counts with the rest of its /64, so walking through one's own addresses gets no more.
    for (const a of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b', '2001:0db8:0001:0002:0:0:0:c']) {
      assert.equal((await from(a)).status, 201)
    }
    assert.equal((await from('2001:db8:1:2:9::d')).status, 429)
    assert.equal((await from('2001:db8:1:3::a')).status, 201, 'the next /64 is someone else')

    // A malformed request is refused before it is counted, and submits are not limited.
    assert.equal((await h.post('/session', { x: 1 }, { 'x-real-ip': '203.0.113.9' })).status, 400)
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.9')).status, 201)

    // The address is never written: not in the log, not in the file.
    const sessionId = await h.session()
    assert.equal((await h.post('/submit', { sessionId, stamp: randomStamp().toString() }, { 'x-real-ip': '203.0.113.7' })).status, 202)
    await h.issuer.batcher.flush()
    assert.deepEqual(h.logs, ['issuer: batch of 1 added to the list'])
    const file = readFileSync(h.dbPath)
    for (const a of ['203.0.113.7', '203.0.113.8', '2001:db8']) assert.equal(file.includes(Buffer.from(a)), false)
  } finally {
    await h.issuer.close()
  }

  // Without a header named, every request counts against the connection's own address.
  const direct = await start({ env: { SESSION_LIMIT_PER_HOUR: '2' } })
  try {
    assert.equal((await direct.post('/session', {}, { 'x-real-ip': '198.51.100.1' })).status, 201)
    assert.equal((await direct.post('/session', {}, { 'x-real-ip': '198.51.100.2' })).status, 201)
    assert.equal((await direct.post('/session', {}, { 'x-real-ip': '198.51.100.3' })).status, 429, 'a header nobody named is ignored')
  } finally {
    await direct.issuer.close()
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

test('the key from a sealed variable: a private temporary file, loaded, then deleted', () => {
  const { json: contents, publicKey } = keypairJson()
  const numbers = JSON.parse(contents) as number[]

  const env: Record<string, string | undefined> = {
    DIDIT_API_KEY: 'k',
    DIDIT_WORKFLOW_ID: 'w',
    DIDIT_ID_WORKFLOW_ID: 'i',
    ISSUER_KEYPAIR: contents,
  }
  const config = readConfig(env)
  assert.equal(config.issuerKeypair, contents)
  assert.equal(config.issuerKeypairPath, undefined)
  assert.equal(env.ISSUER_KEYPAIR, undefined, 'taken out of the environment once read')
  assert.throws(
    () => readConfig({ ...env, ISSUER_KEYPAIR: contents, ISSUER_KEYPAIR_PATH: '/k.json' }),
    /not both/,
  )

  const file = writeKeyFile(contents)
  try {
    assert.ok(file.path.startsWith(tmpdir()), 'under the system temporary directory, not the repo')
    assert.equal(statSync(file.path).mode & 0o777, 0o600, 'the file: this user only')
    assert.equal(statSync(dirname(file.path)).mode & 0o777, 0o700, 'its directory: this user only')
    assert.deepEqual(loadKeypair(file.path).publicKey, publicKey)
  } finally {
    file.remove()
  }
  assert.equal(existsSync(dirname(file.path)), false, 'removed, directory and all')

  // A malformed key is refused, and the message quotes none of it.
  const broken = [
    contents.slice(0, 40),
    JSON.stringify(numbers.slice(0, 32)),
    JSON.stringify([...numbers.slice(0, 32), ...JSON.parse(keypairJson().json).slice(32)]),
  ]
  for (const text of broken) {
    assert.throws(
      () => writeKeyFile(text),
      (error: Error) => /^ISSUER_KEYPAIR is not a Solana keypair/.test(error.message) && !error.message.includes(text.slice(1, 12)),
    )
  }
})
