// Stand-ins for Didit and for the chain, and the check that the file keeps no link.

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { toBytes32 } from '../../registry/client/src/field.ts'
import type { Decision, FaceCheck } from '../src/didit.ts'
import type { IssuerList } from '../src/list.ts'
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

/** A commitment-shaped number: 31 random bytes, so always below the field order. */
export const randomCommitment = () => BigInt('0x' + randomBytes(31).toString('hex')) + 1n

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

/** The list, in memory: its members in the order they went in. */
export class FakeList implements IssuerList {
  readonly members: bigint[] = []
  /** Inserts fail once the list holds this many. */
  failAt = Infinity

  async refresh() {}

  has(commitment: bigint) {
    return this.members.includes(commitment)
  }

  async insert(commitment: bigint) {
    if (this.members.length >= this.failAt) throw new Error('the chain is down')
    this.members.push(commitment)
  }
}

/** Every file SQLite may have written next to the database. */
const sideFiles = (path: string) => [`${path}-journal`, `${path}-wal`, `${path}-shm`]

/** The byte forms a commitment could be stored in. */
function forms(commitment: bigint): Buffer[] {
  return [
    Buffer.from(toBytes32(commitment)),
    Buffer.from(commitment.toString(10)),
    Buffer.from(commitment.toString(16)),
  ]
}

/** Sanity for the check below: the file does hold these commitments while they wait. */
export function assertFileHolds(path: string, commitments: bigint[]): void {
  const file = readFileSync(path)
  for (const c of commitments) assert.ok(file.includes(Buffer.from(toBytes32(c))), 'a queued commitment is in the file')
}

/**
 * After a batch: the file holds no commitment in any form, no session id in the clear, and only the
 * two tables, the queue empty and the used sessions exactly the hashes of these sessions. No journal
 * is left beside it.
 */
export function assertNoLink(path: string, sessionIds: string[], commitments: bigint[]): void {
  for (const side of sideFiles(path)) assert.equal(existsSync(side), false, `no ${side} is left`)
  const file = readFileSync(path)
  for (const c of commitments) {
    for (const form of forms(c)) assert.equal(file.includes(form), false, 'no commitment is left in the file')
  }
  for (const id of sessionIds) assert.equal(file.includes(Buffer.from(id)), false, 'no session id is in the clear')

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()
    assert.deepEqual(
      tables.map((t) => t.name),
      ['queue', 'used_sessions'],
      'two tables, and no index or other table beside them',
    )
    assert.match(String(tables[0].sql), /^CREATE TABLE queue \(commitment BLOB PRIMARY KEY\) WITHOUT ROWID$/)
    assert.match(String(tables[1].sql), /^CREATE TABLE used_sessions \(hash BLOB PRIMARY KEY\) WITHOUT ROWID$/)
    assert.equal(db.prepare('SELECT count(*) AS n FROM queue').get()!.n, 0, 'the queue is empty')
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
