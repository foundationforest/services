// Every tool, through the MCP SDK's own client, as an AI app calls it after the person logged in,
// with the reference signer open: the five reads, with what the hosts say and the index's answers
// whole, a field and a filter this copy has never seen among them; and each
// relayed tool against the person's rules, one in each of their two tutoring profiles' folders
// (post, message, read and pay; $50 a day on each). Inside them it is done without asking; outside
// them it needs the person's yes; a pay past the profile's limit too, and a rule with no limit pays
// any amount. A pay asked again within the hour pays nothing; another payment for a post already
// paid needs the yes; a review's evidence is the signer's, never the AI's. The profile record, the
// hosts record and a rule are refused. What the mcp checks first is refused before anything is
// relayed. Another device on the same seed serves the login from the rules, and a rule removed there
// is gone at the next ask. With no signer open, it says so plainly. And no answer, in the whole
// run, holds one of the person's own addresses.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, describe, mock, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { inboxKey } from '@foundationforest/keys'
import { b64u, pull, pullRequest, readProfile } from '@foundationforest/records'
import { RULE_PREFIX, openMessage, readerCount } from '@foundationforest/records/private'
import { WORD } from '../src/forest.ts'
import { NO_SIGNER } from '../src/relay.ts'
import { REPEAT_MS, Signer, permits } from './signer.ts'
import { TUTORING, type World, aiApp, lesson, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }

let w: World
let client: Client
/** The AI app's connection, as its rules name it. */
let connection: string
/** Every answer an AI app got in this file. */
const answers: string[] = []

const TUTOR = { market: 'tutoring', role: 'tutor' }
const STUDENT = { market: 'tutoring', role: 'student' }

before(async () => {
  w = await world()
  await w.person.open(w.mcp.origin)
  const c = await aiApp(w.mcp.origin)
  await logIn(c)
  client = c.client
  connection = ((await w.person.rules('tutoring/tutor'))[0]!.who as { connection: string }).connection
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

/** Another of the person's devices: a signer on the same seed, knowing the same profiles, with nothing else of the first one's. */
const otherDevice = () => new Signer({ seed: w.seed, hosts: [w.host], appUrl: 'https://app.forest.test', labels: Object.keys(w.own) })

/** Until the mcp has seen every socket close: the close reaches it on its own time. */
async function closed() {
  for (let i = 0; i < 50 && w.mcp.relay.size; i++) await new Promise((r) => setTimeout(r, 20))
}

/** What the index said at `path`, as the AI is shown it: whole, with where it was read and whose word it is. */
const said = (path: string, answer = w.said[path]) => ({ url: `${w.index}${path}`, word: WORD, answer })

describe('reading, with no signer', () => {
  test('markets: the directory', async () => {
    const out = await call('markets')
    assert.ok(out.markets.some((m: { name: string }) => m.name === 'tutoring'))
    assert.deepEqual(Object.keys(out), ['markets'], 'which markets an index lists is in its home, from index')
  })

  test('market: the file with its preview, its kinds, and the index’s whole answer, a field the mcp never saw in it', async () => {
    const out = await call('market', { market: 'tutoring' })
    assert.equal(out.market.howDealsGo, TUTORING.howDealsGo)
    assert.deepEqual(out.market.preview, ['subjects', 'description', 'price', 'place'])
    assert.deepEqual(out.kinds, ['offer', 'review'])
    assert.deepEqual(out.index, said('/markets/tutoring.json'))
    assert.equal(out.index.answer.badge, 'early')
  })

  test('a market whose file leaves preview out gets the manual’s default', async () => {
    const out = await call('market', { market: 'home-cleaning' })
    assert.ok(Array.isArray(out.market.preview) && out.market.preview[0] === 'description')
  })

  test('search: the filters given reach the index as they are, one the mcp never saw among them, and its answer comes whole', async () => {
    const filters = { q: 'physics', market: 'tutoring', badge: 'early' }
    const out = await call('search', { filters })
    const asked = `/search.json?${new URLSearchParams(filters)}`
    assert.deepEqual(out, { index: said(asked, { ...(w.said['/search.json'] as object), asked: filters }) })
    assert.deepEqual((await call('search')).index.answer.asked, {}, 'with no filters, none')
    assert.equal((await call('search', { filters: { limit: 5 } })).refused, "each filter's value is text: limit is not")
  })

  test('profile: any profile, from its hosts, its records by kind, and the index’s whole answer, a field the mcp never saw in it', async () => {
    const out = await call('profile', { address: w.stranger.address })
    assert.equal(out.profile.role, 'tutor')
    assert.equal(out.profile.inboxKey, undefined, 'the long inbox key is left out')
    assert.deepEqual(out.records.offer.map((r: { address: string }) => r.address).sort(), Object.values(w.stranger.offers).sort())
    assert.deepEqual(out.index, said(`/profiles/${w.stranger.address}.json`))
    assert.equal(out.index.answer.badge, 'early')
  })

  test('index: its skill.md and its home, each whole', async () => {
    assert.deepEqual(await call('index'), { skill: said('/skill.md'), home: said('/index.json') })
  })

  test('no source file names a field or a filter of the index’s', () => {
    // The index's fields and filters as its skill.md names them today. Left out: those that are also
    // the mcp's own words or the markets' (index and markets, its tools; market, role and name, its
    // parameters and the markets' fields; posts, what a market's role posts), which this could not
    // tell from the index's.
    const theirs = ['checks', 'rating', 'backing', 'results', 'total', 'q', 'near', 'km', 'minRating', 'minReviews', 'limit', 'offset']
    const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
    assert.ok(files.length > 10)
    for (const file of files) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      for (const field of theirs) {
        // Quoted, read as a property, written as a key, or put in a query.
        const named = new RegExp(`(['"\`])${field}\\1|\\.${field}\\b|\\b${field}\\s*:|[?&]${field}=`)
        assert.doesNotMatch(source, named, `src/${file} names ${field}`)
      }
    }
  })
})

describe('through the signer', () => {
  test('the login wrote one rule into each chosen profile’s folder: private to the profile, the connection’s key inside', async () => {
    for (const label of ['tutoring/tutor', 'tutoring/student']) {
      const view = await readProfile([w.host], w.own[label]!, Date.now(), { post: true })
      const held = [...view.current].filter(([path, { record }]) => path.startsWith(RULE_PREFIX) && record.body)
      assert.equal(held.length, 1, `one rule in ${label}'s folder`)
      assert.equal(readerCount(held[0]![1].record.body as { private: string }), 1, 'encrypted to the profile’s own inbox key alone')
      const [rule] = await w.person.rules(label)
      const { who, ...rest } = rule!
      assert.deepEqual(rest, { can: ['post', 'message', 'read', 'pay'], limit: { amount: '50', currency: 'USD', per: 'day' } }, 'what the person chose')
      assert.deepEqual(Object.keys(who).sort(), ['connection', 'connector', 'key', 'name'])
      assert.equal((who as { connector: string }).connector, w.mcp.origin)
      assert.equal((who as { connection: string }).connection, connection)
      assert.match((who as { key: string }).key, /^[A-Za-z0-9_-]{43}$/)
    }
    assert.deepEqual(await w.person.rules('clothing/seller'), [], 'none in a profile the person did not choose')
  })

  test('profiles: the market and role of each profile whose folder holds a rule for the connection, and nothing else', async () => {
    assert.deepEqual(await call('profiles'), { status: 'done', profiles: [TUTOR, STUDENT] })
  })

  test('another of the person’s devices, from the same seed, serves the login with the key from the rule', async () => {
    w.person.close()
    await closed()
    const other = otherDevice()
    try {
      await other.open(w.mcp.origin)
      assert.deepEqual(await call('profiles'), { status: 'done', profiles: [TUTOR, STUDENT] })
      assert.equal(other.asked.length, 1, 'the other device answered')
    } finally {
      other.close()
      await closed()
      await w.person.open(w.mcp.origin)
    }
  })

  test('post inside the rule: done without asking, written by the main key to the profile’s hosts', async () => {
    const out = await call('post', { market: 'tutoring', role: 'tutor', kind: 'offer', body: lesson('Maths, one hour, online.') })
    assert.equal(out.status, 'done')
    assert.equal(out.kind, 'offer')
    assert.match(out.id, /^[0-9a-f]{16}$/)
    assert.equal((await at('tutoring/tutor', `offer/${out.id}`))?.description, 'Maths, one hour, online.')
    assert.deepEqual(await call('post', { market: 'tutoring', role: 'tutor', kind: 'offer', id: 'maths', body: lesson('Maths, two hours.') }), { status: 'done', kind: 'offer', id: 'maths' })
    assert.equal((await at('tutoring/tutor', 'offer/maths'))?.description, 'Maths, two hours.')
  })

  test('post outside the rules: needs the person’s yes, with a link; after it, done', async () => {
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

  test('the signer refuses to write or remove the profile record, the hosts record or a rule, whatever the rule says', async () => {
    for (const kind of ['profile', 'hosts', 'rule']) {
      for (const tool of ['post', 'remove']) {
        const out = await w.person.handle(w.mcp.origin, connection, tool, { ...TUTOR, kind, id: 'x', ...(tool === 'post' && { body: {} }) })
        assert.deepEqual(out, { status: 'refused', why: `the ${kind} record is the person's own to write, in Forest` }, `${tool} ${kind}`)
      }
    }
    assert.equal(await at('tutoring/tutor', `${RULE_PREFIX}x`), null, 'nothing written')
    const rule = { who: { connector: 'https://mcp.example', connection: 'x' }, can: ['post'] }
    assert.equal(permits(rule, 'post'), true)
    assert.equal(permits({ ...rule, spend: 'any' } as never, 'post'), false, 'a rule it does not know whole')
    assert.equal(permits({ ...rule, until: Date.now() - 1 }, 'post'), false, 'a rule that ended')
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

  test('pay: done, and the answer says only that; each profile’s limit counted on its own', async () => {
    const { physics, chemistry } = w.stranger.offers
    assert.deepEqual(await call('pay', { offer: physics, role: 'student', amount: '30' }), { status: 'done' })
    assert.deepEqual(w.paid.map((p) => p.amount), ['30'])
    const over = await call('pay', { offer: chemistry, role: 'student', amount: '30' })
    assert.equal(over.status, 'needs approval')
    assert.match(over.why, /beyond a limit/)
    assert.deepEqual(await call('pay', { offer: chemistry, role: 'tutor', amount: '30' }), { status: 'done' }, 'the tutor’s limit is its own')
    assert.deepEqual(w.paid.map((p) => p.amount), ['30', '30'])
    const missing = await call('pay', { offer: `${w.stranger.address}/offer/nothing`, role: 'student', amount: '5' })
    assert.equal(missing.refused, `there is no post at ${w.stranger.address}/offer/nothing`)
  })

  test('pay asked again for the same post and amount within the hour pays nothing; any other payment for it needs the person’s yes', async () => {
    const { physics } = w.stranger.offers
    const paid = w.paid.length
    assert.deepEqual(await call('pay', { offer: physics, role: 'student', amount: '30' }), { status: 'done' })
    assert.deepEqual(await call('pay', { offer: physics, role: 'student', amount: '30.00' }), { status: 'done' }, 'the same amount, written another way')
    assert.equal(w.paid.length, paid, 'nothing paid again')
    const more = await call('pay', { offer: physics, role: 'student', amount: '5' })
    assert.equal(more.status, 'needs approval')
    assert.match(more.why, /paid already/)
    assert.equal(w.paid.length, paid, 'nothing paid before the yes')
    assert.deepEqual(await w.person.approve(more.link), { status: 'done', result: {} })
    assert.deepEqual(w.paid.slice(paid).map((p) => p.amount), ['5'])
    assert.deepEqual(await w.person.approve(more.link), { status: 'done', result: {} }, 'a yes given twice pays once')
    assert.equal(w.paid.length, paid + 1)
    mock.timers.enable({ apis: ['Date'], now: Date.now() + REPEAT_MS })
    try {
      const later = await call('pay', { offer: physics, role: 'student', amount: '30' })
      assert.equal(later.status, 'needs approval', 'an hour on, the same payment is another one')
    } finally {
      mock.timers.reset()
    }
    assert.equal(w.paid.length, paid + 1)
  })

  test('a review’s evidence is the signer’s: refused from the AI, naming the field; filled in from the payment for the post it names', async () => {
    const { physics, biology } = w.stranger.offers
    const review = (offer: string, more = {}) => ({ ...STUDENT, kind: 'review', body: { subject: w.stranger.address, score: '9', text: 'Clear and patient.', offer, ...more } })
    const asked = w.person.asked.length
    const named = await call('post', review(physics, { evidence: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:made-up' }))
    assert.equal(named.refused, "evidence is the person's signer's to fill, from the payment it made for the review's offer: leave evidence out")
    assert.equal(w.person.asked.length, asked, 'it never reached the signer')
    const out = await call('post', review(physics))
    assert.equal(out.status, 'done')
    const latest = w.paid.filter((p) => p.amount === '5').at(-1)!.evidence
    assert.deepEqual(await at('tutoring/student', `review/${out.id}`), review(physics, { evidence: latest }).body, 'the latest payment the student made for it')
    const unpaid = await call('post', review(biology))
    assert.equal((await at('tutoring/student', `review/${unpaid.id}`))?.evidence, undefined, 'none for a post it never paid')
    const asTutor = await call('post', { ...review(physics), ...TUTOR })
    assert.equal((await at('tutoring/tutor', `review/${asTutor.id}`))?.evidence, undefined, 'none from a profile that did not pay it')
    assert.equal((await call('post', { ...STUDENT, kind: 'review', body: { score: '9' } })).refused, 'a review names its subject: the address of the profile it is about')
  })

  test('pay by a rule with no limit: no money cap, done without asking', async () => {
    const request = `${b64u.encode(Buffer.from(JSON.stringify({ name: 'Another AI app' })))}.x`
    const back = new URL(await w.person.connect(w.mcp.origin, request, { profiles: ['tutoring/student'], can: ['pay'] }))
    const another = back.searchParams.get('connection')!
    for (const [offer, amount] of [[w.stranger.offers.biology!, '1000'], [w.stranger.offers.chemistry!, '1000000']]) {
      const out = await w.person.handle(w.mcp.origin, another, 'pay', { offer, ...STUDENT, amount })
      assert.equal(out.status, 'done', JSON.stringify(out))
    }
    assert.deepEqual(w.paid.slice(-2).map((p) => p.amount), ['1000', '1000000'])
  })

  test('with no signer open, it says so plainly', async () => {
    w.person.close()
    try {
      await closed()
      assert.deepEqual(await call('profiles'), { refused: NO_SIGNER })
      assert.match(NO_SIGNER, /open Forest on one of their devices/)
    } finally {
      await w.person.open(w.mcp.origin)
    }
  })

  test('a rule removed on another device is gone at the next ask; with none left, the login has ended', async () => {
    const other = otherDevice()
    await other.removeRule('tutoring/tutor', connection)
    assert.deepEqual(await call('profiles'), { status: 'done', profiles: [STUDENT] })
    const out = await call('post', { ...TUTOR, kind: 'offer', id: 'after', body: lesson('After the rule went.') })
    assert.equal(out.status, 'needs approval')
    assert.equal(await at('tutoring/tutor', 'offer/after'), null)
    await other.removeRule('tutoring/student', connection)
    assert.match((await call('profiles')).refused, /this connection was removed/)
  })
})

test('no answer in this file holds one of the person’s own addresses', async () => {
  const theirs = await w.person.addresses()
  assert.ok(answers.length > 20)
  for (const answer of answers) for (const address of theirs) assert.ok(!answer.includes(address), `an answer holds ${address}: ${answer}`)
})
