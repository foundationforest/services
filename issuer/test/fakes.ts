// A stand-in for Didit, a fresh keeper key, and the check that the file keeps no link.

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { fromBytes32, toBytes32 } from '../../forest/registry/client/src/field.ts'
import type { Decision, FaceCheck } from '../src/didit.ts'
import { sessionHash } from '../src/store.ts'

export const WORKFLOW = '7f9f3c52-1b1e-4c4b-9d0f-2a6e4b1c0d11'

/** What a face check that passed looks like: one liveness step, approved, no risk codes. */
export const passed = (over: Partial<Decision> = {}): Decision => ({
  workflowId: WORKFLOW,
  status: 'Approved',
  liveness: [{ status: 'Approved' }],
  risks: [],
  ...over,
})

/** A stamp-shaped number: 31 random bytes, so always below the field order. */
export const randomStamp = () => BigInt('0x' + randomBytes(31).toString('hex')) + 1n

/**
 * Didit, as far as the issuer sees it. A test says what each session came to with `set`. With
 * `hold`, decisions wait until the test lets them go, so two requests can both be waiting at once.
 */
export class FakeFaceCheck implements FaceCheck {
  readonly sessions = new Map<string, Decision>()
  down = false
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
}

/** A fresh Ed25519 key as `solana-keygen` writes one: 64 numbers, the secret then the public key. */
export function keypairJson(): { json: string; publicKey: Uint8Array } {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const secret = Buffer.from(jwk.d!, 'base64url')
  const publicKey = Buffer.from(jwk.x!, 'base64url')
  return { json: JSON.stringify([...secret, ...publicKey]), publicKey: new Uint8Array(publicKey) }
}

/** Every file SQLite may have written next to the database. */
const sideFiles = (path: string) => [`${path}-journal`, `${path}-wal`, `${path}-shm`]

/** The byte forms a stamp could be stored in. */
function forms(stamp: bigint): Buffer[] {
  return [Buffer.from(toBytes32(stamp)), Buffer.from(stamp.toString(10)), Buffer.from(stamp.toString(16))]
}

/** Sanity for the check below: the file does hold these stamps while they wait. */
export function assertFileHolds(path: string, stamps: bigint[]): void {
  const file = readFileSync(path)
  for (const s of stamps) assert.ok(file.includes(Buffer.from(toBytes32(s))), 'a queued stamp is in the file')
}

/**
 * After a batch: the file holds each listed stamp exactly once, as its list row in list order, and
 * in no other form; no session id in the clear; and only the four tables, the queue empty and the
 * used sessions exactly the hashes of these sessions. No journal is left beside it.
 */
export function assertNoLink(path: string, sessionIds: string[], stamps: bigint[]): void {
  for (const side of sideFiles(path)) assert.equal(existsSync(side), false, `no ${side} is left`)
  const file = readFileSync(path)
  for (const s of stamps) {
    const [bytes, ...others] = forms(s)
    assert.equal(file.indexOf(bytes), file.lastIndexOf(bytes), 'a listed stamp is in the file once: no stale copy')
    assert.ok(file.includes(bytes), 'as its list row')
    for (const form of others) assert.equal(file.includes(form), false, 'and in no other form')
  }
  for (const id of sessionIds) assert.equal(file.includes(Buffer.from(id)), false, 'no session id is in the clear')

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
    assert.deepEqual(
      schema.map((t) => `${t.type} ${t.name}`),
      ['table list', 'table queue', 'table snapshots', 'table used_sessions'],
      'four tables, and no index or other table beside them',
    )
    assert.deepEqual(
      schema.map((t) => t.sql),
      [
        'CREATE TABLE list (position INTEGER PRIMARY KEY, stamp BLOB NOT NULL)',
        'CREATE TABLE queue (stamp BLOB PRIMARY KEY) WITHOUT ROWID',
        'CREATE TABLE snapshots (size INTEGER PRIMARY KEY, root BLOB NOT NULL, time INTEGER NOT NULL)',
        'CREATE TABLE used_sessions (hash BLOB PRIMARY KEY) WITHOUT ROWID',
      ],
    )
    assert.equal(db.prepare('SELECT count(*) AS n FROM queue').get()!.n, 0, 'the queue is empty')
    const listed = db
      .prepare('SELECT stamp FROM list ORDER BY position')
      .all()
      .map((row) => fromBytes32(row.stamp as Uint8Array))
    assert.deepEqual([...listed].sort(), [...stamps].sort(), 'the list holds these stamps, each once')
    const kept = db
      .prepare('SELECT hash FROM used_sessions')
      .all()
      .map((row) => Buffer.from(row.hash as Uint8Array).toString('hex'))
      .sort()
    const expected = sessionIds.map((id) => Buffer.from(sessionHash(id)).toString('hex')).sort()
    assert.deepEqual(kept, expected, 'the used sessions are kept, hashed, and nothing else is')
  } finally {
    db.close()
  }
}
