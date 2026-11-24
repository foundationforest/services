// The real Stripe client against a local stand-in that answers the way Stripe's documents say it does
// (Checkout Sessions, PaymentIntents and their search, API v1). Nothing here reaches Stripe itself.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { PAGE_TEXT, PaymentUnavailable, StripeClient } from '../src/stripe.ts'

const KEY = 'sk_test_51standin'
const PUBLISHABLE_KEY = 'pk_test_51standin'
const PRICE = 'price_1UXRbDILoxkbMfX4cfwRfCOI'
const ADDED_PRICE = 'price_1UXRbDILoxkbMfX4added00'
const PAYMENT = 'cs_test_a1b2c3d4e5f6g7h8i9j0'
const INTENT = 'pi_3Q0a1b2c3d4e5f6g'
/** When the PaymentIntent was made, in Stripe's seconds. */
const CREATED = 1_793_000_000

/** A PaymentIntent in the shape of Stripe's own, held unless said otherwise. */
function intentBody(over: Record<string, unknown> = {}) {
  return { id: INTENT, object: 'payment_intent', amount: 500, amount_capturable: 500, capture_method: 'manual', created: CREATED, currency: 'usd', latest_charge: 'ch_3Q0a', metadata: { check: 'id' }, payment_method: 'pm_1', status: 'requires_capture', ...over }
}

/** A Checkout Session in the shape of Stripe's own, its PaymentIntent expanded: the payer's details, and much else the verifier never reads. */
function sessionBody(over: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    object: 'checkout.session',
    amount_total: 500,
    created: CREATED - 60,
    currency: 'usd',
    customer_details: { email: 'ada@example.com', name: 'Ada Lovelace', address: { country: 'GB', postal_code: 'W1' } },
    livemode: false,
    metadata: { check: 'id' },
    mode: 'payment',
    payment_intent: intentBody(),
    payment_status: 'unpaid',
    status: 'complete',
    url: null,
    ...over,
  }
}

/** Stripe refusing to capture or cancel a PaymentIntent in another state: its error carries the PaymentIntent. */
const unexpected = (status: string): [number, unknown] => [400, { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: `This PaymentIntent could not be captured because it has a status of ${status}.`, payment_intent: intentBody({ status }) } }]

type Seen = { method: string; url: string; auth: string | undefined; type: string | undefined; version: string | undefined; body: string }
const seen: Seen[] = []
let reply: (req: IncomingMessage) => [number, unknown] = () => [500, {}]
let base = ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, type: req.headers['content-type'], version: req.headers['stripe-version'] as string | undefined, body })
    const [status, json] = reply(req)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof json === 'string' ? json : JSON.stringify(json))
  })
})

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const client = () => new StripeClient({ secretKey: KEY, publishableKey: PUBLISHABLE_KEY, price: PRICE, addedPrice: ADDED_PRICE, baseUrl: base + '/' })

/** The API version the client is written for: a literal here, so moving it is a change made on purpose. */
const VERSION = '2026-10-28.endive'

/** A Price in the shape of Stripe's own: one-time, in US dollars. */
function priceBody(id: string, over: Record<string, unknown> = {}) {
  return { id, object: 'price', active: true, billing_scheme: 'per_unit', currency: 'usd', livemode: false, product: 'prod_1', type: 'one_time', unit_amount: id === PRICE ? 500 : 200, unit_amount_decimal: id === PRICE ? '500' : '200', ...over }
}

test('the two Prices, each its amount in the currency’s smallest unit and its currency, as Stripe says them; one with no amount, or Stripe not answering, throws', async () => {
  seen.length = 0
  reply = (req) => [200, priceBody(req.url!.split('/').at(-1)!)]
  assert.deepEqual(await client().prices(), { price: { amount: 500, currency: 'usd' }, addedPrice: { amount: 200, currency: 'usd' } })
  assert.deepEqual(seen.map((r) => [r.method, r.url, r.auth, r.version]), [['GET', `/v1/prices/${PRICE}`, `Bearer ${KEY}`, VERSION], ['GET', `/v1/prices/${ADDED_PRICE}`, `Bearer ${KEY}`, VERSION]])

  // A Price with no amount of its own (tiered, or the customer's choice), or not a Price at all.
  for (const over of [{ unit_amount: null }, { unit_amount: 2.5 }, { currency: 'USD' }, { currency: undefined }]) {
    reply = (req) => [200, priceBody(req.url!.split('/').at(-1)!, over)]
    await assert.rejects(client().prices(), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe answered a price without an amount and a currency', JSON.stringify(over))
  }
  reply = () => [404, { error: { type: 'invalid_request_error', code: 'resource_missing', param: 'price', message: 'No such price' } }]
  await assert.rejects(client().prices(), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe answered 404 to a price' && JSON.stringify((error as PaymentUnavailable).codes) === '["invalid_request_error","resource_missing","price"]')
})

test('a Checkout page for one of a Price that only holds the money, saying so by its Pay button, naming no payment method, marked as the verifier’s, its PaymentIntent too, back to the app either way, on its API version', async () => {
  seen.length = 0
  const url = `https://checkout.stripe.com/c/pay/${PAYMENT}#fidkdWxOYHwnPyd1blpxYHZxWjA0`
  reply = () => [200, sessionBody({ payment_status: 'unpaid', status: 'open', url })]
  assert.deepEqual(await client().checkout('https://app.example/paid?for=id', false), { payment: PAYMENT, url })
  assert.deepEqual(await client().checkout('https://app.example/paid?for=id', true), { payment: PAYMENT, url })

  const [made, added] = seen
  assert.deepEqual([made!.method, made!.url, made!.auth, made!.type, made!.version], ['POST', '/v1/checkout/sessions', `Bearer ${KEY}`, 'application/x-www-form-urlencoded', VERSION])
  assert.equal(new URLSearchParams(added!.body).get('line_items[0][price]'), ADDED_PRICE, 'for an added ID, the added-ID Price')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(made!.body)), {
    mode: 'payment',
    'line_items[0][price]': PRICE,
    'line_items[0][quantity]': '1',
    'custom_text[submit][message]': PAGE_TEXT,
    success_url: 'https://app.example/paid?for=id',
    cancel_url: 'https://app.example/paid?for=id',
    'metadata[check]': 'id',
    'payment_intent_data[capture_method]': 'manual',
    'payment_intent_data[metadata][check]': 'id',
  }, 'no payment method, which the key’s settings at Stripe choose; nothing of the person: no email, no stamp number, no session')

  for (const answer of [sessionBody({ url: null }), sessionBody({ id: 'pi_3Mtw', url }), 'not json']) {
    reply = () => [200, answer]
    await assert.rejects(client().checkout('https://app.example/', false), PaymentUnavailable)
  }

  // A refusal: its status, and its error's type, code and param, as Stripe sent them; never its message.
  const message = 'The `payment_method_types` parameter is no longer supported when creating a Checkout Session. Payment methods are now managed from your Dashboard settings.'
  reply = () => [400, { error: { type: 'invalid_request_error', code: 'payment_method_types_no_longer_supported', param: 'payment_method_types', message, doc_url: 'https://docs.stripe.com/error-codes', request_log_url: 'https://dashboard.stripe.com/test/logs/req_x' } }]
  await assert.rejects(client().checkout('https://app.example/', false), (error: Error) => {
    assert.ok(error instanceof PaymentUnavailable)
    assert.equal(error.message, 'Stripe answered 400 to a new payment')
    assert.equal(error.status, 400)
    assert.deepEqual(error.codes, ['invalid_request_error', 'payment_method_types_no_longer_supported', 'payment_method_types'])
    assert.ok(!JSON.stringify(error).includes('Dashboard') && !error.message.includes('Dashboard'), 'not its message')
    return true
  })
  reply = () => [400, { error: { type: 'invalid_request_error', message: 'No such price' } }]
  await assert.rejects(client().checkout('https://app.example/', false), (error: Error) => error instanceof PaymentUnavailable && error.status === 400 && JSON.stringify(error.codes) === '["invalid_request_error"]')
  // No JSON: the status alone.
  reply = () => [502, '<html>Bad gateway</html>']
  await assert.rejects(client().checkout('https://app.example/', false), (error: Error) => error instanceof PaymentUnavailable && error.status === 502 && error.codes.length === 0)
})

test('a Checkout page to embed: the same Price, mark, hold and Pay-button text, on an embedded page that never sends the person anywhere, answered by its client secret, not a page', async () => {
  seen.length = 0
  const clientSecret = `${PAYMENT}_secret_a1b2c3d4e5f6`
  reply = () => [200, sessionBody({ payment_status: 'unpaid', status: 'open', ui_mode: 'embedded_page', url: null, client_secret: clientSecret })]
  assert.deepEqual(await client().checkout(undefined, false), { payment: PAYMENT, clientSecret })
  assert.deepEqual(await client().checkout(undefined, true), { payment: PAYMENT, clientSecret })

  const [made, added] = seen
  assert.deepEqual([made!.method, made!.url, made!.auth, made!.type, made!.version], ['POST', '/v1/checkout/sessions', `Bearer ${KEY}`, 'application/x-www-form-urlencoded', VERSION])
  assert.equal(new URLSearchParams(added!.body).get('line_items[0][price]'), ADDED_PRICE, 'for an added ID, the added-ID Price')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(made!.body)), {
    mode: 'payment',
    'line_items[0][price]': PRICE,
    'line_items[0][quantity]': '1',
    'custom_text[submit][message]': PAGE_TEXT,
    ui_mode: 'embedded_page',
    redirect_on_completion: 'never',
    'metadata[check]': 'id',
    'payment_intent_data[capture_method]': 'manual',
    'payment_intent_data[metadata][check]': 'id',
  }, 'the hosted page’s fields, with no address to send the person back to')

  // A page alone is no answer for one to embed, nor a client secret for Stripe's own page.
  for (const answer of [sessionBody({ url: 'https://checkout.stripe.com/c/pay/x', client_secret: null }), sessionBody({ url: null, client_secret: 'not one' }), sessionBody({ id: 'pi_3Mtw', url: null, client_secret: clientSecret })]) {
    reply = () => [200, answer]
    await assert.rejects(client().checkout(undefined, false), PaymentUnavailable, JSON.stringify(answer))
  }
  reply = () => [200, sessionBody({ url: null, client_secret: clientSecret })]
  await assert.rejects(client().checkout('https://app.example/', false), PaymentUnavailable)
  assert.equal(client().publishableKey, PUBLISHABLE_KEY, 'the publishable key, for the payment page')
})

test('held: a session the verifier made, complete, holding the money or having taken it, since its PaymentIntent was made; anything else is not, and Stripe not answering throws, naming no payment', async () => {
  seen.length = 0
  reply = () => [200, sessionBody()]
  assert.equal(await client().held(PAYMENT), CREATED * 1000)
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.auth, seen[0]!.version], ['GET', `/v1/checkout/sessions/${PAYMENT}?expand[]=payment_intent`, `Bearer ${KEY}`, VERSION])
  reply = () => [200, sessionBody({ payment_status: 'paid', payment_intent: intentBody({ status: 'succeeded', capture_method: 'automatic' }) })]
  assert.equal(await client().held(PAYMENT), CREATED * 1000, 'taken in full, as before the ID check held its money')

  for (const over of [
    { status: 'open', payment_intent: null },
    { status: 'expired', payment_intent: null },
    { payment_intent: intentBody({ status: 'canceled' }) },
    { payment_intent: intentBody({ status: 'requires_payment_method' }) },
    { payment_intent: 'pi_3Q0a1b2c3d4e5f6g' },
    { payment_status: 'no_payment_required', payment_intent: null },
    { metadata: {} },
    { metadata: { check: 'face' } },
    { metadata: null },
  ]) {
    reply = () => [200, sessionBody(over)]
    assert.equal(await client().held(PAYMENT), null, JSON.stringify(over))
  }
  // One Stripe does not have, as a test-mode session is to a live key.
  reply = () => [404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }]
  assert.equal(await client().held(PAYMENT), null)

  for (const [status, answer] of [[401, { error: { type: 'invalid_request_error' } }], [500, {}], [200, 'not json']] as const) {
    reply = () => [status, answer]
    await assert.rejects(client().held(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && error.status === status && !error.message.includes(PAYMENT))
  }
  // A refusal of the key: its type, as Stripe sent it, and of its message, which shows the key's end, nothing.
  reply = () => [401, { error: { type: 'invalid_request_error', message: `Invalid API Key provided: sk_test_****${KEY.slice(-4)}` } }]
  await assert.rejects(client().held(PAYMENT), (error: Error) => {
    assert.ok(error instanceof PaymentUnavailable)
    assert.deepEqual([error.message, error.status, error.codes], ['Stripe answered 401 to a payment', 401, ['invalid_request_error']])
    assert.ok(!JSON.stringify(error).includes(KEY.slice(-4)))
    return true
  })
  const gone = new StripeClient({ secretKey: KEY, publishableKey: PUBLISHABLE_KEY, price: PRICE, addedPrice: ADDED_PRICE, baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(gone.held(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe could not be reached')
})

test('capture takes a held payment through its PaymentIntent; one taken before is taken, one cancelled is not', async () => {
  let intent: [number, unknown] = [200, intentBody({ status: 'succeeded', amount_capturable: 0, amount_received: 500 })]
  let session = sessionBody()
  reply = (req) => (req.url!.startsWith('/v1/checkout/') ? [200, session] : intent)
  seen.length = 0
  assert.equal(await client().capture(PAYMENT), true)
  assert.deepEqual(seen.map((r) => [r.method, r.url, r.auth, r.version]), [
    ['GET', `/v1/checkout/sessions/${PAYMENT}?expand[]=payment_intent`, `Bearer ${KEY}`, VERSION],
    ['POST', `/v1/payment_intents/${INTENT}/capture`, `Bearer ${KEY}`, VERSION],
  ])
  assert.equal(seen[1]!.body, '', 'the whole amount held')

  // Settled before: as Stripe's refusal says, or as the session says, with no capture asked.
  for (const [status, taken] of [['succeeded', true], ['canceled', false]] as const) {
    intent = unexpected(status)
    assert.equal(await client().capture(PAYMENT), taken, status)
  }
  seen.length = 0
  for (const [status, taken] of [['succeeded', true], ['canceled', false], ['requires_payment_method', false]] as const) {
    session = sessionBody({ payment_intent: intentBody({ status }) })
    assert.equal(await client().capture(PAYMENT), taken, status)
  }
  assert.equal(seen.filter((r) => r.method === 'POST').length, 0)
  session = sessionBody({ metadata: { check: 'face' } })
  assert.equal(await client().capture(PAYMENT), false, 'none of the verifier’s')

  // Anything else: Stripe failing, by its status and codes alone.
  session = sessionBody()
  for (const answer of [[402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }], [400, { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', payment_intent: intentBody({ status: 'processing' }) } }], [500, '<html/>']] as [number, unknown][]) {
    intent = answer
    await assert.rejects(client().capture(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe answered ' + answer[0] + ' to a capture' && !JSON.stringify(error).includes('insufficient funds'))
  }
})

test('cancel cancels a held payment; one taken or cancelled already is left as it is', async () => {
  let intent: [number, unknown] = [200, intentBody({ status: 'canceled', cancellation_reason: null })]
  let session = sessionBody()
  reply = (req) => (req.url!.startsWith('/v1/checkout/') ? [200, session] : intent)
  seen.length = 0
  await client().cancel(PAYMENT)
  assert.deepEqual(seen.map((r) => [r.method, r.url]), [['GET', `/v1/checkout/sessions/${PAYMENT}?expand[]=payment_intent`], ['POST', `/v1/payment_intents/${INTENT}/cancel`]])
  for (const status of ['succeeded', 'canceled']) {
    intent = unexpected(status)
    await client().cancel(PAYMENT)
  }
  seen.length = 0
  for (const over of [{ payment_intent: intentBody({ status: 'succeeded' }) }, { payment_intent: null }, { metadata: {} }]) {
    session = sessionBody(over)
    await client().cancel(PAYMENT)
  }
  assert.equal(seen.filter((r) => r.method === 'POST').length, 0, 'nothing to cancel')
  session = sessionBody()
  intent = [500, {}]
  await assert.rejects(client().cancel(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe answered 500 to a cancel')
})

test('cancelOld searches Stripe for the verifier’s holds made before a time, page by page, and cancels each still held by its own status', async () => {
  const before = (CREATED + 3600) * 1000
  const old = (id: string, over: Record<string, unknown> = {}) => intentBody({ id, ...over })
  const pages: Record<string, unknown> = {
    first: { object: 'search_result', data: [old('pi_old1'), old('pi_lagging', { status: 'succeeded' }), old('pi_other', { metadata: { check: 'face' } })], has_more: true, next_page: 'page_2' },
    page_2: { object: 'search_result', data: [old('pi_old2'), old('pi_refused')], has_more: false, next_page: null },
  }
  reply = (req) => {
    const url = new URL(req.url!, base)
    if (url.pathname === '/v1/payment_intents/search') return [200, pages[url.searchParams.get('page') ?? 'first']]
    if (url.pathname === '/v1/payment_intents/pi_refused/cancel') return [500, { error: { type: 'api_error' } }]
    if (url.pathname === '/v1/payment_intents/pi_old2/cancel') return unexpected('canceled')
    return [200, old(url.pathname.split('/')[3]!, { status: 'canceled' })]
  }
  seen.length = 0
  const outcome = await client().cancelOld(before)
  assert.deepEqual({ ...outcome, error: outcome.error instanceof PaymentUnavailable }, { cancelled: 1, failed: 1, error: true })
  const searches = seen.filter((r) => r.url.startsWith('/v1/payment_intents/search'))
  assert.equal(searches.length, 2)
  const first = new URL(searches[0]!.url, base).searchParams
  assert.deepEqual(Object.fromEntries(first), { query: `status:'requires_capture' AND metadata['check']:'id' AND created<${CREATED + 3600}`, limit: '100' })
  assert.equal(new URL(searches[1]!.url, base).searchParams.get('page'), 'page_2')
  assert.deepEqual(seen.filter((r) => r.method === 'POST').map((r) => r.url), ['/v1/payment_intents/pi_old1/cancel', '/v1/payment_intents/pi_old2/cancel', '/v1/payment_intents/pi_refused/cancel'], 'never one the search lagged on, or none of the verifier’s')

  for (const answer of [[400, { error: { type: 'invalid_request_error', code: 'search_unavailable' } }], [200, { object: 'search_result' }]] as [number, unknown][]) {
    reply = () => answer
    await assert.rejects(client().cancelOld(before), PaymentUnavailable)
  }
})
