// A run's record (record.ts): a passed run's and a failed run's shapes, what is refused, the guard
// against a secret in it, and every record committed in runs/.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Keypair } from '@solana/web3.js'

import { type RunRecord, STEPS, checkRecord, holdsNone } from '../record.ts'

const address = () => Keypair.generate().publicKey.toBase58()
const signature = () => Keypair.generate().secretKey.reduce((s, b) => s + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58], '').padEnd(87, '1')
const hex = () => 'ab'.repeat(32)
const paid = () => ({ signature: signature(), charge: '3698080', bytes: 700 })

/** A passed run's record, as e2e.ts writes one. */
function passed(): RunRecord {
  const person = () => ({ label: 'tutoring/tutor', profile: address(), pay: address() })
  return {
    started: '2026-10-22T10:00:00.000Z',
    ended: '2026-10-22T10:04:00.000Z',
    passed: true,
    commits: { services: 'a'.repeat(40), standard: 'b'.repeat(40), markets: 'c'.repeat(40) },
    services: { host: 'loopback', issuer: 'loopback', feePayer: 'loopback', index: 'loopback', mcp: 'loopback' },
    chain: { rpc: 'https://rpc.example', escrow: address(), testDollar: address(), market: 'tutoring' },
    loop: { issuer: { name: 'issuer.e2e-loop.invalid', face: address(), id: address() }, index: address() },
    steps: {
      keys: { tutor: person(), student: person(), coach: person() },
      funding: { accounts: signature(), money: signature(), wallets: { tutor: address(), student: address() } },
      notes: { tutor: { issuer: address(), model: 'stand-in' }, student: { issuer: address(), model: 'stand-in' } },
      credits: {
        tutor: { signature: signature(), amount: '0.1', credits: 10, reference: address() },
        student: { signature: signature(), amount: '0.1', credits: 10, reference: address() },
      },
      profiles: {
        tutor: { unpaid: 'refused', spent: 6, stamp: hex(), writeKey: address(), readKey: address() },
        student: { unpaid: 'refused', spent: 10, stamp: hex(), writeKey: address(), readKey: address() },
      },
      mcp: { offer: 'x/offer/maths', offerBy: address(), message: { id: hex(), from: address() }, opened: true },
      deal: { payment: paid(), escrow: { address: address(), open: paid(), pay: paid(), outcome: 'pay', sponsor: address() } },
      reviews: { student: { address: 'x/review/a', evidence: address() }, tutor: { address: 'y/review/b', evidence: signature() } },
      index: { tutor: { rating: 10, withPayment: 1 }, student: { rating: 9, withPayment: 1 }, deal: { outcome: 'pay', reviews: 1 } },
      reputation: { profile: address(), root: hex(), time: 1_790_000_000_000, score: 100, result: 'shown' },
      balances: { tutor: 5.9, student: 9.92, coach: 3.97 },
    },
  }
}

test('a passed run has every step, each with its fields', () => {
  checkRecord(passed())
  checkRecord({ ...passed(), services: { ...passed().services, host: 'https://host.forest.foundation', mcp: 'https://mcp.forest.foundation' }, chain: { ...passed().chain, rpc: 'RPC_URL' } })
})

test('a failed run has its error and the steps it finished, in order', () => {
  const { steps } = passed()
  checkRecord({ ...passed(), passed: false, error: 'Error: timed out waiting for the index', steps: { keys: steps.keys, funding: steps.funding, notes: steps.notes } })
  checkRecord({ ...passed(), passed: false, error: 'Error: no RPC', steps: {} })
})

test('refused: a record that is not one', () => {
  const p = passed()
  const { reputation, ...missing } = p.steps
  const bad: [string, unknown][] = [
    ['a passed run missing a step', { ...p, steps: missing }],
    ['a passed run with an error', { ...p, error: 'x' }],
    ['a failed run with no error', { ...p, passed: false }],
    ['steps out of order', { ...p, passed: false, error: 'x', steps: { funding: p.steps.funding, keys: p.steps.keys } }],
    ['a step that is not one', { ...p, passed: false, error: 'x', steps: { keys: p.steps.keys, more: {} } }],
    ['a field of the wrong kind', { ...p, steps: { ...p.steps, deal: { ...p.steps.deal, payment: { ...paid(), charge: 3.7 } } } }],
    ['a rating that is not the run’s', { ...p, steps: { ...p.steps, index: { ...p.steps.index, tutor: { rating: 9, withPayment: 1 } } } }],
    ['an RPC with a key in its URL', { ...p, chain: { ...p.chain, rpc: 'https://rpc.example/?api-key=x' } }],
    ['a service that is neither loopback nor an origin', { ...p, services: { ...p.services, host: 'https://host.example/v1' } }],
    ['not a commit', { ...p, commits: { ...p.commits, standard: 'main' } }],
    ['an end before its start', { ...p, ended: '2026-10-22T09:00:00.000Z' }],
  ]
  for (const [why, r] of bad) assert.throws(() => checkRecord(r), /not a run's record/, why)
  assert.equal(STEPS.length, Object.keys(p.steps).length)
})

test('no secret in the text', () => {
  const text = JSON.stringify(passed())
  holdsNone(text, ['the phrase itself', 'https://rpc.example/?api-key=x', ''])
  assert.throws(() => holdsNone(`${text} the phrase itself`, ['the phrase itself']), /secret/)
})

test('every record in runs/ is a run’s record', () => {
  const dir = join(import.meta.dirname, '../runs')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    // No run yet.
  }
  for (const f of files) checkRecord(JSON.parse(readFileSync(join(dir, f), 'utf8')))
})
