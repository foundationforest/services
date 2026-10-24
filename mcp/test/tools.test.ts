// Every tool, through the MCP SDK's own client, as an AI app calls it after the person logged in,
// with the reference signer open: the four reads, with what the index and the hosts say; and each
// relayed tool against the person's permissions (their two tutoring profiles; post, message, read
// and pay; $50 a day). Inside them it is done without asking; outside them it needs the person's
// yes; a pay past the limit too, and an entry with no limit pays any amount. What the mcp checks
// first is refused before anything is relayed.
// With no signer open, it says so plainly. And no answer, in the whole run, holds one of the
// person's own addresses.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { inboxKey } from '@foundationforest/keys'
import { b64u, pull, pullRequest, readProfile } from '@foundationforest/records'
import { openMessage } from '@foundationforest/records/private'
import { NO_SIGNER } from '../src/relay.ts'
import { permits } from './signer.ts'
import { TUTORING, type World, aiApp, lesson, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }

let w: World
let client: Client
/** Every answer an AI app got in this file. */
const answers: string[] = []

before(async () => {
  w = await world()
  await w.person.open(w.mcp.origin)
  const c = await aiApp(w.mcp.origin)
  await logIn(c)
  client = c.client
})
after(async () => {
  await client.close()
  await w.close()
})

/** A tool's call: its answer as JSON, or its refusal as `{ refused }`. */
async function call(name: string, args: { [key: string]: unknown } = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args })) as Result
  const text = r.content[0]!.text
  answers.push(text)
  return r.isError ? { refused: text } : JSON.parse(text)
}

/** What is at `path` in the person's profile `label`, read from its hosts. */
async function at(label: string, path: string) {
  return (await readProfile([w.host], w.own[label]!, Date.now())).current.get(path)?.record.body ?? null
}

describe('reading, with no signer', () => {
  test('markets: the directory, and the markets the index lists', async () => {
    const out = await call('markets')
    assert.ok(out.markets.some((m: { name: string }) => m.name === 'tutoring'))
    assert.deepEqual(out.index.markets, ['tutoring'])
  })

  test('market: the file with its preview, its kinds, and the index’s posts', async () => {
    const out = await call('market', { market: 'tutoring' })
    assert.equal(out.market.howDealsGo, TUTORING.howDealsGo)
    assert.deepEqual(out.market.preview, ['subjects', 'description', 'price', 'place'])
    assert.deepEqual(out.kinds, ['offer', 'review'])
    assert.equal(out.index.posts.tutor[0].post.address, w.stranger.offer)
  })

  test('a market whose file leaves preview out gets the manual’s default', async () => {
    const out = await call('market', { market: 'home-cleaning' })
    assert.ok(Array.isArray(out.market.preview) && out.market.preview[0] === 'description')
  })

  test('search: the index’s word, with the verifiers whose stamps it shows', async () => {
    const out = await call('search', { q: 'physics', market: 'tutoring' })
    assert.equal(out.total, 1)
    assert.equal(out.results[0].checks[0].verifier, 'verifier.forest.foundation')
  })

  test('profile: any profile, from its hosts, its records by kind, and the index’s checks and rating', async () => {
    const out = await call('profile', { address: w.stranger.address })
    assert.equal(out.profile.role, 'tutor')
    assert.equal(out.profile.inboxKey, undefined, 'the long inbox key is left out')
    assert.deepEqual(out.records.offer.map((r: { address: string }) => r.address), [w.stranger.offer])
    assert.equal(out.index.checks[0].verifier, 'verifier.forest.foundation')
    assert.equal(out.index.rating.value, '9.2')
  })
})

describe('through the signer', () => {
  test('profiles: the market and role of each profile the connection covers, and nothing else', async () => {
    assert.deepEqual(await call('profiles'), { status: 'done', profiles: [{ market: 'tutoring', role: 'tutor' }, { market: 'tutoring', role: 'student' }] })
  })

  test('post inside the permissions: done without asking, written by the main key to the profile’s hosts', async () => {
    const out = await call('post', { market: 'tutoring', role: 'tutor', kind: 'offer', body: lesson('Maths, one hour, online.') })
    assert.equal(out.status, 'done')
    assert.equal(out.kind, 'offer')
    assert.match(out.id, /^[0-9a-f]{16}$/)
    assert.equal((await at('tutoring/tutor', `offer/${out.id}`))?.description, 'Maths, one hour, online.')
    assert.deepEqual(await call('post', { market: 'tutoring', role: 'tutor', kind: 'offer', id: 'maths', body: lesson('Maths, two hours.') }), { status: 'done', kind: 'offer', id: 'maths' })
    assert.equal((await at('tutoring/tutor', 'offer/maths'))?.description, 'Maths, two hours.')
  })

  test('post outside the permissions: needs the person’s yes, with a link; after it, done', async () => {
    const out = await call('post', { market: 'clothing', role: 'seller', kind: 'offer', id: 'coat', body: { description: 'A wool coat.' } })
    assert.equal(out.status, 'needs approval')
    assert.match(out.link, /^https:\/\/app\.forest\.test\/approve\/\d+$/)
    assert.equal(await at('clothing/seller', 'offer/coat'), null, 'nothing written before the yes')
    assert.equal((await w.person.approve(out.link)).status, 'done')
    assert.equal((await at('clothing/seller', 'offer/coat'))?.description, 'A wool coat.')
  })

  test('what the mcp checks is refused before anything is relayed: a kind the market does not define, the profile record, a field that does not fit', async () => {
    const before = w.person.asked.length
    const profile = await call('post', { market: 'tutoring', role: 'tutor', kind: 'profile', body: { market: 'tutoring', role: 'tutor' } })
    assert.equal(profile.refused, 'tutoring has no kind profile: its kinds are offer, review')
    const hosts = await call('post', { market: 'tutoring', role: 'tutor', kind: 'hosts', body: { urls: ['https://evil.example'] } })
    assert.equal(hosts.refused, 'tutoring has no kind hosts: its kinds are offer, review')
    const field = await call('post', { market: 'tutoring', role: 'tutor', kind: 'offer', body: { colour: 'red' } })
    assert.equal(field.refused, 'an offer in tutoring has no field colour')
    const role = await call('post', { market: 'tutoring', role: 'parent', kind: 'offer', body: {} })
    assert.equal(role.refused, 'parent is not a role in tutoring: its roles are tutor, student')
    assert.equal(w.person.asked.length, before, 'none reached the signer')
    assert.equal(await at('tutoring/tutor', 'profile').then((b) => b?.role), 'tutor', 'the profile record is as it was')
  })

  test('the signer asked to post at the profile record or the hosts record asks the person, whatever the permission says', () => {
    const entry = { who: { connector: 'https://mcp.example', connection: 'x' }, profiles: 'all' as const, can: ['post'] }
    assert.equal(permits(entry, 'tutoring/tutor', 'post', 'offer/maths'), true)
    assert.equal(permits(entry, 'tutoring/tutor', 'post', 'profile'), false)
    assert.equal(permits(entry, 'tutoring/tutor', 'post', 'hosts'), false)
    assert.equal(permits({ ...entry, spend: 'any' } as never, 'tutoring/tutor', 'post', 'offer/maths'), false, 'an entry it does not know whole')
    assert.equal(permits({ ...entry, until: Date.now() - 1 }, 'tutoring/tutor', 'post', 'offer/maths'), false, 'an entry that ended')
  })

  test('remove: done, and the record is gone', async () => {
    assert.deepEqual(await call('remove', { market: 'tutoring', role: 'tutor', kind: 'offer', id: 'maths' }), { status: 'done', kind: 'offer', id: 'maths' })
    assert.equal(await at('tutoring/tutor', 'offer/maths'), null)
    assert.match((await call('remove', { market: 'tutoring', role: 'tutor', kind: 'offer', id: 'maths' })).refused, /nothing at offer maths/)
  })

  test('message: done; the stranger pulls it and opens it', async () => {
    assert.deepEqual(await call('message', { market: 'tutoring', role: 'student', to: w.stranger.address, text: 'Is Tuesday at six free?' }), { status: 'done' })
    const { identity } = await inboxKey(w.stranger.tutor.secret)
    const page = await pull(w.host, pullRequest(w.stranger.tutor, 0, Date.now()))
    const texts = await Promise.all(page.messages.map(async (m) => (await openMessage(m.message, identity)).body.text))
    assert.ok(texts.includes('Is Tuesday at six free?'))
  })

  test('inbox: the messages, opened by the signer, each with a number', async () => {
    const out = await call('inbox', { market: 'tutoring', role: 'tutor' })
    assert.equal(out.status, 'done')
    assert.deepEqual(out.messages.map((m: { number: number; from: string; text: string }) => [m.number, m.from, m.text]), [[1, w.stranger.address, 'Hello from a stranger: do you teach physics too?']])
    assert.deepEqual((await call('inbox', { market: 'tutoring', role: 'tutor' })).messages[0].number, 1, 'a message keeps its number')
  })

  test('reply: by number, from the profile the message came to', async () => {
    assert.deepEqual(await call('reply', { number: 1, text: 'Yes, physics too.' }), { status: 'done' })
    const { identity } = await inboxKey(w.stranger.tutor.secret)
    const page = await pull(w.host, pullRequest(w.stranger.tutor, 0, Date.now()))
    const opened = await Promise.all(page.messages.map((m) => openMessage(m.message, identity)))
    const reply = opened.find((m) => m.body.text === 'Yes, physics too.')!
    assert.equal(reply.from, w.own['tutoring/tutor'])
    assert.match((await call('reply', { number: 99, text: 'x' })).refused, /no message numbered 99/)
  })

  test('pay within the limit: done, with its evidence; past it: the person’s yes', async () => {
    const first = await call('pay', { offer: w.stranger.offer, role: 'student', amount: '30' })
    assert.equal(first.status, 'done')
    assert.match(first.evidence, /^solana:/)
    assert.equal(w.paid[0]!.amount, '30')
    const second = await call('pay', { offer: w.stranger.offer, role: 'student', amount: '30' })
    assert.equal(second.status, 'needs approval')
    assert.match(second.why, /beyond a limit/)
    assert.equal(w.paid.length, 1, 'nothing paid past the limit')
    const missing = await call('pay', { offer: `${w.stranger.address}/offer/nothing`, role: 'student', amount: '5' })
    assert.equal(missing.refused, `there is no post at ${w.stranger.address}/offer/nothing`)
  })

  test('pay by an entry with no limit: no money cap, done without asking', async () => {
    const request = `${b64u.encode(Buffer.from(JSON.stringify({ name: 'Another AI app' })))}.x`
    const back = new URL(await w.person.connect(w.mcp.origin, request, { profiles: ['tutoring/student'], can: ['pay'] }))
    const connection = back.searchParams.get('connection')!
    for (const amount of ['1000', '1000000']) {
      const out = await w.person.handle(w.mcp.origin, connection, 'pay', { offer: w.stranger.offer, market: 'tutoring', role: 'student', amount })
      assert.equal(out.status, 'done', JSON.stringify(out))
    }
    assert.deepEqual(w.paid.slice(-2).map((p) => p.amount), ['1000', '1000000'])
  })

  test('a review naming the payment: done', async () => {
    const out = await call('post', { market: 'tutoring', role: 'student', kind: 'review', body: { subject: w.stranger.address, score: '9', text: 'Clear and patient.', offer: w.stranger.offer, evidence: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:stand-in-payment-1' } })
    assert.equal(out.status, 'done')
    assert.equal((await at('tutoring/student', `review/${out.id}`))?.score, '9')
    assert.equal((await call('post', { market: 'tutoring', role: 'student', kind: 'review', body: { score: '9' } })).refused, 'a review names its subject: the address of the profile it is about')
  })

  test('with no signer open, it says so plainly', async () => {
    w.person.close()
    try {
      // The socket's close reaches the mcp on its own time.
      for (let i = 0; i < 50 && w.mcp.relay.size; i++) await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(await call('profiles'), { refused: NO_SIGNER })
      assert.match(NO_SIGNER, /open Forest on one of their devices/)
    } finally {
      await w.person.open(w.mcp.origin)
    }
  })
})

test('no answer in this file holds one of the person’s own addresses', async () => {
  const theirs = await w.person.addresses()
  assert.ok(answers.length > 20)
  for (const answer of answers) for (const address of theirs) assert.ok(!answer.includes(address), `an answer holds ${address}: ${answer}`)
})
