// A stand-in for Didit, an embedder that knows people by name, the RPC payments are found through, a
// fresh issuer seed, a person's note number, and the check that the file keeps nothing it shouldn't.

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { issuerSecret } from '../../standard/keys/src/issuer.ts'
import { base58 } from '../../standard/records/src/bytes.ts'
import { fromBytes32, toBytes32 } from '../../standard/registry/client/src/field.ts'
import type { Decision, Document, FaceCheck } from '../src/didit.ts'
import { EMBEDDING_BYTES, FaceError, type Embedder } from '../src/face.ts'
import type { Payments } from '../src/payment.ts'
import { sessionHash } from '../src/store.ts'

export const WORKFLOW = '7f9f3c52-1b1e-4c4b-9d0f-2a6e4b1c0d11'
export const ID_WORKFLOW = '0b6e2f1a-3c4d-4e5f-8a9b-1c2d3e4f5a6b'
export const ISSUER_NAME = 'issuer.test.forest.example'

/** The selfie of `person`, as the stand-in Didit names it: the test embedder reads the name back. */
export const selfie = (person: string) => `https://didit.example/photo/${person}`

/** What a face check that passed looks like: one liveness step, approved, the person's selfie, no face seen before. */
export const passed = (person: string, over: Partial<Decision> = {}): Decision => ({
  workflowId: WORKFLOW,
  status: 'Approved',
  liveness: [{ status: 'Approved' }],
  documents: [],
  faceMatches: [],
  faceImage: selfie(person),
  matches: [],
  document: null,
  ...over,
})

/** A document as Didit reads one. */
export const doc = (lastName: string, over: Partial<Document> = {}): Document => ({
  firstName: 'Ada',
  lastName,
  fullName: `Ada ${lastName}`,
  birth: '1990-04-01',
  country: 'GBR',
  ...over,
})

/** What a document check that passed looks like: the document, the liveness step and the face match, each approved. */
export const passedId = (person: string, document: Document = doc(person), over: Partial<Decision> = {}): Decision =>
  passed(person, { workflowId: ID_WORKFLOW, documents: [{ status: 'Approved' }], faceMatches: [{ status: 'Approved' }], document, ...over })

/**
 * Faces by name: each person's embedding is a fixed random direction made from their name, so one
 * person matches themselves exactly and two people hardly at all. The photo `none` has no face.
 */
export function namedFaces(): Embedder & { embedded: number } {
  const faces = {
    model: 'test-model',
    embedded: 0,
    async embed(photo: Uint8Array) {
      const name = new TextDecoder().decode(photo)
      if (name === 'none') throw new FaceError('no_face')
      faces.embedded++
      const values = Float32Array.from({ length: EMBEDDING_BYTES / 4 }, (_, i) => createHash('sha256').update(`${name}/${i}`).digest().readInt32LE(0) / 2 ** 31)
      const out = new Uint8Array(EMBEDDING_BYTES)
      const view = new DataView(out.buffer)
      const length = Math.hypot(...values)
      values.forEach((v, i) => view.setFloat32(i * 4, v / length, true))
      return out
    },
  }
  return faces
}

/** The RPC, as far as the issuer sees it: the paying transactions each reference has, set by the test. */
export class FakePayments implements Payments {
  readonly paid = new Map<string, string[]>()
  down = false
  /** How many times it was asked. */
  asked = 0

  async landed(reference: string) {
    this.asked++
    if (this.down) throw new Error('down')
    return this.paid.get(reference) ?? []
  }
}

/** A transaction signature's shape: 64 random bytes in base58. */
export const randomSignature = () => base58.encode(randomBytes(64))

/** A person's note number for the test issuer, as their app mixes it: from a fresh seed and the issuer's name. */
export const noteNumber = async () => (await issuerSecret(new Uint8Array(randomBytes(32)), ISSUER_NAME)).noteNumber

/**
 * Didit, as far as the issuer sees it. A test says what each session came to with `set`. With
 * `hold`, decisions wait until the test lets them go, so two requests can both be waiting at once.
 * A photo is its selfie address's last part, the person's name.
 */
export class FakeFaceCheck implements FaceCheck {
  readonly sessions = new Map<string, Decision>()
  down = false
  photoDown = false
  waiting = 0
  /** How many sessions Didit was asked to open. */
  created = 0
  #gate: Promise<void> | undefined

  async createSession() {
    if (this.down) throw new Error('down')
    this.created++
    const sessionId = randomUUID()
    return { sessionId, url: `https://verify.example/session/${sessionId}` }
  }

  set(sessionId: string, decision: Decision) {
    this.sessions.set(sessionId, decision)
  }

  hold(): () => void {
    let release!: () => void
    this.#gate = new Promise((r) => (release = r))
    return () => {
      this.#gate = undefined
      release()
    }
  }

  async decision(sessionId: string) {
    this.waiting++
    try {
      await (this.#gate ?? new Promise((r) => setImmediate(r)))
      if (this.down) throw new Error('down')
      return this.sessions.get(sessionId) ?? null
    } finally {
      this.waiting--
    }
  }

  async photo(url: string) {
    if (this.photoDown) throw new Error('down')
    return new TextEncoder().encode(url.split('/').at(-1))
  }
}

/** A fresh Ed25519 key as `solana-keygen` writes one: 64 numbers, the secret then the public key. */
export function keypairJson(): { json: string; secret: Uint8Array; publicKey: Uint8Array } {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const secret = Buffer.from(jwk.d!, 'base64url')
  const publicKey = Buffer.from(jwk.x!, 'base64url')
  return { json: JSON.stringify([...secret, ...publicKey]), secret: new Uint8Array(secret), publicKey: new Uint8Array(publicKey) }
}

/** Every file SQLite may have written next to the database. */
const sideFiles = (path: string) => [`${path}-journal`, `${path}-wal`, `${path}-shm`]

const TABLES = [
  'CREATE TABLE fingerprints (fingerprint BLOB PRIMARY KEY, note_number BLOB NOT NULL) WITHOUT ROWID',
  'CREATE TABLE id_payments (signature BLOB PRIMARY KEY) WITHOUT ROWID',
  'CREATE TABLE sessions (hash BLOB PRIMARY KEY, note_number BLOB NOT NULL) WITHOUT ROWID',
]

/** What the file should hold: the sessions that gave notes, with their note numbers; how many documents; the payments used. */
export type Expected = { sessions: [string, bigint][]; fingerprints: [number, bigint][]; payments?: string[]; never: string[] }

/**
 * The file holds three tables and nothing else: each session that gave a note as the hash of its id,
 * next to its note number; each document's fingerprint next to its note number; the payments used.
 * None of `never` (names, birth dates, embeddings, session ids) is anywhere in its bytes, and no
 * journal is left beside it.
 */
export function assertKept(path: string, expected: Expected): void {
  for (const side of sideFiles(path)) assert.equal(existsSync(side), false, `no ${side} is left`)
  const file = readFileSync(path)
  for (const text of expected.never) assert.equal(file.includes(Buffer.from(text)), false, `${text.slice(0, 24)} is not in the file`)
  for (const [sessionId] of expected.sessions) assert.equal(file.includes(Buffer.from(sessionId)), false, 'no session id is in the clear')

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    assert.deepEqual(schema.map((t) => t.sql), TABLES, 'three tables, and no index or other table beside them')
    const sessions = db
      .prepare('SELECT hash, note_number FROM sessions')
      .all()
      .map((r) => `${Buffer.from(r.hash as Uint8Array).toString('hex')} ${fromBytes32(r.note_number as Uint8Array)}`)
      .sort()
    const want = expected.sessions.map(([id, n]) => `${Buffer.from(sessionHash(id)).toString('hex')} ${n}`).sort()
    assert.deepEqual(sessions, want, 'each session that gave a note, hashed, next to its note number')
    const prints = db
      .prepare('SELECT note_number FROM fingerprints')
      .all()
      .map((r) => fromBytes32(r.note_number as Uint8Array))
      .sort()
    assert.deepEqual(prints, expected.fingerprints.flatMap(([count, n]) => Array(count).fill(n)).sort(), 'each document, as a fingerprint next to its note number')
    const payments = db
      .prepare('SELECT signature FROM id_payments')
      .all()
      .map((row) => base58.encode(row.signature as Uint8Array))
      .sort()
    assert.deepEqual(payments, [...(expected.payments ?? [])].sort(), 'the payments used, and nothing beside them')
  } finally {
    db.close()
  }
}

/** A note number as the file stores it, for tests that look at raw bytes. */
export const noteNumberBytes = (n: bigint) => Buffer.from(toBytes32(n))
