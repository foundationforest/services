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
  const person = () => ({ label: 'tutoring/tutor', profile: address(), pay: { solana: address(), evm: '0x1900f9C5c30615F3a5f6a0887D2DeF5bA4C7b437' } })
  const evidence = (id: string) => `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${id}`
  const switches = ['read-inbox', 'read', 'write', 'message']
  const login = () => ({ profiles: ['tutoring/tutor'], can: switches, key: address(), note: 'locked to the main key' })
  return {
    started: '2026-10-22T10:00:00.000Z',
    ended: '2026-10-22T10:04:00.000Z',
    passed: true,
    commits: { services: 'a'.repeat(40), standard: 'b'.repeat(40), markets: 'c'.repeat(40) },
    services: { verifier: 'loopback', host: 'loopback', feePayer: 'loopback', index: 'loopback', mcp: 'loopback' },
    checked: [],
    chain: { rpc: 'https://rpc.example', testDollar: address(), market: 'tutoring' },
    loop: { verifier: { name: 'verifier.e2e-loop.invalid', face: address(), id: address() }, index: address() },
    steps: {
      keys: { tutor: person(), student: person(), coach: person() },
      funding: { accounts: signature(), money: signature(), wallets: { tutor: address(), student: address() } },
      stamps: { tutor: { verifier: address(), model: 'stand-in', askedBack: 'same' }, student: { verifier: address(), model: 'stand-in', askedBack: 'same' } },
      credits: {
        tutor: { signature: signature(), amount: '0.1', credits: 10, reference: address() },
        student: { signature: signature(), amount: '0.1', credits: 10, reference: address() },
      },
      profiles: {
        tutor: { profile: address(), profilesFolder: address(), spent: 5, verification: 'checks' },
        student: { profile: address(), profilesFolder: address(), spent: 8, verification: 'checks' },
      },
      logins: { tutor: login(), student: { ...login(), profiles: ['tutoring/student'] } },
      mcp: { offer: 'x/offer/maths', offerKey: address(), found: address(), message: 'sent', inbox: { from: address(), counts: true, market: 'tutoring', role: 'student' }, reply: 'sent', replyRead: true },
      payment: { ...paid(), to: address(), evidence: evidence(signature()) },
      review: { id: 'maths', evidence: evidence(signature()), writtenBy: 'ai', key: address() },
      index: {
        tutor: { rating: 10, count: 1, trust: 44, uniqueness: 75, pickiness: 'average' },
        student: { rating: null, count: 0, trust: 38, uniqueness: 75, pickiness: 'average' },
        review: { evidence: 'with' },
      },
      reputation: { profile: address(), root: hex(), time: 1_790_000_000_000, leaves: 2, score: 44, result: 'shown' },
      removed: { key: address(), refused: 'no host took it: http://127.0.0.1:1 (unlisted: no write)', offer: 'gone' },
      device: { labels: ['sports-coaching/coach', 'tutoring/tutor'], stamps: 1 },
      addresses: { tutor: { answers: 7, addresses: 7, held: 0 }, student: { answers: 6, addresses: 4, held: 0 } },
      balances: { tutor: 4.9, student: 7.92, coach: 2.97 },
    },
    sweep: { signature: signature(), dollars: '100000', lamports: 49970000 },
  }
}

test('a passed run has every step, each with its fields', () => {
  checkRecord(passed())
  checkRecord({
    ...passed(),
    services: { ...passed().services, host: 'https://host.forest.foundation', feePayer: 'https://fee-payer.forest.foundation' },
    checked: ['https://verifier.forest.foundation', 'https://index.forest.foundation', 'https://mcp.forest.foundation'],
    chain: { ...passed().chain, rpc: 'RPC_URL' },
    sweep: undefined,
  })
})

test('a failed run has its error and the steps it finished, in order', () => {
  const { steps } = passed()
  checkRecord({ ...passed(), passed: false, error: 'Error: timed out waiting for the index', steps: { keys: steps.keys, funding: steps.funding, stamps: steps.stamps } })
  checkRecord({ ...passed(), passed: false, error: 'Error: no RPC', steps: {}, sweep: { dollars: '0', lamports: 0 } })
  checkRecord({ ...passed(), passed: false, error: 'the sweep: Error: no RPC', sweep: undefined })
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
    ['a field of the wrong kind', { ...p, steps: { ...p.steps, payment: { ...p.steps.payment, charge: 3.7 } } }],
    ['a rating that is not one', { ...p, steps: { ...p.steps, index: { ...p.steps.index, tutor: { rating: 8.05, count: 1, trust: 44, uniqueness: 75, pickiness: 'average' } } } }],
    ['a rating for the student, whom no one rated', { ...p, steps: { ...p.steps, index: { ...p.steps.index, student: { rating: 9, count: 1, trust: 38, uniqueness: 75, pickiness: 'average' } } } }],
    ['a trust that is not a whole number', { ...p, steps: { ...p.steps, index: { ...p.steps.index, student: { rating: null, count: 0, trust: 38.5, uniqueness: 75, pickiness: 'average' } } } }],
    ['a pickiness that is not a word of three', { ...p, steps: { ...p.steps, index: { ...p.steps.index, student: { rating: null, count: 0, trust: 38, uniqueness: 75, pickiness: 'picky' } } } }],
    ['a leaf score above 100', { ...p, steps: { ...p.steps, reputation: { ...p.steps.reputation, score: 101 } } }],
    ['a stamp not asked back', { ...p, steps: { ...p.steps, stamps: { ...p.steps.stamps, tutor: { verifier: address(), model: 'stand-in' } } } }],
    ['a review written by the app', { ...p, steps: { ...p.steps, review: { ...p.steps.review, writtenBy: 'app' } } }],
    ['a removed key whose write was not refused as unlisted', { ...p, steps: { ...p.steps, removed: { ...p.steps.removed, refused: 'refused: no credits' } } }],
    ['a new device that found no stamp', { ...p, steps: { ...p.steps, device: { ...p.steps.device, stamps: 0 } } }],
    ['a note not locked to the main key', { ...p, steps: { ...p.steps, logins: { ...p.steps.logins, tutor: { ...(p.steps.logins!.tutor as object), note: 'public' } } } }],
    ['an RPC with a key in its URL', { ...p, chain: { ...p.chain, rpc: 'https://rpc.example/?api-key=x' } }],
    ['a service that is neither loopback nor an origin', { ...p, services: { ...p.services, host: 'https://host.example/v1' } }],
    ['a deployed mcp the run acted through', { ...p, services: { ...p.services, mcp: 'https://mcp.forest.foundation' } }],
    ['a checked service that is not an origin', { ...p, checked: ['mcp.forest.foundation'] }],
    ['evidence with no chain', { ...p, steps: { ...p.steps, review: { ...p.steps.review, evidence: address() } } }],
    ['an answer that held an own address', { ...p, steps: { ...p.steps, addresses: { ...p.steps.addresses, student: { answers: 6, addresses: 4, held: 1 } } } }],
    ['not a commit', { ...p, commits: { ...p.commits, standard: 'main' } }],
    ['an end before its start', { ...p, ended: '2026-10-22T09:00:00.000Z' }],
    ['a passed run that swept nothing back from its own fee payer', { ...p, sweep: undefined }],
    ['a passed run whose sweep sent nothing', { ...p, sweep: { dollars: '0', lamports: 0 } }],
    ['a sweep of the wrong kind', { ...p, sweep: { ...p.sweep, dollars: 37.5 } }],
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
