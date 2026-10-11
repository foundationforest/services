// The issuer end to end, in one process: a stand-in Didit, an embedder that knows people by name, a
// real SQLite file, real HTTP, and every note checked the way forest checks one. One test runs the
// devnet stand-in Didit (deploy/fake-didit.ts) itself, with the stand-in embedding.
//
//   npm test

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { issuerSecret } from '../../standard/keys/src/issuer.ts'
import { base58 } from '../../standard/records/src/bytes.ts'
import { hkdf } from '../../standard/keys/src/hkdf.ts'
import { canonical, parseCanonical } from '../../standard/records/src/canonical.ts'
import { toBytes32 } from '../../standard/registry/client/src/field.ts'
import { issuerKeyOf, noteSigned, provePerson, signNote, verifyPerson } from '../../standard/registry/client/src/person.ts'

import { buy, serviceOf } from '../../standard/credits/src/index.ts'
import { keyFrom, seller } from '../../standard/credits/src/service.ts'

/** A service's directory, as standard's seller serves it. */
const directoryOf = async (origin: string, unit: string, credit: { address: string; mint: string; price: string }, pkcs8: Uint8Array) =>
  seller({ origin, key: await keyFrom(pkcs8), unit, requestUri: '/credits/buy', credit, maxBuy: 1000, sponsors: [], rpc: null, path: ':memory:' }).directory()

import type { Directory } from '../src/gift.ts'
import { parseKeypair } from '../src/key.ts'
import { RateLimit, addressGroup } from '../src/limit.ts'
import { issuerHex, noteFromJson, noteToJson } from '../src/notes.ts'
import { NOTE_KEY_INFO, readConfig, startIssuer, type Issuer } from '../src/service.ts'
import {
  FakeFaceCheck,
  FakePayer,
  FakePayments,
  ID_WORKFLOW,
  ISSUER_NAME,
  WORKFLOW,
  assertKept,
  doc,
  keypairJson,
  namedFaces,
  noteNumber,
  noteNumberBytes,
  passed,
  passedId,
  randomSignature,
} from './fakes.ts'

const here = dirname(fileURLToPath(import.meta.url))
const standard = join(here, '../../standard')
const ARTIFACTS = { wasm: join(standard, 'registry/circuit/devnet/person.wasm'), zkey: join(standard, 'registry/circuit/devnet/person.zkey') }

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
  /** The document check's Didit. */
  ids: FakeFaceCheck
  embedder: ReturnType<typeof namedFaces>
  payments: FakePayments
  dbPath: string
  logs: string[]
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** A new face session whose check came to `decision`; returns its id. */
  session(decision: ReturnType<typeof passed>): Promise<string>
  /** The same for the document check, while it is free. */
  idSession(decision: ReturnType<typeof passed>): Promise<string>
}

async function start(options: { env?: Record<string, string>; key?: string; dbPath?: string; gift?: { directory: Directory; payer: FakePayer } } = {}): Promise<Harness> {
  const dbPath = options.dbPath ?? join(tempDir(), 'issuer.sqlite')
  const config = readConfig({
    ISSUER_NAME,
    DIDIT_API_KEY: 'not-used',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    ISSUER_KEYPAIR: options.key ?? keypairJson().json,
    DATABASE_PATH: dbPath,
    // Every request here comes from one address; the limit has its own test.
    SESSION_LIMIT_PER_HOUR: '100000',
    PORT: '0',
    ...options.env,
  })
  const faces = new FakeFaceCheck()
  const ids = new FakeFaceCheck()
  const payments = new FakePayments()
  const embedder = namedFaces()
  const logs: string[] = []
  const issuer = await startIssuer(config, { faceCheck: faces, idCheck: ids, payments, embedder, ...options.gift, log: (line) => logs.push(line) })
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(issuer.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const session = async (decision: ReturnType<typeof passed>) => {
    const { status, body } = await post('/session')
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
  return { issuer, faces, ids, embedder, payments, dbPath, logs, post, session, idSession }
}

const faceNote = (h: Harness, sessionId: string, n: bigint) => h.post('/note', { sessionId, noteNumber: n.toString() })
const idNote = (h: Harness, sessionId: string, note: unknown) => h.post('/id/note', { sessionId, note })

/** A tier 1 note for `person`, as an app gets one. */
async function tier1(h: Harness, person: string, n: bigint) {
  const sessionId = await h.session(passed(person))
  const res = await faceNote(h, sessionId, n)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { sessionId, note: res.body.note }
}

/** A price for the document check, in the test dollar, paid to an address of its own. */
const PRICED = {
  ID_TIER_PRICE: '2500000',
  ID_TIER_MINT: 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa',
  ID_TIER_PAY_TO: '3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH',
  RPC_URL: 'http://127.0.0.1:1',
}

test("GET /issuer.json: the issuer's name and its note key, mixed from its seed under issuer/notes", async () => {
  const key = keypairJson()
  const h = await start({ key: key.json })
  try {
    const res = await fetch(h.issuer.url + '/issuer.json')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const text = await res.text()
    assert.equal(canonical(parseCanonical(text)), text, 'canonical JSON')
    const noteKey = issuerKeyOf(await hkdf(key.secret, NOTE_KEY_INFO))
    assert.deepEqual(JSON.parse(text), { key: issuerHex(noteKey), name: ISSUER_NAME, v: 1 })
    assert.deepEqual(h.issuer.noteKey, noteKey)
    assert.equal((await fetch(h.issuer.url + '/issuer.json', { method: 'POST' })).status, 405)
  } finally {
    await h.issuer.close()
  }
})

test('stage 1: a passed face check gives a tier 1 note for the note number sent, and a person proves with it', async () => {
  const h = await start()
  try {
    const seed = new Uint8Array(randomBytes(32))
    const { secret, noteNumber: n } = await issuerSecret(seed, ISSUER_NAME)
    const { note: json } = await tier1(h, 'alice', n)
    assert.deepEqual(Object.keys(json).sort(), ['embedding', 'issuer', 'model', 'noteNumber', 'signature', 'tier'])
    const note = noteFromJson(json)!
    assert.equal(note.noteNumber, n)
    assert.equal(note.tier, 1n)
    assert.equal(note.model, 'test-model')
    assert.deepEqual(note.embedding, await namedFaces().embed(new TextEncoder().encode('alice')), "alice's face")
    assert.deepEqual(note.issuer, h.issuer.noteKey)
    assert.ok(noteSigned(note), "forest's check: the issuer signed it")
    assert.deepEqual(noteToJson(note), json)

    // The note does what it is for: a person proof, made with forest's own code, that the program checks.
    const profile = new Uint8Array(randomBytes(32))
    const proof = await provePerson({ secret, note, label: 'tutoring/seller', profile, artifacts: ARTIFACTS })
    assert.equal(proof.tier, 1n)
    assert.ok(await verifyPerson({ proof: proof.proof, issuer: h.issuer.noteKey, label: 'tutoring/seller', profile, stamp: proof.stamp, tier: 1n }))
    assert.deepEqual(h.logs, [], 'nothing is logged')
  } finally {
    await h.issuer.close()
  }
})

test('a face seen before is signed again for the note number it was signed for, and refused for another', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await noteNumber(), await noteNumber()]
    const first = await tier1(h, 'alice', n1)

    // The same session, sent again: the same note number gives the note again (a lost answer); another is refused.
    assert.equal((await faceNote(h, first.sessionId, n1)).status, 200)
    assert.deepEqual(await faceNote(h, first.sessionId, n2), { status: 409, body: { error: 'session_used' } })

    // A new session whose face Didit's search found in the first.
    const again = await h.session(passed('alice', { matches: [first.sessionId] }))
    assert.deepEqual(await faceNote(h, again, n2), { status: 403, body: { error: 'duplicate_face' } })
    const resigned = await faceNote(h, again, n1)
    assert.equal(resigned.status, 200, 'signed again: same note number, the face from this session')
    assert.equal(resigned.body.note.noteNumber, n1.toString())

    // A face found only in a session that gave no note is new.
    const unsent = await h.session(passed('carol'))
    const carol = await h.session(passed('carol', { matches: [unsent] }))
    assert.equal((await faceNote(h, carol, n2)).status, 200)

    // Sent late: an earlier session of a face, whose own search could not see the later one, is held
    // to the note number the later one was signed for.
    const dan1 = await h.session(passed('dan'))
    const danLater = await h.session(passed('dan', { matches: [dan1] }))
    const n3 = await noteNumber()
    assert.equal((await faceNote(h, danLater, n3)).status, 200)
    assert.deepEqual(await faceNote(h, dan1, await noteNumber()), { status: 409, body: { error: 'session_used' } })
    assert.equal((await faceNote(h, dan1, n3)).status, 200)
  } finally {
    await h.issuer.close()
  }
})

test('two requests for one session at once, with two note numbers: one note, the other refused', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed('erin'))
    const release = h.faces.hold()
    const both = [faceNote(h, sessionId, await noteNumber()), faceNote(h, sessionId, await noteNumber())]
    while (h.faces.waiting < 2) await new Promise((r) => setImmediate(r))
    release()
    const statuses = (await Promise.all(both)).map((r) => r.status).sort()
    assert.deepEqual(statuses, [200, 409])
  } finally {
    await h.issuer.close()
  }
})

test('stage 1 refusals, malformed requests, and Didit not answering', async () => {
  const h = await start()
  try {
    const n = await noteNumber()
    // A failed liveness check uses nothing up: approved later, the same session gives the note.
    const later = await h.session(passed('frank', { liveness: [{ status: 'Declined' }], status: 'Declined' }))
    assert.deepEqual(await faceNote(h, later, n), { status: 403, body: { error: 'liveness_not_passed' } })
    h.faces.set(later, passed('frank'))
    assert.equal((await faceNote(h, later, n)).status, 200)

    const refused: [ReturnType<typeof passed>, string][] = [
      [passed('g', { workflowId: ID_WORKFLOW }), 'wrong_workflow'],
      [passed('g', { liveness: [] }), 'no_liveness'],
      [passed('g', { status: 'In Review' }), 'not_approved'],
      [passed('g', { faceImage: null }), 'no_face'],
      [passed('none'), 'no_face'],
    ]
    for (const [decision, error] of refused) {
      assert.deepEqual(await faceNote(h, await h.session(decision), await noteNumber()), { status: 403, body: { error } }, error)
    }
    assert.deepEqual(await faceNote(h, '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a', n), { status: 403, body: { error: 'unknown_session' } })

    const sessionId = await h.session(passed('gina'))
    h.faces.down = true
    assert.deepEqual(await faceNote(h, sessionId, n), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.down = false
    h.faces.photoDown = true
    assert.deepEqual(await faceNote(h, sessionId, n), { status: 502, body: { error: 'face_check_unavailable' } })
    h.faces.photoDown = false

    const bad: [unknown, number, string][] = [
      ['nope', 400, 'not_json'],
      [[1], 400, 'not_an_object'],
      [{ sessionId }, 400, 'expected_exactly_sessionId_and_noteNumber'],
      [{ sessionId, noteNumber: 5 }, 400, 'expected_exactly_sessionId_and_noteNumber'],
      [{ sessionId, noteNumber: '5', more: 1 }, 400, 'expected_exactly_sessionId_and_noteNumber'],
      [{ sessionId: 'x', noteNumber: '5' }, 400, 'bad_session_id'],
      [{ sessionId, noteNumber: '05' }, 400, 'bad_note_number'],
      [{ sessionId, noteNumber: '-5' }, 400, 'bad_note_number'],
      [{ sessionId, noteNumber: (2n ** 254n).toString() }, 400, 'bad_note_number'],
      [{ sessionId, noteNumber: 'x'.repeat(5000) }, 413, 'too_large'],
    ]
    for (const [body, status, error] of bad) assert.deepEqual(await h.post('/note', body), { status, body: { error } }, error)
    assert.deepEqual(await h.post('/session', { x: 1 }), { status: 400, body: { error: 'expected_empty_body' } })
    assert.deepEqual(await h.post('/nowhere'), { status: 404, body: { error: 'not_found' } })
    assert.equal((await fetch(h.issuer.url + '/note')).status, 405)
    h.faces.down = true
    assert.deepEqual(await h.post('/session'), { status: 502, body: { error: 'face_check_unavailable' } })
  } finally {
    await h.issuer.close()
  }
})

test('stage 2: the note shown, a document check that passed and the same live face give the same note at tier 2', async () => {
  const h = await start()
  try {
    const n = await noteNumber()
    const { note } = await tier1(h, 'alice', n)
    const sessionId = await h.idSession(passedId('alice', doc('Lovelace')))
    const res = await idNote(h, sessionId, note)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const t2 = noteFromJson(res.body.note)!
    assert.ok(noteSigned(t2))
    assert.equal(t2.tier, 2n)
    assert.equal(t2.noteNumber, n)
    assert.deepEqual(t2.embedding, noteFromJson(note)!.embedding, "the tier 1 note's embedding")
    assert.equal(t2.model, 'test-model')

    // A lost tier 2 note: the same document, the same note number, signed again; the tier 2 note shown works too.
    assert.equal((await idNote(h, await h.idSession(passedId('alice', doc('Lovelace'))), note)).status, 200)
    assert.equal((await idNote(h, await h.idSession(passedId('alice', doc('Lovelace'))), res.body.note)).status, 200)
    // The same name, birth date and country, written another way, for another note number: refused.
    const other = await tier1(h, 'alice2', await noteNumber())
    const same = doc('Lovelace', { firstName: '  ADA', lastName: 'lovelace ', country: 'gbr' })
    assert.deepEqual(await idNote(h, await h.idSession(passedId('alice2', same)), other.note), { status: 403, body: { error: 'duplicate_document' } })
    // Another person: fine.
    assert.equal((await idNote(h, await h.idSession(passedId('alice2', doc('Byron'))), other.note)).status, 200)
    // Ada Lovelace with another birth date, or from another country, is someone else.
    const third = await tier1(h, 'alice3', await noteNumber())
    assert.equal((await idNote(h, await h.idSession(passedId('alice3', doc('Lovelace', { country: 'IRL' }))), third.note)).status, 200)
  } finally {
    await h.issuer.close()
  }
})

test('stage 2 refusals', async () => {
  const h = await start()
  try {
    const { note } = await tier1(h, 'alice', await noteNumber())
    const id = (person: string, over: Parameters<typeof passedId>[2] = {}, document = doc(`${person}-${randomBytes(4).toString('hex')}`)) => h.idSession(passedId(person, document, over))

    assert.deepEqual(await idNote(h, await id('bob'), note), { status: 403, body: { error: 'not_the_same_face' } }, "another person's live face")
    for (const [over, error] of [
      [{ workflowId: WORKFLOW }, 'wrong_workflow'],
      [{ documents: [] }, 'no_document'],
      [{ documents: [{ status: 'Declined' }] }, 'document_not_passed'],
      [{ faceMatches: [] }, 'no_face_match'],
      [{ faceMatches: [{ status: 'In Review' }] }, 'face_match_not_passed'],
      [{ status: 'In Review' }, 'not_approved'],
      [{ document: null }, 'no_document_data'],
      [{ document: doc('x', { birth: '01/04/1990' }) }, 'no_document_data'],
      [{ faceImage: null }, 'no_face'],
    ] as const) {
      assert.deepEqual(await idNote(h, await id('alice', over as never), note), { status: 403, body: { error } }, error)
    }

    // Notes the issuer did not sign, or signed for another model.
    const stranger = signNote(new Uint8Array(randomBytes(32)), { ...noteFromJson(note)!, tier: 1n })
    const tampered = { ...note, tier: '2' }
    const { noteNumber: n, embedding } = noteFromJson(note)!
    const otherModel = noteToJson(signNote(new Uint8Array(randomBytes(32)), { noteNumber: n, embedding, model: 'another', tier: 1n }))
    assert.deepEqual(await idNote(h, await id('alice'), noteToJson(stranger)), { status: 403, body: { error: 'not_our_note' } })
    assert.deepEqual(await idNote(h, await id('alice'), tampered), { status: 403, body: { error: 'not_our_note' } })
    assert.deepEqual(await idNote(h, await id('alice'), otherModel), { status: 403, body: { error: 'not_our_note' } })
    const key = keypairJson()
    const h2 = await start({ key: key.json })
    try {
      const own = noteToJson(signNote(await hkdf(key.secret, NOTE_KEY_INFO), { noteNumber: n, embedding, model: 'another', tier: 1n }))
      assert.deepEqual(await idNote(h2, await h2.idSession(passedId('alice')), own), { status: 403, body: { error: 'other_model' } })
    } finally {
      await h2.issuer.close()
    }

    // Malformed notes.
    const sessionId = await id('alice')
    for (const bad of [
      { ...note, extra: 1 },
      { ...note, noteNumber: '01' },
      { ...note, issuer: note.issuer.toUpperCase() },
      { ...note, embedding: 'not base64url!' },
      { ...note, signature: { r8: ['1'], s: '1' } },
      // The note as the issuer wrote it before the registry client's form.
      { ...note, signature: { R8: note.signature.r8, S: note.signature.s } },
      { ...note, model: '' },
    ]) {
      assert.deepEqual(await idNote(h, sessionId, bad), { status: 400, body: { error: 'bad_note' } })
    }
    assert.deepEqual(await h.post('/id/note', { sessionId, note: 'x' }), { status: 400, body: { error: 'expected_exactly_sessionId_and_note' } })
    assert.deepEqual(await h.post('/id/note', { sessionId }), { status: 400, body: { error: 'expected_exactly_sessionId_and_note' } })

    // A face session is not a document session, and the other way round.
    const faceSession = await h.session(passed('alice'))
    assert.deepEqual(await idNote(h, faceSession, note), { status: 403, body: { error: 'unknown_session' } })
    assert.deepEqual(await faceNote(h, await id('alice'), noteFromJson(note)!.noteNumber), { status: 403, body: { error: 'unknown_session' } })
  } finally {
    await h.issuer.close()
  }
})

test('the file keeps which session gave which note number, and each document as a fingerprint next to it: nothing else', async () => {
  const h = await start()
  try {
    const [n1, n2] = [await noteNumber(), await noteNumber()]
    const a = await tier1(h, 'alice', n1)
    const again = await h.session(passed('alice', { matches: [a.sessionId] }))
    assert.equal((await faceNote(h, again, n1)).status, 200)
    const b = await tier1(h, 'bob', n2)
    const id = await h.idSession(passedId('alice', doc('Lovelace')))
    assert.equal((await idNote(h, id, a.note)).status, 200)
    const embedding = Buffer.from(noteFromJson(a.note)!.embedding)
    await h.issuer.close()

    assertKept(h.dbPath, {
      sessions: [[a.sessionId, n1], [again, n1], [b.sessionId, n2], [id, n1]],
      fingerprints: [[1, n1]],
      never: ['Lovelace', 'lovelace', '1990-04-01', a.note.embedding, a.note.signature.s],
    })
    const file = readFileSync(h.dbPath)
    assert.equal(file.includes(embedding), false, 'no embedding')
    assert.ok(file.includes(noteNumberBytes(n1)), 'the note numbers are there')
  } finally {
    await h.issuer.close().catch(() => {})
  }
})

test('a file from when the issuer kept lists: their tables dropped at start, and their bytes gone', async () => {
  const dbPath = join(tempDir(), 'issuer.sqlite')
  const old = new DatabaseSync(dbPath)
  const stamp = Buffer.from(toBytes32(BigInt('0x' + randomBytes(31).toString('hex'))))
  old.exec(`
    CREATE TABLE used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE queue (stamp BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE list (position INTEGER PRIMARY KEY, stamp BLOB NOT NULL);
    CREATE TABLE snapshots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL);
    CREATE TABLE id_used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE id_queue (stamp BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE id_list (position INTEGER PRIMARY KEY, stamp BLOB NOT NULL);
    CREATE TABLE id_snapshots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL);
    CREATE TABLE id_payments (signature BLOB PRIMARY KEY) WITHOUT ROWID;
  `)
  old.prepare('INSERT INTO list (position, stamp) VALUES (0, ?)').run(stamp)
  old.prepare('INSERT INTO id_list (position, stamp) VALUES (0, ?)').run(stamp)
  const paid = randomSignature()
  old.prepare('INSERT INTO id_payments (signature) VALUES (?)').run(base58.decode(paid))
  old.close()
  assert.ok(readFileSync(dbPath).includes(stamp))

  const h = await start({ dbPath })
  await h.issuer.close()
  assertKept(dbPath, { sessions: [], fingerprints: [], payments: [paid], never: [] })
  assert.equal(readFileSync(dbPath).includes(stamp), false, 'no listed stamp is left in the file')
})

test('with a price, a document check opens once a payment naming its reference has landed, and each payment opens one', async () => {
  const key = keypairJson()
  const h = await start({ key: key.json, env: PRICED })
  try {
    const asked = await h.post('/id/session')
    assert.equal(asked.status, 402)
    assert.equal(asked.body.error, 'payment_required')
    const { payment } = asked.body
    assert.deepEqual(Object.keys(payment).sort(), ['amount', 'id', 'mint', 'reference', 'to'])
    assert.match(payment.id, /^[0-9a-f]{32}$/)
    assert.deepEqual([payment.to, payment.mint, payment.amount], [PRICED.ID_TIER_PAY_TO, PRICED.ID_TIER_MINT, PRICED.ID_TIER_PRICE])
    const seed = parseKeypair(key.json, 'test')
    assert.equal(payment.reference, (await seed.derive(`reference/${payment.id}`)).address, "the reference: a key mixed from the issuer's seed")
    const other = (await h.post('/id/session')).body.payment
    assert.notEqual(other.reference, payment.reference, 'one reference per payment')
    assert.equal(h.ids.created, 0, 'no session yet')
    assert.equal((await h.post('/session')).status, 201, 'the face check stays free')

    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 402, body: { error: 'not_paid' } })
    h.payments.down = true
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 502, body: { error: 'payment_check_unavailable' } })
    h.payments.down = false

    const signature = randomSignature()
    h.payments.paid.set(payment.reference, [signature])
    const opened = await h.post('/id/session', { payment: payment.id })
    assert.equal(opened.status, 201)
    assert.equal(h.ids.created, 1)
    assert.deepEqual(await h.post('/id/session', { payment: payment.id }), { status: 409, body: { error: 'payment_used' } })
    h.payments.paid.set(other.reference, [signature])
    assert.deepEqual(await h.post('/id/session', { payment: other.id }), { status: 409, body: { error: 'payment_used' } }, 'one transaction pays for one check')
    h.payments.paid.set(payment.reference, [randomSignature(), signature])
    assert.equal((await h.post('/id/session', { payment: payment.id })).status, 201, 'a second payment naming the same reference opens a second')

    const third = (await h.post('/id/session')).body.payment
    h.payments.paid.set(third.reference, [randomSignature()])
    h.ids.down = true
    assert.deepEqual(await h.post('/id/session', { payment: third.id }), { status: 502, body: { error: 'face_check_unavailable' } })
    h.ids.down = false
    assert.equal((await h.post('/id/session', { payment: third.id })).status, 201, 'Didit down: the payment is still good')

    // The session it opened is a document session like any other.
    const { note } = await tier1(h, 'alice', await noteNumber())
    h.ids.set(opened.body.sessionId, passedId('alice'))
    assert.equal((await idNote(h, opened.body.sessionId, note)).status, 200)

    for (const [body, status, error] of [
      [{ payment: 'ABC' }, 400, 'bad_payment'],
      [{ payment: payment.id, more: 'x' }, 400, 'expected_exactly_payment'],
      [{ paid: payment.id }, 400, 'expected_exactly_payment'],
    ] as [unknown, number, string][]) {
      assert.deepEqual(await h.post('/id/session', body), { status, body: { error } })
    }
  } finally {
    await h.issuer.close()
  }
})

test('the configuration names what is missing', () => {
  assert.throws(() => readConfig({}), /ISSUER_NAME, DIDIT_API_KEY, DIDIT_WORKFLOW_ID, DIDIT_ID_WORKFLOW_ID, ISSUER_KEYPAIR or ISSUER_KEYPAIR_PATH/)
  const base = { ISSUER_NAME, DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', DIDIT_ID_WORKFLOW_ID: 'i', ISSUER_KEYPAIR_PATH: 'p' }
  const config = readConfig(base)
  assert.equal(config.issuerName, ISSUER_NAME)
  assert.equal(config.diditBaseUrl, 'https://verification.didit.me')
  assert.equal(config.faceModel, 'sface')
  assert.equal(config.sessionLimitPerHour, 5)
  assert.equal(config.clientAddressHeader, undefined)
  assert.equal(readConfig({ ...base, CLIENT_ADDRESS_HEADER: 'X-Real-IP' }).clientAddressHeader, 'x-real-ip')
  assert.equal(config.idTierPrice, 0n, 'the document check is free unless a price is set')

  // The stand-in embedding is for a stand-in Didit on this machine, and nowhere else.
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in' }), /FACE_MODEL=stand-in is for a stand-in Didit on this machine only/)
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'https://didit.example' }), /stand-in/)
  assert.equal(readConfig({ ...base, FACE_MODEL: 'stand-in', DIDIT_BASE_URL: 'http://127.0.0.1:8090' }).faceModel, 'stand-in')
  assert.throws(() => readConfig({ ...base, FACE_MODEL: 'other' }), /FACE_MODEL is sface or stand-in/)

  assert.throws(() => readConfig({ ...base, ID_TIER_PRICE: '2500000' }), /missing environment variables: ID_TIER_MINT, ID_TIER_PAY_TO, RPC_URL/)
  for (const price of ['2.5', '-1', '01', 'free']) assert.throws(() => readConfig({ ...base, ID_TIER_PRICE: price }), /ID_TIER_PRICE must be a whole number/)
  assert.throws(() => readConfig({ ...base, ...PRICED, ID_TIER_PAY_TO: 'not-an-address' }), /ID_TIER_PAY_TO is not an address/)
  assert.equal(readConfig({ ...base, ...PRICED }).idTierPrice, 2_500_000n)

  // The welcome gift: none unless a service is named; three registrations and 500 cents unless set.
  assert.deepEqual(config.gift, {})
  const gifted = { ...base, REGISTRY_PAYER_URL: 'https://registry-payer.example', HOST_URL: 'https://host.example', RPC_URL: 'http://127.0.0.1:1' }
  assert.deepEqual(readConfig(gifted).gift, { registryPayer: { origin: 'https://registry-payer.example', credits: 3 }, host: { origin: 'https://host.example', credits: 500 } })
  assert.deepEqual(readConfig({ ...gifted, REGISTRY_CREDITS: '0', HOST_CREDITS: '20' }).gift, { host: { origin: 'https://host.example', credits: 20 } }, 'none of a service at 0')
  assert.throws(() => readConfig({ ...base, HOST_URL: 'https://host.example' }), /missing environment variables: RPC_URL/, 'paying needs an RPC')
  assert.throws(() => readConfig({ ...gifted, HOST_URL: 'https://host.example/' }), /HOST_URL is an origin/)
  assert.throws(() => readConfig({ ...gifted, HOST_CREDITS: '-1' }), /HOST_CREDITS/)
})

/** Two services selling credits, as their directories say: a registry payer at 0.5 a registration and a host at a cent. */
async function giftServices() {
  const pkcs8 = () => new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))
  const mint = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'
  const directories = new Map<string, unknown>([
    ['https://registry-payer.example', await directoryOf('https://registry-payer.example', 'one registration', { address: '7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA', mint, price: '0.5' }, pkcs8())],
    ['https://host.example', await directoryOf('https://host.example', 'one cent of writes', { address: '2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9', mint, price: '0.01' }, pkcs8())],
  ])
  let down = false
  const directory: Directory = async (origin) => {
    if (down || !directories.has(origin)) throw new Error('not answering')
    return directories.get(origin)
  }
  const service = (origin: string) => serviceOf(origin, directories.get(origin))
  return { directory, service, mint, setDown: (value: boolean) => (down = value) }
}

test('the welcome gift: at a first note, the app’s buys paid in one transaction, once a note number, and only as their links say', async () => {
  const services = await giftServices()
  const payer = new FakePayer()
  const h = await start({
    env: { REGISTRY_PAYER_URL: 'https://registry-payer.example', HOST_URL: 'https://host.example', HOST_CREDITS: '5', RPC_URL: 'http://127.0.0.1:1' },
    gift: { directory: services.directory, payer },
  })
  try {
    // issuer.json says what the gift holds, so the app knows what to buy.
    const about = await (await fetch(h.issuer.url + '/issuer.json')).json()
    assert.deepEqual(about.gift, { host: { credits: 5, origin: 'https://host.example' }, registryPayer: { credits: 3, origin: 'https://registry-payer.example' } })
    const registry = services.service('https://registry-payer.example')
    const host = services.service('https://host.example')
    const buys = async (r = 3, w = 5) => ({ registry: await buy(registry, r), host: await buy(host, w) })
    const links = (b: Awaited<ReturnType<typeof buys>>) => ({ registryPayer: b.registry.payLink, host: b.host.payLink })
    const note = (sessionId: string, n: bigint, gift: unknown) => h.post('/note', { sessionId, noteNumber: n.toString(), gift })

    const n = await noteNumber()
    const sessionId = await h.session(passed('alice'))
    const mine = await buys()
    const first = await note(sessionId, n, links(mine))
    assert.equal(first.status, 200)
    assert.ok(noteSigned(noteFromJson(first.body.note)!))
    assert.match(first.body.gift.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
    assert.deepEqual(payer.paid, [[
      { address: host.address, mint: services.mint, amount: '0.05', reference: mine.host.reference },
      { address: registry.address, mint: services.mint, amount: '1.5', reference: mine.registry.reference },
    ]], 'both buys in one transaction, each naming its reference, at the price its directory says')

    // Once a note number: the same session again gives the note, and not the gift.
    const again = await note(sessionId, n, links(await buys()))
    assert.deepEqual([again.status, again.body.gift], [200, { error: 'given' }])
    assert.equal(again.body.note.noteNumber, first.body.note.noteNumber)
    assert.equal(payer.paid.length, 1)

    // A link that is not the one the issuer would write for that service, count and reference.
    const m = await noteNumber()
    const bob = await h.session(passed('bob'))
    const b = await buys()
    const refused = async (gift: unknown) => (await note(bob, m, gift)).body.gift
    assert.deepEqual(await refused({ registryPayer: b.registry.payLink }), { error: 'bad_gift' }, 'one service missing')
    assert.deepEqual(await refused({ ...links(b), other: b.host.payLink }), { error: 'bad_gift' }, 'one service too many')
    assert.deepEqual(await refused({ ...links(b), host: b.host.payLink.replace('amount=0.05', 'amount=0.5') }), { error: 'bad_gift' }, 'another amount')
    assert.deepEqual(await refused({ ...links(b), host: b.registry.payLink }), { error: 'bad_gift' }, 'another service’s link')
    assert.deepEqual(await refused(links(await buys(4))), { error: 'bad_gift' }, 'more credits than the gift')
    assert.deepEqual(await refused({ ...links(b), host: b.host.payLink.replace(/reference=[^&]+/, 'reference=nope') }), { error: 'bad_gift' })
    services.setDown(true)
    assert.deepEqual(await refused(links(b)), { error: 'gift_unavailable' }, 'a directory not answering')
    services.setDown(false)
    payer.fail = true
    assert.deepEqual(await refused(links(b)), { error: 'gift_unavailable' }, 'not paid')
    payer.fail = false
    assert.equal(payer.paid.length, 1, 'nothing refused was paid')
    // Not paid, not given: the same note asked for again pays it.
    assert.match((await refused(links(b))).signature, /^[1-9A-HJ-NP-Za-km-z]+$/)
    assert.equal(payer.paid.length, 2)

    // The note is never held back by the gift; a gift that is not an object is refused before anything.
    assert.equal((await note(bob, m, 'links')).status, 400)
    assert.equal((await h.post('/note', { sessionId: bob, noteNumber: m.toString() })).body.gift, undefined, 'no gift asked, none answered')
    await h.issuer.close()
    assertKept(h.dbPath, { sessions: [[sessionId, n], [bob, m]], fingerprints: [], gifts: [n, m], never: [mine.registry.reference, mine.host.reference] })
  } finally {
    await h.issuer.close().catch(() => {})
  }
})

test('with no gift, a note asked for with one is refused as before', async () => {
  const h = await start()
  try {
    const sessionId = await h.session(passed('alice'))
    const res = await h.post('/note', { sessionId, noteNumber: (await noteNumber()).toString(), gift: {} })
    assert.deepEqual([res.status, res.body], [400, { error: 'expected_exactly_sessionId_and_noteNumber' }])
    assert.equal((await (await fetch(h.issuer.url + '/issuer.json')).json()).gift, undefined)
  } finally {
    await h.issuer.close()
  }
})

test("the document check's price is never paid to the issuer's own key", async () => {
  const key = keypairJson()
  const own = parseKeypair(key.json, 'test').address
  await assert.rejects(start({ key: key.json, env: { ...PRICED, ID_TIER_PAY_TO: own } }), /ID_TIER_PAY_TO is the issuer's own key/)
})

test('opening sessions is limited per address, and a refusal says only "try later"', async () => {
  const h = await start({ env: { SESSION_LIMIT_PER_HOUR: '3', CLIENT_ADDRESS_HEADER: 'x-real-ip' } })
  try {
    const from = (address: string) => h.post('/session', {}, { 'x-real-ip': address })
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.7')).status, 201)
    assert.deepEqual(await from('203.0.113.7'), { status: 429, body: { error: 'try_later' } })
    assert.equal(h.faces.created, 3, 'a refused request never reaches Didit')
    assert.equal((await from('203.0.113.8')).status, 201, 'another address has its own share')
    for (const a of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b', '2001:0db8:0001:0002:0:0:0:c']) assert.equal((await from(a)).status, 201)
    assert.equal((await from('2001:db8:1:2:9::d')).status, 429, 'an IPv6 address counts with the rest of its /64')
    assert.equal((await from('2001:db8:1:3::a')).status, 201, 'the next /64 is someone else')
    assert.equal((await h.post('/session', { x: 1 }, { 'x-real-ip': '203.0.113.9' })).status, 400)
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.9')).status, 201, 'a malformed request is not counted')

    // Notes are not limited, and the address is never written: not in the log, not in the file.
    const sessionId = (await from('203.0.113.10')).body.sessionId
    h.faces.set(sessionId, passed('alice'))
    assert.equal((await h.post('/note', { sessionId, noteNumber: (await noteNumber()).toString() }, { 'x-real-ip': '203.0.113.7' })).status, 200)
    await h.issuer.close()
    assert.deepEqual(h.logs, [])
    const file = readFileSync(h.dbPath)
    for (const a of ['203.0.113.7', '203.0.113.8', '2001:db8']) assert.equal(file.includes(Buffer.from(a)), false)
  } finally {
    await h.issuer.close().catch(() => {})
  }

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

test('the seed from ISSUER_KEYPAIR: read from the variable itself, which leaves the environment', async () => {
  const { json: contents, publicKey } = keypairJson()
  const numbers = JSON.parse(contents) as number[]
  const env: Record<string, string | undefined> = { ISSUER_NAME, DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', DIDIT_ID_WORKFLOW_ID: 'i', ISSUER_KEYPAIR: contents }
  const config = readConfig(env)
  assert.equal(config.issuerKeypair, contents)
  assert.equal(config.issuerKeypairPath, undefined)
  assert.equal(env.ISSUER_KEYPAIR, undefined, 'taken out of the environment once read')
  assert.throws(() => readConfig({ ...env, ISSUER_KEYPAIR: contents, ISSUER_KEYPAIR_PATH: '/k.json' }), /not both/)
  assert.deepEqual(parseKeypair(contents, 'ISSUER_KEYPAIR').publicKey, publicKey)

  // A value that is no keypair stops the issuer, with a message that quotes none of it.
  const broken = [contents.slice(0, 40), JSON.stringify(numbers.slice(0, 32)), JSON.stringify([...numbers.slice(0, 32), ...JSON.parse(keypairJson().json).slice(32)])]
  for (const text of broken) {
    await assert.rejects(
      () => start({ key: text }),
      (error: Error) => /^ISSUER_KEYPAIR is not a Solana keypair/.test(error.message) && !error.message.includes(text.slice(1, 12)),
    )
  }
})

test('the devnet stand-in: deploy/fake-didit.ts and the stand-in embedding, both stages, for two people', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const fake = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '../deploy/fake-didit.ts')], {
    env: { ...process.env, FAKE_DIDIT_PORT: String(port), FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve) => fake.stdout!.once('data', () => resolve()))
  const config = readConfig({
    ISSUER_NAME,
    DIDIT_API_KEY: 'fake-didit',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    DIDIT_BASE_URL: `http://127.0.0.1:${port}`,
    FACE_MODEL: 'stand-in',
    ISSUER_KEYPAIR: keypairJson().json,
    DATABASE_PATH: join(tempDir(), 'issuer.sqlite'),
    PORT: '0',
  })
  const issuer = await startIssuer(config, { log: () => {} })
  try {
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(issuer.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    for (let person = 0; person < 2; person++) {
      const n = await noteNumber()
      const face = await post('/session')
      const t1 = await post('/note', { sessionId: face.body.sessionId, noteNumber: n.toString() })
      assert.equal(t1.status, 200, JSON.stringify(t1.body))
      assert.equal(t1.body.note.model, 'stand-in')
      assert.ok(noteSigned(noteFromJson(t1.body.note)!))
      const id = await post('/id/session')
      const t2 = await post('/id/note', { sessionId: id.body.sessionId, note: t1.body.note })
      assert.equal(t2.status, 200, JSON.stringify(t2.body))
      assert.equal(t2.body.note.tier, '2')
    }
  } finally {
    await issuer.close()
    fake.kill()
  }
})
