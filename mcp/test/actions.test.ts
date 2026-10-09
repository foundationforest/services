// Every action, against records' reference host on loopback, and every refusal: no key, a key of
// another scope, a key past its paths, the main key or the inbox key handed over, a path the owner
// wrote, a body that breaks its shape. What lands on the host is read back with the records library
// and the owners' own keys, never through this tool. And the hosts it reaches: a host a record names
// only at a public address, no redirect, and a stop after MAX_PAGES pages.

import assert from 'node:assert/strict'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { type AccessKey, type Body, deliver, hostsRecord, ownerRecord, permissionsRecord, publish, pull, pullRequest, readProfile } from '../../standard/records/src/index.ts'
import { message, openMessage } from '../../standard/records/src/private.ts'
import { type MainKey, inboxKey, mainKey, newSeed } from '../../standard/keys/src/index.ts'
import { ACTIONS, REQUESTS, checkArgs } from '../src/actions.ts'
import { type Context, MAX_PAGES, NO_KEY, Refusal, isPublic } from '../src/forest.ts'
import { ACCESS, KEYS, MARKET, SCORES, type World, buyer, buyerInbox, laterPastKey, messageKey, offer, quiet, seller, sellerInbox, strayKey, world, writeKey } from './setup.ts'

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

const run = (name: string, args: { [name: string]: unknown }, ctx: Context): Promise<any> => {
  const action = ACTIONS.find((a) => a.name === name)!
  return action.run(checkArgs(action, args), ctx)
}
const refused = (promise: Promise<unknown>, why: string | RegExp) =>
  assert.rejects(promise, (err: Error) => {
    assert.ok(err instanceof Refusal, err.stack)
    if (typeof why === 'string') assert.equal(err.message, why)
    else assert.match(err.message, why)
    return true
  })

/** The buyer's folder, as its host serves it now. */
const live = async () => (await readProfile([w.host.url], buyer.address, Date.now())).current

/** Every message to `owner`, pulled by its main key and opened with its inbox key. */
async function opened(owner: MainKey, identity: string) {
  const page = await pull(w.host.url, pullRequest(owner, 0, Date.now()))
  return Promise.all(page.messages.map((m) => openMessage(m.message, identity)))
}

const PAY_LINK = `https://forest.foundation/pay?v=2&offer=${seller.address}/offer/maths`

/** One request for each action a request may name, with that action's parameters. */
const ASKED: Array<[string, Body]> = [
  ['private', { path: 'notes' }],
  ['inbox', {}],
  ['post-offer', { offer: offer('Physics, asked for.'), id: 'asked' }],
  ['update-offer', { id: 'owned', offer: offer('Maths, two hours.') }],
  ['remove-offer', { id: 'owned' }],
  ['post-review', { review: { subject: seller.address, text: 'Kind and clear.' } }],
  ['send', { to: seller.address, text: 'Thank you.' }],
  ['pay', { offer: PAY_LINK, units: 2, note: 'Tuesday and Thursday, at six.' }],
]

describe('no key', () => {
  test('a market, from the index, as its own word', async () => {
    assert.deepEqual(await run('market', { market: 'tutoring' }, w.ctx()), { index: w.index, market: 'tutoring', says: MARKET })
    await refused(run('market', { market: 'gardening' }, w.ctx()), /gave nothing for markets\/gardening\.json/)
    await refused(run('market', { market: 'tutoring' }, { keys: {} }), 'no index set; set --index')
  })

  test("a profile: its card and offers from its hosts, every signature checked, and the index's summary beside them", async () => {
    const p = await run('profile', { address: seller.address }, w.ctx())
    assert.deepEqual(p.hosts, [w.host.url])
    assert.equal(p.card.body.role, 'seller')
    assert.deepEqual(p.offers.map((o: { path: string }) => o.path), ['offer/maths'])
    assert.deepEqual(p.reviews, [])
    assert.deepEqual(p.index, SCORES)
    // Without an index, the hosts alone.
    assert.equal((await run('profile', { address: buyer.address }, { hosts: [w.host.url], keys: {} })).index, null)
    // An index that has nothing for it hides nothing the hosts serve.
    const own = await run('profile', { address: buyer.address }, w.ctx())
    assert.match(own.index.unread, /gave nothing/)
    assert.deepEqual(own.offers.map((o: { path: string }) => o.path), ['offer/owned'])
  })

  test('the hosts to start from: the public list when none is given; out of reach when no host there has the profile', async () => {
    assert.equal((await run('profile', { address: seller.address }, { hostsList: w.hostsList, keys: {} })).card.body.role, 'seller')
    await refused(run('profile', { address: seller.address }, { hostsList: `${w.index}/no-list.json`, keys: {} }), 'no hosts to start from; set --host')
    await refused(run('profile', { address: strayKey.address }, w.ctx()), /^no records for .*: a profile on a host outside that list is out of reach until the host is added/)
    await refused(run('profile', { address: seller.address }, { hosts: ['http://example.com'], keys: {} }), /is not a host/)
    await refused(run('profile', { address: 'nobody' }, w.ctx()), "nobody is not a profile's address")
  })
})

describe('a write key', () => {
  test("posts, updates and removes an offer, and posts a review, each landing as the access key's record", async () => {
    const write = w.ctx({ write: KEYS.write })
    const posted = await run('post-offer', { offer: offer('Physics, one hour.'), id: 'physics' }, write)
    assert.deepEqual([posted.path, posted.hosts], ['offer/physics', [w.host.url]])
    let at = (await live()).get('offer/physics')!.record
    assert.equal(at.by, writeKey.address)
    assert.equal(at.body!.description, 'Physics, one hour.')
    const createdAt = at.body!.createdAt
    assert.match(String(createdAt), /^\d{4}-\d\d-\d\dT/, 'createdAt is set when missing')

    await run('update-offer', { id: 'physics', offer: offer('Physics, ninety minutes.') }, write)
    at = (await live()).get('offer/physics')!.record
    assert.equal(at.body!.description, 'Physics, ninety minutes.')
    assert.equal(at.body!.createdAt, createdAt, 'an update keeps when the offer was made')

    await run('remove-offer', { id: 'physics' }, write)
    assert.equal((await live()).get('offer/physics')!.record.body, null)

    assert.match((await run('post-offer', { offer: offer('Chemistry.') }, write)).path, /^offer\/[0-9a-f]{16}$/)

    const review = await run('post-review', { review: { subject: seller.address, ratings: { overall: '9' }, text: 'Clear and on time.' } }, w.ctx({ write: KEYS.review }))
    assert.equal((await live()).get(review.path)!.record.body!.subject, seller.address)
  })

  test("refuses before signing: no key, another scope, past its paths, the main key, the owner's path, a broken shape", async () => {
    const others = w.ctx({ message: KEYS.message, read: KEYS.read })
    await refused(run('post-offer', { offer: offer('x') }, others), NO_KEY)
    await refused(run('update-offer', { id: 'x', offer: offer('x') }, others), NO_KEY)
    await refused(run('remove-offer', { id: 'x' }, others), NO_KEY)
    await refused(run('post-review', { review: { subject: seller.address } }, others), NO_KEY)

    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.message })), 'this key is listed as a message key, not a write key; use request')
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.stray })), `this write key is not listed in ${buyer.address}'s permissions record; use request`)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.review })), /^this write key writes only under review, not at offer\/[0-9a-f]+; use request$/)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.main })), /main key; give an access key/)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: 'not a key' })), /not 32 bytes in base64url/)

    const write = w.ctx({ write: KEYS.write })
    await refused(run('update-offer', { id: 'owned', offer: offer('x') }, write), "the owner wrote offer/owned; only the owner's app can change it; use request")
    await refused(run('remove-offer', { id: 'owned' }, write), "the owner wrote offer/owned; only the owner's app can change it; use request")
    await refused(run('remove-offer', { id: 'never' }, write), 'nothing at offer/never')
    await refused(run('post-offer', { offer: { direction: 'sideways', description: 'x' } }, write), /^the offer does not fit its shape: offer\/direction must be equal to one of the allowed values/)
    await refused(run('post-offer', { offer: offer('x'), id: 'Not/This' }, write), /^an id is/)
    await refused(run('post-offer', { offer: offer('x') }, { ...write, profile: undefined }), /^no profile given/)
    assert.equal((await live()).get('offer/owned')!.record.body!.description, 'Maths, written by the main key.')
  })
})

describe('a read key', () => {
  test('opens the private records encrypted to it, and only those', async () => {
    const out = await run('private', {}, w.ctx({ read: KEYS.read }))
    assert.deepEqual(out.opened.map((r: { path: string; body: unknown }) => [r.path, r.body]), [['notes/1', { text: 'Tuesdays suit me.' }]])
    assert.equal(out.unopened, 1, 'notes/2 is encrypted to the inbox key alone')
    assert.deepEqual((await run('private', { path: 'offer' }, w.ctx({ read: KEYS.read }))).opened, [])
  })

  test('refuses no key, the inbox key, and a read key the folder does not list', async () => {
    await refused(run('private', {}, w.ctx({ write: KEYS.write })), NO_KEY)
    await refused(run('private', {}, w.ctx({ read: KEYS.inbox })), /inbox key; give a read key/)
    await refused(run('private', {}, w.ctx({ read: KEYS.read }, seller.address)), `this read key is not listed in ${seller.address}'s permissions record; use request`)
    await refused(run('private', {}, w.ctx({ read: 'AGE-SECRET-KEY-1ABC' })), /not an age identity/)
  })
})

describe('a message key', () => {
  test("sends to another profile's inbox, which its owner opens with its own inbox key", async () => {
    const sent = await run('send', { to: seller.address, text: 'Is Tuesday at six free?' }, w.ctx({ message: KEYS.message }))
    assert.deepEqual(sent.hosts, [w.host.url])
    const got = await opened(seller, sellerInbox.identity)
    assert.deepEqual(got.map((m) => [m.from, m.key, m.body]), [[buyer.address, messageKey.address, { text: 'Is Tuesday at six free?' }]])
  })

  test("requests: one for each action a request may name, each landing in the profile's own inbox as { request, ...its parameters }", async () => {
    assert.deepEqual(ASKED.map(([action]) => action).sort(), [...REQUESTS.keys()].sort(), 'one for each')
    for (const [action, params] of ASKED) await run('request', { action, params }, w.ctx({ message: KEYS.message }))
    const mine = await opened(buyer, buyerInbox.identity)
    assert.deepEqual(
      mine.map((m) => [m.from, m.key, m.body]),
      ASKED.map(([action, params]) => [buyer.address, messageKey.address, { ...params, request: action }]),
    )
  })

  test('refuses a request for an action that needs no key or is not one, and parameters that do not fit the action, a key among them', async () => {
    const ask = (action: string, params?: Body) => run('request', { action, ...(params && { params }) }, w.ctx({ message: KEYS.message }))
    const names = [...REQUESTS.keys()].join(', ')
    await refused(ask('profile', { address: seller.address }), `a request names one of ${names}; not profile`)
    await refused(ask('request', {}), `a request names one of ${names}; not request`)
    await refused(ask('fly'), `a request names one of ${names}; not fly`)
    await refused(ask('pay'), 'pay needs offer')
    await refused(ask('pay', { offer: PAY_LINK, units: 0 }), 'units is a whole number, from 1')
    await refused(ask('pay', { offer: PAY_LINK, units: 1.5 }), 'units is a whole number, from 1')
    await refused(ask('pay', { offer: PAY_LINK, units: '2' }), 'units is a whole number, from 1')
    await refused(ask('pay', { offer: PAY_LINK, note: 3 }), 'note is text')
    await refused(ask('post-offer', { offer: 'cheap' }), 'offer is an object')
    await refused(ask('post-offer', { offer: offer('x'), writeKey: KEYS.write }), 'post-offer takes no writeKey')
    await refused(run('request', { action: 'pay', params: { offer: PAY_LINK } }, w.ctx({ write: KEYS.write })), NO_KEY)
  })

  test('in the inbox, a request counts only when the profile sent it to itself, by its main key or a message key it lists; any other is a plain message', async () => {
    const card = (await live()).get('profile')!.record.body!
    // The person's own app, with the main key.
    await deliver([w.host.url], [await message(buyer, buyer.address, { request: 'remove-offer', id: 'main' }, Date.now(), card)])
    // A stranger.
    await deliver([w.host.url], [await message(seller, buyer.address, { request: 'pay', offer: PAY_LINK }, Date.now(), card)])
    // A message key the owner then makes past: it no longer speaks for the profile.
    await run('request', { action: 'remove-offer', params: { id: 'past' } }, w.ctx({ message: KEYS.laterPast }))
    await publish([w.host.url], [permissionsRecord(buyer, ACCESS.map((k) => (k.key === laterPastKey.address ? { key: k.key, was: 'message' as const } : k)), Date.now())])
    await refused(run('send', { to: seller.address, text: 'x' }, w.ctx({ message: KEYS.laterPast })), `this key is past in ${buyer.address}'s permissions record: the owner removed it; use request`)
    // The profile's own message key, with bodies that ask for no action this tool knows, or leave out what it needs.
    await run('send', { to: buyer.address, body: { request: 'fly' } }, w.ctx({ message: KEYS.message }))
    await run('send', { to: buyer.address, body: { request: 'pay' } }, w.ctx({ message: KEYS.message }))
    await run('send', { to: buyer.address, body: { request: 'pay', offer: PAY_LINK, units: 'two' } }, w.ctx({ message: KEYS.message }))

    const all = await run('inbox', {}, w.ctx({ message: KEYS.message, read: KEYS.read }))
    assert.deepEqual(
      all.messages.map((m: { from: string; request?: string; body: Body }) => [m.from, m.request ?? null, m.body]),
      [
        ...ASKED.map(([action, params]) => [buyer.address, action, { ...params, request: action }]),
        [buyer.address, 'remove-offer', { request: 'remove-offer', id: 'main' }],
        [seller.address, null, { request: 'pay', offer: PAY_LINK }],
        [buyer.address, null, { request: 'remove-offer', id: 'past' }],
        [buyer.address, null, { request: 'fly' }],
        [buyer.address, null, { request: 'pay' }],
        [buyer.address, null, { request: 'pay', offer: PAY_LINK, units: 'two' }],
      ],
    )
  })

  test('pulls the inbox: unopened without a read key the inbox lists, and newer only after the cursors', async () => {
    const all = await run('inbox', {}, w.ctx({ message: KEYS.message, read: KEYS.read }))
    const unopened = await run('inbox', {}, w.ctx({ message: KEYS.message }))
    assert.deepEqual(
      unopened.messages.map((m: { id: string; unopened?: true; body?: unknown; request?: string }) => [m.id, m.unopened, m.body, m.request]),
      all.messages.map((m: { id: string }) => [m.id, true, undefined, undefined]),
      'unopened, nothing read from it, so nothing marked a request',
    )
    assert.deepEqual((await run('inbox', { after: all.cursors }, w.ctx({ message: KEYS.message }))).messages, [])
  })

  test('refuses no key, another scope, the inbox key, a grant, and a profile with no inbox', async () => {
    const others = w.ctx({ write: KEYS.write, read: KEYS.read })
    await refused(run('send', { to: seller.address, text: 'x' }, others), NO_KEY)
    await refused(run('request', { action: 'pay', params: { offer: PAY_LINK } }, others), NO_KEY)
    await refused(run('inbox', {}, others), NO_KEY)
    await refused(run('send', { to: seller.address, text: 'x' }, w.ctx({ message: KEYS.write })), 'this key is listed as a write key, not a message key; use request')
    await refused(run('inbox', {}, w.ctx({ message: KEYS.write })), 'this key is listed as a write key, not a message key; use request')
    await refused(run('inbox', {}, w.ctx({ message: KEYS.message, read: KEYS.inbox })), /inbox key; give a read key/)
    await refused(run('inbox', { after: { [w.host.url]: 'soon' } }, w.ctx({ message: KEYS.message })), /^after holds the cursors/)
    await refused(run('send', { to: seller.address, body: { grant: { key: KEYS.write } } }, w.ctx({ message: KEYS.message })), /never carries a grant/)
    await refused(run('send', { to: quiet.address, text: 'x' }, w.ctx({ message: KEYS.message })), `${quiet.address} has no inbox this tool can read; nothing can be sent there`)
    await refused(run('send', { to: seller.address }, w.ctx({ message: KEYS.message })), 'give text or body, one of them')
  })
})

describe('hosts', () => {
  /** A server on loopback with its own answers; it counts every request it hears. */
  async function serve(answer: (req: IncomingMessage, res: ServerResponse) => void) {
    const heard: string[] = []
    const server = createServer((req, res) => {
      heard.push(req.url!)
      answer(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { url, heard, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  /** A profile whose hosts record names the start host and `other`, listing the write and message keys. */
  async function namingAlso(other: string) {
    const someone = await mainKey(newSeed(), 'tutoring/seller')
    const card = { market: 'tutoring', role: 'seller', name: 'someone', inboxKey: (await inboxKey(someone.privateKey)).recipient, inbox: { senders: 'anyone' }, createdAt: '2026-10-07T12:00:00Z' }
    const now = Date.now()
    const access: AccessKey[] = [{ key: writeKey.address, scope: 'write', paths: ['offer'] }, { key: messageKey.address, scope: 'message' }]
    await publish([w.host.url], [hostsRecord(someone, [w.host.url, other], now), permissionsRecord(someone, access, now), ownerRecord(someone, 'profile', card, now)])
    return someone.address
  }

  test('a host a hosts record names at a private address hears nothing: reads, writes, sends and pulls reach only public addresses and the start hosts', async () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', 'localhost']) {
      assert.equal(isPublic(a), false, a)
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPublic(a), true, a)
    const inside = await serve((_req, res) => res.end())
    try {
      const someone = await namingAlso(inside.url)
      const as = w.ctx({ write: KEYS.write, message: KEYS.message }, someone)
      const read = await run('profile', { address: someone }, w.ctx())
      assert.deepEqual([read.hosts, read.card.body.name], [[w.host.url, inside.url], 'someone'])
      const posted = await run('post-offer', { offer: offer('Chess, asked for.') }, as)
      assert.deepEqual([posted.hosts, posted.refused.map((r: { host: string }) => r.host)], [[w.host.url], [inside.url]])
      const sent = await run('send', { to: someone, text: 'Hello.' }, w.ctx({ message: KEYS.message }))
      assert.deepEqual([sent.hosts, sent.refused.map((r: { host: string }) => r.host)], [[w.host.url], [inside.url]])
      const pulled = await run('inbox', {}, as)
      assert.deepEqual([Object.keys(pulled.cursors), pulled.failed.map((f: { host: string }) => f.host)], [[w.host.url], [inside.url]])
      assert.deepEqual(inside.heard, [])
    } finally {
      await inside.close()
    }
  })

  test('a start host that redirects is not followed', async () => {
    const away = await serve((req, res) => res.writeHead(307, { location: `${w.host.url}${req.url}` }).end())
    try {
      await refused(run('profile', { address: seller.address }, { ...w.ctx(), hosts: [away.url] }), /^no records for/)
      assert.equal(away.heard.length, 1)
    } finally {
      await away.close()
    }
  })

  test(`a folder read, and an inbox pull, stop after ${MAX_PAGES} pages in all`, async () => {
    // Each answer a page further on, so a reader that follows the cursor never ends.
    let next = 0
    const endless = await serve((_req, res) => res.writeHead(200, { 'forest-cursor': String(++next) }).end())
    // One empty page of records, then inbox pages without end.
    let pulls = 0
    const endlessInbox = await serve((req, res) => res.writeHead(200, { 'forest-cursor': String(req.url === '/v1/inbox/pull' ? ++pulls : 0) }).end())
    try {
      await refused(run('profile', { address: seller.address }, { ...w.ctx(), hosts: [endless.url] }), `the hosts of ${seller.address} served more than ${MAX_PAGES} pages; this reads no further`)
      assert.equal(endless.heard.length, MAX_PAGES)

      const someone = await namingAlso(endlessInbox.url)
      const pulled = await run('inbox', {}, { ...w.ctx({ message: KEYS.message }, someone), hosts: [w.host.url, endlessInbox.url] })
      assert.deepEqual(pulled.failed, [{ host: endlessInbox.url, why: `stopped after ${MAX_PAGES} pages; pull again from its cursor` }])
      assert.ok(pulls > 0 && pulls < MAX_PAGES && pulled.cursors[endlessInbox.url] === pulls, 'the cursor read so far is kept')
    } finally {
      await endless.close()
      await endlessInbox.close()
    }
  })
})

