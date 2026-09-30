// The issuer without a chain: a stand-in Didit and an in-memory list, a real SQLite file, real HTTP.
//
//   npm test

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { BN254_R, toBytes32 } from '../../registry/client/src/field.ts'
import { Keypair } from '@solana/web3.js'

import { shuffle } from '../src/batch.ts'
import { RateLimit, addressGroup } from '../src/limit.ts'
import { loadKeypair, writeKeyFile } from '../src/list.ts'
import { readConfig, startIssuer, type Issuer } from '../src/service.ts'
import { Store } from '../src/store.ts'
import {
  FakeFaceCheck,
  FakeList,
  WORKFLOW,
  assertFileHolds,
  assertNoLink,
  passed,
  randomCommitment,
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
  list: FakeList
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new session whose check came to `decision`; returns its id. */
  session(decision?: ReturnType<typeof passed>): Promise<string>
}

async function start(
  options: { batchMax?: number; intervalSeconds?: number; env?: Record<string, string> } = {},
): Promise<Harness> {
  const dbPath = join(tempDir(), 'issuer.sqlite')
  const config = readConfig({
    DIDIT_API_KEY: 'not-used',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    ISSUER_KEYPAIR_PATH: 'not-used',
    SOLANA_RPC_URL: 'not-used',
    DATABASE_PATH: dbPath,
    BATCH_MAX: String(options.batchMax ?? 1000),
    BATCH_INTERVAL_SECONDS: String(options.intervalSeconds ?? 3600),
    // Every request here comes from one address; the limit has its own test.
    SESSION_LIMIT_PER_HOUR: '100000',
    PORT: '0',
    ...options.env,
  })
  const faces = new FakeFaceCheck()
  const list = new FakeList()
  const logs: string[] = []
  const issuer = await startIssuer(config, { faceCheck: faces, list, log: (line) => logs.push(line) })
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
  return { issuer, faces, list, dbPath, logs, post, session }
}

const submit = (h: Harness, sessionId: string, commitment: bigint) =>
  h.post('/submit', { sessionId, commitment: commitment.toString() })

test('a passed face check puts the commitment on the list', async () => {
  const h = await start()
  try {
    const created = await h.post('/session')
    assert.equal(created.status, 201)
    assert.match(created.body.url, /^https:\/\//)
    h.faces.set(created.body.sessionId, passed())

    const commitment = randomCommitment()
    assert.deepEqual(await submit(h, created.body.sessionId, commitment), { status: 202, body: { status: 'queued' } })
    assert.deepEqual((await h.post('/status', { commitment: commitment.toString() })).body, { status: 'queued' })
    assert.deepEqual(h.list.members, [], 'nothing goes on the list before the batch')

    await h.issuer.batcher.flush()
    assert.deepEqual(h.list.members, [commitment])
    assert.deepEqual((await h.post('/status', { commitment: commitment.toString() })).body, { status: 'listed' })
    assert.deepEqual((await h.post('/status', { commitment: randomCommitment().toString() })).body, { status: 'unknown' })
    assert.deepEqual(h.logs, ['issuer: batch of 1 inserted'], 'the log holds a count and nothing else')
  } finally {
    await h.issuer.close()
  }
})

test('a failed liveness check is refused, and uses nothing up', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed({ status: 'Declined', liveness: [{ status: 'Declined' }] }))
    const commitment = randomCommitment()
    assert.deepEqual(await submit(h, sessionId, commitment), { status: 403, body: { error: 'liveness_not_passed' } })
    assert.equal(h.issuer.store.count(), 0)

    // A liveness step still in review, in a session already approved, is not a pass either.
    h.faces.set(sessionId, passed({ liveness: [{ status: 'Approved' }, { status: 'In Review' }] }))
    assert.deepEqual(await submit(h, sessionId, commitment), { status: 403, body: { error: 'liveness_not_passed' } })

    // The session was not used up: once Didit says it passed, it counts.
    h.faces.set(sessionId, passed())
    assert.equal((await submit(h, sessionId, commitment)).status, 202)
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
      assert.deepEqual(await submit(h, declined, randomCommitment()), { status: 403, body: { error: 'duplicate_face' } })
      // And a workflow whose rules approved it anyway: the risk code alone refuses.
      const approved = await h.session(passed({ risks: [risk] }))
      assert.deepEqual(await submit(h, approved, randomCommitment()), { status: 403, body: { error: 'duplicate_face' } })
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
    const first = randomCommitment()
    assert.equal((await submit(h, sessionId, first)).status, 202)
    assert.deepEqual(await submit(h, sessionId, randomCommitment()), { status: 409, body: { error: 'session_used' } })
    assert.deepEqual(await submit(h, sessionId, first), { status: 409, body: { error: 'session_used' } })

    // Two requests with one session, both waiting on Didit at once: exactly one commitment is queued.
    const racing = await h.session()
    const release = h.faces.hold()
    const both = Promise.all([submit(h, racing, randomCommitment()), submit(h, racing, randomCommitment())])
    while (h.faces.waiting < 2) await new Promise((r) => setTimeout(r, 5))
    release()
    const statuses = (await both).map((r) => r.status).sort()
    assert.deepEqual(statuses, [202, 409])
    assert.equal(h.issuer.store.count(), 2, 'one commitment from each session')

    // After the batch, the used sessions are still refused.
    await h.issuer.batcher.flush()
    assert.deepEqual(await submit(h, sessionId, randomCommitment()), { status: 409, body: { error: 'session_used' } })
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
      assert.deepEqual(await submit(h, await h.session(decision), randomCommitment()), { status: 403, body: { error } })
    }
    assert.deepEqual(await submit(h, crypto.randomUUID(), randomCommitment()), {
      status: 403,
      body: { error: 'unknown_session' },
    })

    const good = await h.session()
    const bad: [unknown, string][] = [
      [{ sessionId: 'not-a-uuid', commitment: '5' }, 'bad_session_id'],
      [{ sessionId: good, commitment: '0' }, 'bad_commitment'],
      [{ sessionId: good, commitment: '007' }, 'bad_commitment'],
      [{ sessionId: good, commitment: '0x12' }, 'bad_commitment'],
      [{ sessionId: good, commitment: '-5' }, 'bad_commitment'],
      [{ sessionId: good, commitment: BN254_R.toString() }, 'bad_commitment'],
      [{ sessionId: good, commitment: 5 }, 'expected_exactly_sessionId_and_commitment'],
      [{ sessionId: good, commitment: '5', wallet: 'x' }, 'expected_exactly_sessionId_and_commitment'],
      [{ sessionId: good }, 'expected_exactly_sessionId_and_commitment'],
      ['not json', 'not_json'],
      ['[1]', 'not_an_object'],
    ]
    for (const [body, error] of bad) assert.deepEqual(await h.post('/submit', body), { status: 400, body: { error } })
    assert.deepEqual(await h.post('/session', { vendor: 'x' }), { status: 400, body: { error: 'expected_empty_body' } })
    assert.deepEqual(await h.post('/status', { commitment: '1', more: '2' }), {
      status: 400,
      body: { error: 'expected_exactly_commitment' },
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
    const commitment = randomCommitment()
    h.faces.down = true
    assert.deepEqual(await submit(h, good, commitment), { status: 502, body: { error: 'face_check_unavailable' } })
    assert.deepEqual(await h.post('/session'), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.down = false
    assert.equal((await submit(h, good, commitment)).status, 202)

    // A commitment already waiting, or already on the list, is refused before Didit is asked.
    assert.deepEqual(await submit(h, await h.session(), commitment), { status: 409, body: { error: 'commitment_queued' } })
    await h.issuer.batcher.flush()
    assert.deepEqual(await submit(h, await h.session(), commitment), { status: 409, body: { error: 'already_listed' } })
    assert.equal(h.issuer.store.count(), 0)
  } finally {
    await h.issuer.close()
  }
})

test('a batch goes onto the list in random order', async () => {
  const h = await start()
  try {
    const submitted: bigint[] = []
    for (let i = 0; i < 30; i++) {
      const c = randomCommitment()
      submitted.push(c)
      assert.equal((await submit(h, await h.session(), c)).status, 202)
    }
    await h.issuer.batcher.flush()

    const inserted = h.list.members
    assert.deepEqual([...inserted].sort(), [...submitted].sort(), 'every commitment, once')
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
    for (let i = 0; i < 4; i++) await submit(counted, await counted.session(), randomCommitment())
    await counted.issuer.batcher.idle()
    assert.equal(counted.list.members.length, 0, 'four wait')
    await submit(counted, await counted.session(), randomCommitment())
    await counted.issuer.batcher.idle()
    assert.equal(counted.list.members.length, 5, 'the fifth sends all five')
    assert.equal(counted.issuer.store.count(), 0)
  } finally {
    await counted.issuer.close()
  }

  const timed = await start({ intervalSeconds: 1 })
  try {
    await submit(timed, await timed.session(), randomCommitment())
    await submit(timed, await timed.session(), randomCommitment())
    for (let i = 0; i < 100 && timed.list.members.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(timed.list.members.length, 2, 'the timer sent the two waiting')
  } finally {
    await timed.issuer.close()
  }
})

test('a commitment already on the list is not sent again', async () => {
  const h = await start()
  try {
    const landed = randomCommitment()
    const other = randomCommitment()
    await submit(h, await h.session(), landed)
    await submit(h, await h.session(), other)
    // As if a batch inserted it and stopped before deleting it from the queue.
    h.list.members.push(landed)
    await h.issuer.batcher.flush()
    assert.deepEqual([...h.list.members].sort(), [landed, other].sort(), 'each once')
    assert.equal(h.issuer.store.count(), 0)
  } finally {
    await h.issuer.close()
  }
})

test('a batch that fails keeps the rest waiting', async () => {
  const h = await start()
  try {
    const all: bigint[] = []
    for (let i = 0; i < 10; i++) {
      const c = randomCommitment()
      all.push(c)
      await submit(h, await h.session(), c)
    }
    h.list.failAt = 3
    await h.issuer.batcher.flush()
    assert.equal(h.list.members.length, 3)
    assert.equal(h.issuer.store.count(), 7)
    const waiting = all.filter((c) => !h.list.members.includes(c))
    for (const c of waiting) assert.deepEqual((await h.post('/status', { commitment: c.toString() })).body, { status: 'queued' })
    assert.match(h.logs.at(-1)!, /^issuer: batch stopped after 3 of 10 \(Error\); the rest wait$/)

    h.list.failAt = Infinity
    await h.issuer.batcher.flush()
    assert.deepEqual([...h.list.members].sort(), [...all].sort())
  } finally {
    await h.issuer.close()
  }
})

test('after the batch, the file holds no link from a session to a commitment', async () => {
  const h = await start()
  const sessionIds: string[] = []
  const commitments: bigint[] = []
  try {
    // 300 rows run the queue past one 4 KB page, so it has interior pages and has been rebalanced.
    for (let i = 0; i < 300; i++) {
      const sessionId = await h.session()
      const c = randomCommitment()
      assert.equal((await submit(h, sessionId, c)).status, 202)
      sessionIds.push(sessionId)
      commitments.push(c)
    }
    assertFileHolds(h.dbPath, commitments)

    // A batch that stops part way, then one that finishes.
    h.list.failAt = 120
    await h.issuer.batcher.flush()
    assert.equal(h.issuer.store.count(), 180)
    h.list.failAt = Infinity
    await h.issuer.batcher.flush()
    assert.equal(h.list.members.length, 300)
  } finally {
    await h.issuer.close()
  }
  assertNoLink(h.dbPath, sessionIds, commitments)
})

test('the store queues a commitment only with an unused session, in one step', () => {
  const store = new Store(join(tempDir(), 'store.sqlite'))
  try {
    const session = crypto.randomUUID()
    const c = randomCommitment()
    assert.equal(store.accept(session, c), 'queued')
    assert.equal(store.accept(session, randomCommitment()), 'session_used')
    assert.equal(store.accept(crypto.randomUUID(), c), 'commitment_queued')
    assert.deepEqual(store.queued(), [c], 'a refused accept leaves nothing behind')
    assert.equal(store.isUsed(session), true)
  } finally {
    store.close()
  }
})

test('the configuration names what is missing', () => {
  assert.throws(
    () => readConfig({}),
    /DIDIT_API_KEY, DIDIT_WORKFLOW_ID, SOLANA_RPC_URL, ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH/,
  )
  const base = { DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', ISSUER_KEYPAIR_PATH: 'p', SOLANA_RPC_URL: 'r' }
  assert.throws(() => readConfig({ ...base, BATCH_MAX: '0' }), /BATCH_MAX/)
  const config = readConfig(base)
  assert.equal(config.batchMax, 50)
  assert.equal(config.batchIntervalMs, 3_600_000)
  assert.equal(config.listIndex, 0)
  assert.equal(config.diditBaseUrl, 'https://verification.didit.me')
  assert.equal(config.sessionLimitPerHour, 5)
  assert.equal(config.clientAddressHeader, undefined)
  assert.equal(readConfig({ ...base, CLIENT_ADDRESS_HEADER: 'X-Real-IP' }).clientAddressHeader, 'x-real-ip')
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
    assert.equal((await h.post('/submit', { sessionId, commitment: randomCommitment().toString() }, { 'x-real-ip': '203.0.113.7' })).status, 202)
    await h.issuer.batcher.flush()
    assert.deepEqual(h.logs, ['issuer: batch of 1 inserted'])
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
  const keypair = Keypair.generate()
  const contents = JSON.stringify([...keypair.secretKey])

  const env: Record<string, string | undefined> = {
    DIDIT_API_KEY: 'k',
    DIDIT_WORKFLOW_ID: 'w',
    SOLANA_RPC_URL: 'r',
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
    assert.equal(loadKeypair(file.path).publicKey.toBase58(), keypair.publicKey.toBase58())
  } finally {
    file.remove()
  }
  assert.equal(existsSync(dirname(file.path)), false, 'removed, directory and all')

  // A malformed key is refused, and the message quotes none of it.
  const broken = [contents.slice(0, 40), JSON.stringify([...keypair.secretKey].slice(0, 32)), JSON.stringify([...keypair.secretKey.slice(0, 32), ...Keypair.generate().secretKey.slice(32)])]
  for (const text of broken) {
    assert.throws(
      () => writeKeyFile(text),
      (error: Error) => /^ISSUER_KEYPAIR is not a Solana keypair/.test(error.message) && !error.message.includes(text.slice(1, 12)),
    )
  }
})
