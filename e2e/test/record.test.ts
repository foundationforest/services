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
  const login = { profiles: ['tutoring/tutor'], can: ['read', 'write', 'pay'], limit: '5 USD a day' }
  return {
    started: '2026-10-22T10:00:00.000Z',
    ended: '2026-10-22T10:04:00.000Z',
    passed: true,
    commits: { services: 'a'.repeat(40), standard: 'b'.repeat(40), markets: 'c'.repeat(40) },
    services: { verifier: 'loopback', host: 'loopback', feePayer: 'loopback', index: 'loopback', mcp: 'loopback' },
    checked: [],
    chain: { rpc: 'https://rpc.example', escrow: address(), testDollar: address(), market: 'tutoring' },
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
        tutor: { profile: address(), tag: hex(), spent: 6, stampProof: 'checks' },
        student: { profile: address(), tag: hex(), spent: 10, stampProof: 'checks' },
      },
      logins: { tutor: login, student: { ...login, profiles: ['tutoring/student'], can: ['write', 'pay'] } },
      mcp: { offer: 'x/offer/maths', found: { profile: address() }, message: 'done', reply: 'done', approval: { ask: 'read', why: 'read as tutoring/student is not in what this connection may do', approved: 'done' } },
      deal: {
        payment: { ...paid(), evidence: evidence(signature()) },
        escrow: { address: address(), version: 4, open: paid(), pay: paid(), outcome: 'pay', sponsor: address(), evidence: evidence(address()) },
      },
      reviews: { student: { id: 'a1', evidence: evidence(signature()), postedBy: 'ai' }, tutor: { id: 'b2', evidence: evidence(address()), postedBy: 'app' } },
      index: {
        tutor: { rating: 10, count: 1, trust: 45, uniqueness: 75, pickiness: 'average' },
        student: { rating: 9, count: 1, trust: 45, uniqueness: 75, pickiness: 'average' },
        deal: { outcome: 'pay', reviews: 1 },
      },
      reputation: { profile: address(), tag: hex(), root: hex(), time: 1_790_000_000_000, score: 45, result: 'shown' },
      addresses: { tutor: { answers: 7, addresses: 7, held: 0 }, student: { answers: 6, addresses: 4, held: 0 } },
      balances: { tutor: 5.9, student: 9.92, coach: 3.97 },
    },
    sweep: { signature: signature(), dollars: '37536400', lamports: 48294920 },
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
    ['a field of the wrong kind', { ...p, steps: { ...p.steps, deal: { ...p.steps.deal, payment: { ...paid(), charge: 3.7 } } } }],
    ['a rating that is not one', { ...p, steps: { ...p.steps, index: { ...p.steps.index, tutor: { rating: 8.05, count: 1, trust: 45, uniqueness: 75, pickiness: 'average' } } } }],
    ['a trust that is not a whole number', { ...p, steps: { ...p.steps, index: { ...p.steps.index, student: { rating: 9, count: 1, trust: 45.5, uniqueness: 75, pickiness: 'average' } } } }],
    ['a pickiness that is not a word of three', { ...p, steps: { ...p.steps, index: { ...p.steps.index, student: { rating: 9, count: 1, trust: 45, uniqueness: 75, pickiness: 'picky' } } } }],
    ['a leaf score above 100', { ...p, steps: { ...p.steps, reputation: { ...p.steps.reputation, score: 101 } } }],
    ['a stamp not asked back', { ...p, steps: { ...p.steps, stamps: { ...p.steps.stamps, tutor: { verifier: address(), model: 'stand-in' } } } }],
    ['an escrow of another version', { ...p, steps: { ...p.steps, deal: { ...p.steps.deal, escrow: { ...(p.steps.deal!.escrow as object), version: 3 } } } }],
    ['the tutor’s review posted by its AI', { ...p, steps: { ...p.steps, reviews: { ...p.steps.reviews, tutor: { ...(p.steps.reviews!.tutor as object), postedBy: 'ai' } } } }],
    ['an RPC with a key in its URL', { ...p, chain: { ...p.chain, rpc: 'https://rpc.example/?api-key=x' } }],
    ['a service that is neither loopback nor an origin', { ...p, services: { ...p.services, host: 'https://host.example/v1' } }],
    ['a deployed mcp the run acted through', { ...p, services: { ...p.services, mcp: 'https://mcp.forest.foundation' } }],
    ['a checked service that is not an origin', { ...p, checked: ['mcp.forest.foundation'] }],
    ['evidence with no chain', { ...p, steps: { ...p.steps, reviews: { ...p.steps.reviews, tutor: { id: 'b2', evidence: address() } } } }],
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
