// Every tool, through the MCP SDK's own client, as an AI app calls it after the person logged in,
// with the reference signer open. The five reads: the index's answers whole, a field and a filter
// this copy has never seen among them, and the markets; and no source file reads a host or names a
// field of the index's. Then `read`, `write` and `pay`, each the standard's ask, against the
// person's permissions: the connect step makes one with `can` empty on each profile picked, so every
// ask waits for the person's yes, until they allow more in their app ($50 a day on each tutoring
// profile). Inside a permission it is done without asking; outside, it waits, a pay past the
// profile's limit too, and a permission with no limit pays any amount. What the standard refuses as
// an ask never reaches the app; what the app checks (the market, the hosts record, a permission, a
// review's evidence) it refuses naming why. A write of the profile record asks the person, and on
// a yes keeps the app's own fields, or makes a new profile, with a stamp proof from the stamp the
// device holds. A pay asked again within the hour pays nothing; another payment for what was paid
// waits. Another device on the same seed serves the login from the permissions, and one removed
// there is gone at the next ask. With no app open, it says so plainly. And no answer, in the whole
// run, holds one of the person's own addresses.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { inboxKey, mainKey, newSeed, seedScalar } from '@foundationforest/keys'
import { proofsOf, pull, pullRequest, readProfile, stampCheck } from '@foundationforest/records'
import { openMessage, readerCount } from '@foundationforest/records/private'
import { PERMISSION_PREFIX } from '@foundationforest/signers'
import { checkStamp, signStamp, stampNumberOf, verifierKeyOf } from '@foundationforest/stamp'
import { WORD } from '../src/forest.ts'
import { NO_SIGNER } from '../src/link.ts'
import { REPEAT_MS, Signer, live } from './signer.ts'
import { TUTORING, type World, aiApp, lesson, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }

let w: World
let client: Client
/** The AI app's connection, as its permissions name it. */
let connection: string
/** Every answer an AI app got in this file. */
const answers: string[] = []

const TUTOR = 'tutoring/tutor'
const STUDENT = 'tutoring/student'
/** What the person lets the AI app do on each tutoring profile, once it has logged in. */
const ALLOWED = { can: ['read', 'write', 'pay'], limit: { amount: '50', currency: 'USD', per: 'day' } }

before(async () => {
  w = await world()
  await w.person.open(w.mcp.origin)
  const c = await aiApp(w.mcp.origin)
  await logIn(c)
  client = c.client
  connection = ((await w.person.permissions(TUTOR))[0]!.who as { connection: string }).connection
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
  for (let i = 0; i < 50 && w.mcp.link.size; i++) await new Promise((r) => setTimeout(r, 20))
}

/** What the index said at `path`, as the AI is shown it: whole, with where it was read and whose word it is. */
const said = (path: string, answer = w.said[path]) => ({ url: `${w.index}${path}`, word: WORD, answer })

describe('reading, with no app', () => {
  test('markets: the directory', async () => {
    const out = await call('markets')
    assert.ok(out.markets.some((m: { name: string }) => m.name === 'tutoring'))
    assert.deepEqual(Object.keys(out), ['markets'], 'which markets an index lists is in its home, from index')
  })

  test('market: the file with its preview, its kinds, and the index’s whole answer, a field the mcp never saw in it', async () => {
    const out = await call('market', { market: 'tutoring' })
    assert.equal(out.market.howDealsGo, TUTORING.howDealsGo)
    assert.deepEqual(out.market.preview, ['subjects', 'description', 'price', 'place'])
    assert.deepEqual(out.kinds, ['offer', 'review', 'vouch', 'report'])
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

  test('profile: any profile, as the index shows it, its whole answer and nothing else; refused when the index has nothing', async () => {
    const out = await call('profile', { address: w.stranger.address })
    assert.deepEqual(out, { index: said(`/profiles/${w.stranger.address}.json`) })
    assert.equal((out.index.answer as { badge: string }).badge, 'early')
    const unknown = (await mainKey(newSeed(), 'tutoring/tutor')).address
    assert.match((await call('profile', { address: unknown })).refused, /^the index gave nothing for .*: answered 404$/)
    assert.equal((await call('profile', { address: '../search' })).refused, "../search is not a profile's address")
  })

  test('index: its skill.md and its home, each whole', async () => {
    assert.deepEqual(await call('index'), { skill: said('/skill.md'), home: said('/index.json') })
  })

  test('no source file reads a host, or names a field or a filter of the index’s', () => {
    // The index's fields and filters as its skill.md names them today. Left out: those that are also
    // the mcp's own words or the markets' (index and markets, its tools; market, role and name, its
    // parameters and the markets' fields; posts, what a market's role posts), which this could not
    // tell from the index's.
    const theirs = ['checks', 'rating', 'backing', 'results', 'total', 'q', 'near', 'km', 'minRating', 'minReviews', 'limit', 'offset']
    const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
    assert.ok(files.length > 10)
    for (const file of files) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /\b(readProfile|readAll|readPage|publish|deliver|pull)\(/, `src/${file} reads or writes a host`)
      for (const field of theirs) {
        // Quoted, read as a property, written as a key, or put in a query.
        const named = new RegExp(`(['"\`])${field}\\1|\\.${field}\\b|\\b${field}\\s*:|[?&]${field}=`)
        assert.doesNotMatch(source, named, `src/${file} names ${field}`)
      }
    }
  })
})

describe('through the person’s app', () => {
  test('the connect step wrote one permission into each picked profile’s folder, can empty: private to the profile, the connection’s key inside', async () => {
    for (const label of [TUTOR, STUDENT]) {
      const view = await readProfile([w.host], w.own[label]!, Date.now(), { post: true })
      const held = [...view.current].filter(([path, { record }]) => path.startsWith(PERMISSION_PREFIX) && record.body)
      assert.equal(held.length, 1, `one permission in ${label}'s folder`)
      assert.equal(readerCount(held[0]![1].record.body as { private: string }), 1, 'encrypted to the profile’s own inbox key alone')
      const [permission] = await w.person.permissions(label)
      const { who, ...rest } = permission!
      assert.deepEqual(rest, { can: [] }, 'the profiles it sees, and nothing more')
      assert.deepEqual(Object.keys(who).sort(), ['connection', 'connector', 'key', 'name'])
      assert.deepEqual([(who as { connector: string }).connector, (who as { connection: string }).connection, (who as { name: string }).name], [w.mcp.origin, connection, 'An AI app'])
      assert.match((who as { key: string }).key, /^[A-Za-z0-9_-]{43}$/)
    }
    assert.deepEqual(await w.person.permissions('clothing/seller'), [], 'none in a profile the person did not pick')
  })

  test('read with nothing named: each profile the AI app sees, by its label, and what it may do there', async () => {
    assert.deepEqual(await call('read'), { status: 'done', profiles: [{ label: TUTOR, can: [] }, { label: STUDENT, can: [] }] })
  })

  test('with can empty, every ask waits for the person’s yes, with a link; after it, done', async () => {
    const out = await call('write', { label: TUTOR, path: 'offer/first', body: lesson('A first lesson.') })
    assert.equal(out.status, 'waiting')
    assert.match(out.link, /^https:\/\/app\.forest\.test\/approve\/\d+$/)
    assert.equal(await at(TUTOR, 'offer/first'), null, 'nothing written before the yes')
    assert.deepEqual(await w.person.approve(out.link), { status: 'done' })
    assert.equal((await at(TUTOR, 'offer/first'))?.description, 'A first lesson.')
  })

  test('the person allows more, in their app; read with nothing named says so', async () => {
    for (const label of [TUTOR, STUDENT]) await w.person.allow(label, connection, ALLOWED)
    assert.deepEqual(await call('read'), { status: 'done', profiles: [{ label: TUTOR, ...ALLOWED }, { label: STUDENT, ...ALLOWED }] })
  })

  test('another of the person’s devices, from the same seed, serves the login with the key from the permission', async () => {
    w.person.close()
    await closed()
    const other = otherDevice()
    try {
      await other.open(w.mcp.origin)
      assert.equal((await call('read')).status, 'done')
      assert.equal(other.asked.length, 1, 'the other device answered')
    } finally {
      other.close()
      await closed()
      await w.person.open(w.mcp.origin)
    }
  })

  test('write inside the permission: done without asking, signed by the main key and on the profile’s hosts; read gives it back', async () => {
    assert.deepEqual(await call('write', { label: TUTOR, path: 'offer/maths', body: lesson('Maths, one hour, online.') }), { status: 'done' })
    assert.equal((await at(TUTOR, 'offer/maths'))?.description, 'Maths, one hour, online.')
    const back = await call('read', { label: TUTOR, path: 'offer/maths' })
    assert.equal(back.status, 'done')
    assert.equal(back.body.description, 'Maths, one hour, online.')
    assert.ok(Number.isSafeInteger(back.time))
    assert.deepEqual(await call('read', { label: TUTOR, path: 'offer/none' }), { status: 'done', body: null })
  })

  test('outside the permissions: a profile no permission covers waits; after the yes, done', async () => {
    const out = await call('write', { label: 'clothing/seller', path: 'offer/coat', body: { description: 'A wool coat.' } })
    assert.equal(out.status, 'waiting')
    assert.equal(await at('clothing/seller', 'offer/coat'), null, 'nothing written before the yes')
    assert.equal((await w.person.approve(out.link)).status, 'done')
    assert.equal((await at('clothing/seller', 'offer/coat'))?.description, 'A wool coat.')
  })

  test('a label the person has no profile under waits the same, so asking maps nothing; a yes then refuses it', async () => {
    const out = await call('write', { label: 'electronics/seller', path: 'offer/radio', body: { description: 'A radio.' } })
    assert.equal(out.status, 'waiting')
    assert.equal(out.why, 'write as electronics/seller is not in what this connection may do')
    assert.deepEqual(await w.person.approve(out.link), { status: 'refused', why: 'the person has no profile as electronics/seller' })
  })

  test('the standard’s refusals come from the mcp, before anything reaches the app', async () => {
    const before = w.person.asked.length
    for (const [args, why] of [
      [{ label: TUTOR, path: 'Offer/x', body: {} }, 'a write names a path, or `to` for a message'],
      [{ label: TUTOR, path: 'offer/x', to: w.stranger.address, body: {} }, 'no field path'],
      [{ label: TUTOR, to: w.stranger.address, body: null }, 'a body is an object'],
    ] as const) {
      assert.equal((await call('write', args)).refused, `not an ask the person's app takes: ${why}`, JSON.stringify(args))
    }
    assert.match((await call('pay', { label: STUDENT, to: w.stranger.offer, amount: '1.0000001', currency: 'USD' })).refused, /an amount is decimal text/)
    assert.match((await call('read', { path: 'offer/x' })).refused, /a read names nothing, or a label/)
    assert.equal((await call('write', { label: TUTOR, path: 'offer/x' })).refused, 'write needs body')
    assert.equal(w.person.asked.length, before, 'none reached the app')
  })

  test('what the app checks against the market, it refuses naming why: a kind the market does not define, a field that does not fit, a role the market lacks', async () => {
    const write = (label: string, path: string, body: object) => call('write', { label, path, body })
    assert.deepEqual(await write(TUTOR, 'notes/x', {}), { status: 'refused', why: 'tutoring has no kind notes: its kinds are offer, review, vouch, report' })
    assert.deepEqual(await write(TUTOR, 'offer/x', { colour: 'red' }), { status: 'refused', why: 'an offer in tutoring has no field colour' })
    assert.deepEqual(await write(TUTOR, 'offer/x', { price: 30 }), { status: 'refused', why: 'price takes { amount, currency, per }: amount as decimal text, currency a code such as USD, per if wanted' })
    assert.deepEqual(await write('tutoring/parent', 'offer/x', {}), { status: 'refused', why: 'parent is not a role in tutoring: its roles are tutor, student' })
    assert.equal(await at(TUTOR, 'offer/x'), null, 'nothing written')
  })

  test('the hosts record and a permission are the person’s to write, and a permission’s to read, in Forest', async () => {
    const id = [...(await readProfile([w.host], w.own[TUTOR]!, Date.now(), { post: true })).current.keys()].find((p) => p.startsWith(PERMISSION_PREFIX))!
    assert.deepEqual(await call('write', { label: TUTOR, path: 'hosts', body: { urls: ['https://elsewhere.example'] } }), { status: 'refused', why: "the hosts record is the person's to write, in Forest" })
    assert.deepEqual(await call('write', { label: TUTOR, path: id, body: null }), { status: 'refused', why: "a permission is the person's to write, in Forest" })
    assert.deepEqual(await call('read', { label: TUTOR, path: id }), { status: 'refused', why: "a permission is the person's to read, in Forest" })
    assert.equal((await w.person.permissions(TUTOR)).length, 1, 'the permission is as it was')
  })

  test('a write of the profile record always asks the person; on a yes the app keeps its own fields, and takes only the market’s, none in tutoring', async () => {
    const was = await at(TUTOR, 'profile')
    assert.deepEqual(await call('write', { label: TUTOR, path: 'profile', body: { colour: 'red' } }), { status: 'refused', why: 'a profile record in tutoring has no field colour' })
    const out = await call('write', { label: TUTOR, path: 'profile', body: { market: 'clothing', role: 'seller', inboxKey: 'age1pq1x', pay: { solana: 'x' } } })
    assert.equal(out.status, 'waiting')
    assert.equal(out.why, 'write as tutoring/tutor at profile always asks the person')
    assert.deepEqual(await w.person.approve(out.link), { status: 'done' })
    assert.deepEqual(await at(TUTOR, 'profile'), was, 'its market, role, inbox key, inbox and pay addresses, as they were')
  })

  test('making a profile: a write of profile under a new label asks the person; on a yes the app makes it, with a stamp proof from the stamp the device holds', async () => {
    const key = new Uint8Array(randomBytes(32))
    const verifierName = 'verifier.test.example'
    w.person.keep(signStamp(key, { stampNumber: stampNumberOf(await seedScalar(w.seed), verifierName), facts: 1n }), verifierName)
    const out = await call('write', { label: 'clothing/buyer', path: 'profile', body: {} })
    assert.equal(out.status, 'waiting')
    assert.deepEqual(await w.person.approve(out.link), { status: 'done' })
    assert.ok(w.person.labels().includes('clothing/buyer'))
    const address = (await mainKey(w.seed, 'clothing/buyer')).address
    const body = (await readProfile([w.host], address, Date.now())).current.get('profile')!.record.body!
    assert.deepEqual([body.market, body.role, body.inbox, Object.keys(body.pay as object).sort(), typeof body.inboxKey], ['clothing', 'buyer', {}, ['evm', 'solana'], 'string'])
    const proof = proofsOf(body).find((p) => p.circuit === 'stamp')!
    assert.equal(proof.verifier, verifierKeyOf(key))
    assert.ok(await checkStamp(stampCheck(proof, address)!), 'its stamp proof checks')
    assert.deepEqual((await call('read')).profiles.map((p: { label: string }) => p.label), [TUTOR, STUDENT], 'the AI app sees it only once the person picks it')
  })

  test('remove: a null body; done, and the record is gone; a remove of nothing is refused', async () => {
    assert.deepEqual(await call('write', { label: TUTOR, path: 'offer/maths', body: null }), { status: 'done' })
    assert.equal(await at(TUTOR, 'offer/maths'), null)
    assert.deepEqual(await call('write', { label: TUTOR, path: 'offer/maths', body: null }), { status: 'refused', why: 'nothing at offer/maths' })
  })

  test('message: a write to another profile’s address; the stranger pulls it and opens it', async () => {
    assert.deepEqual(await call('write', { label: STUDENT, to: w.stranger.address, body: { text: 'Is Tuesday at six free?' } }), { status: 'done' })
    const { identity } = await inboxKey(w.stranger.tutor.secret)
    const page = await pull(w.host, pullRequest(w.stranger.tutor, 0, Date.now()))
    const texts = await Promise.all(page.messages.map(async (m) => (await openMessage(m.message, identity)).body.text))
    assert.ok(texts.includes('Is Tuesday at six free?'))
  })

  test('read the inbox: each message from an address, or from another of the person’s profiles by its label, with its time and body', async () => {
    assert.deepEqual(await call('write', { label: STUDENT, to: w.own[TUTOR]!, body: { text: 'A note from myself.' } }), { status: 'done' }, 'a write to an address of the person’s own, which it never gets back')
    const out = await call('read', { label: TUTOR, inbox: true })
    assert.equal(out.status, 'done')
    assert.deepEqual(
      out.messages.map((m: { from?: string; fromLabel?: string; body: { text: string } }) => [m.from ?? m.fromLabel, m.body.text]),
      [[w.stranger.address, 'Hello from a stranger: do you teach physics too?'], [STUDENT, 'A note from myself.']],
    )
    assert.ok(out.messages.every((m: { time: number }) => Number.isSafeInteger(m.time)))
  })

  test('reply: a write to the address the message came from, as the profile it came to', async () => {
    assert.deepEqual(await call('write', { label: TUTOR, to: w.stranger.address, body: { text: 'Yes, physics too.' } }), { status: 'done' })
    const { identity } = await inboxKey(w.stranger.tutor.secret)
    const page = await pull(w.host, pullRequest(w.stranger.tutor, 0, Date.now()))
    const opened = await Promise.all(page.messages.map((m) => openMessage(m.message, identity)))
    assert.equal(opened.find((m) => m.body.text === 'Yes, physics too.')!.from, w.own[TUTOR])
  })

  test('pay: to a post’s full address, done, and the answer says only that; each profile’s limit counted on its own', async () => {
    const { physics, chemistry } = w.stranger.offers
    const pay = (label: string, to: string, amount: string, currency = 'USD') => call('pay', { label, to, amount, currency })
    assert.deepEqual(await pay(STUDENT, physics!, '30'), { status: 'done' })
    assert.deepEqual(w.paid.map((p) => p.amount), ['30'])
    const over = await pay(STUDENT, chemistry!, '30')
    assert.equal(over.status, 'waiting')
    assert.match(over.why, /beyond a limit/)
    assert.deepEqual(await pay(TUTOR, chemistry!, '30'), { status: 'done' }, 'the tutor’s limit is its own')
    assert.deepEqual(w.paid.map((p) => p.amount), ['30', '30'])
    assert.deepEqual(await pay(STUDENT, `${w.stranger.address}/offer/nothing`, '5'), { status: 'refused', why: `there is no post at ${w.stranger.address}/offer/nothing` })
    assert.deepEqual(await pay(STUDENT, physics!, '5', 'EUR'), { status: 'refused', why: 'this app pays in USD' })
  })

  test('pay asked again for the same post and amount within the hour pays nothing; any other payment for it waits for the person’s yes', async () => {
    const { physics } = w.stranger.offers
    const paid = w.paid.length
    const pay = (amount: string) => call('pay', { label: STUDENT, to: physics, amount, currency: 'USD' })
    assert.deepEqual(await pay('30'), { status: 'done' })
    assert.deepEqual(await pay('30.00'), { status: 'done' }, 'the same amount, written another way')
    assert.equal(w.paid.length, paid, 'nothing paid again')
    const more = await pay('5')
    assert.equal(more.status, 'waiting')
    assert.match(more.why, /paid already/)
    assert.equal(w.paid.length, paid, 'nothing paid before the yes')
    assert.deepEqual(await w.person.approve(more.link), { status: 'done' })
    assert.deepEqual(w.paid.slice(paid).map((p) => p.amount), ['5'])
    assert.deepEqual(await w.person.approve(more.link), { status: 'done' }, 'a yes given twice pays once')
    assert.equal(w.paid.length, paid + 1)
    mock.timers.enable({ apis: ['Date'], now: Date.now() + REPEAT_MS })
    try {
      assert.equal((await pay('30')).status, 'waiting', 'an hour on, the same payment is another one')
    } finally {
      mock.timers.reset()
    }
    assert.equal(w.paid.length, paid + 1)
  })

  test('a review’s evidence is the app’s: refused from the AI, naming the field; filled in from the payment for the post it names', async () => {
    const { physics, biology } = w.stranger.offers
    const review = (offer: string, more = {}) => ({ subject: w.stranger.address, score: '9', text: 'Clear and patient.', offer, ...more })
    const write = (label: string, id: string, body: object) => call('write', { label, path: `review/${id}`, body })
    const named = await write(STUDENT, 'named', review(physics!, { evidence: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:made-up' }))
    assert.deepEqual(named, { status: 'refused', why: "evidence is the person's app's to fill, from the payment it made for the review's offer: leave evidence out" })
    assert.deepEqual(await write(STUDENT, 'physics', review(physics!)), { status: 'done' })
    const latest = w.paid.filter((p) => p.amount === '5').at(-1)!.evidence
    assert.deepEqual(await at(STUDENT, 'review/physics'), review(physics!, { evidence: latest }), 'the latest payment the student made for it')
    assert.deepEqual(await write(STUDENT, 'biology', review(biology!)), { status: 'done' })
    assert.equal((await at(STUDENT, 'review/biology'))?.evidence, undefined, 'none for a post it never paid')
    assert.deepEqual(await write(TUTOR, 'physics', review(physics!)), { status: 'done' })
    assert.equal((await at(TUTOR, 'review/physics'))?.evidence, undefined, 'none from a profile that did not pay it')
    assert.deepEqual(await write(STUDENT, 'x', { score: '9' }), { status: 'refused', why: 'a review names its subject: the address of the profile it is about' })
  })

  test('pay by a permission with no limit: no money cap, done without asking', async () => {
    const request = `${Buffer.from(JSON.stringify({ name: 'Another AI app', redirect: 'https://ai-app.example/callback' })).toString('base64url')}.x`
    const another = new URL(await w.person.connect(w.mcp.origin, request, { profiles: [STUDENT] })).searchParams.get('connection')!
    await w.person.allow(STUDENT, another, { can: ['pay'] })
    for (const [to, amount] of [[w.stranger.offers.biology!, '1000'], [w.stranger.offers.chemistry!, '1000000']]) {
      const out = await w.person.handle(w.mcp.origin, another, { ask: 'pay', label: STUDENT, to, amount, currency: 'USD' })
      assert.equal(out.status, 'done', JSON.stringify(out))
    }
    assert.deepEqual(w.paid.slice(-2).map((p) => p.amount), ['1000', '1000000'])
    const permission = { who: { connector: 'https://mcp.example', connection: 'x' }, can: ['write'] }
    assert.equal(live(permission), true)
    assert.equal(live({ ...permission, spend: 'any' } as never), false, 'a permission it does not know whole')
    assert.equal(live({ ...permission, until: Date.now() - 1 }), false, 'a permission that ended')
  })

  test('with no app open, it says so plainly', async () => {
    w.person.close()
    try {
      await closed()
      assert.deepEqual(await call('read'), { refused: NO_SIGNER })
      assert.match(NO_SIGNER, /^Forest is not open on any of the person's devices/)
    } finally {
      await w.person.open(w.mcp.origin)
    }
  })

  test('a permission removed on another device is gone at the next ask; with none left, the login has ended', async () => {
    const other = otherDevice()
    await other.removePermission(TUTOR, connection)
    assert.deepEqual((await call('read')).profiles.map((p: { label: string }) => p.label), [STUDENT])
    const out = await call('write', { label: TUTOR, path: 'offer/after', body: lesson('After the permission went.') })
    assert.equal(out.status, 'waiting')
    assert.equal(await at(TUTOR, 'offer/after'), null)
    await other.removePermission(STUDENT, connection)
    assert.deepEqual(await call('read'), { status: 'refused', why: 'this connection was removed' })
  })
})

test('no answer in this file holds one of the person’s own addresses', async () => {
  const theirs = await w.person.addresses()
  assert.ok(answers.length > 30)
  for (const answer of answers) for (const address of theirs) assert.ok(!answer.includes(address), `an answer holds ${address}: ${answer}`)
})
