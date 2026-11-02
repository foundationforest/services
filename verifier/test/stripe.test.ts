// The real Stripe client against a local stand-in that answers the way Stripe's documents say it does
// (Checkout Sessions, API v1). Nothing here reaches Stripe itself.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { PaymentUnavailable, StripeClient } from '../src/stripe.ts'

const KEY = 'sk_test_51standin'
const PRICE = 'price_1UXRbDILoxkbMfX4cfwRfCOI'
const PAYMENT = 'cs_test_a1b2c3d4e5f6g7h8i9j0'

/** A Checkout Session in the shape of Stripe's own: the payer's details, and much else the verifier never reads. */
function sessionBody(over: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    object: 'checkout.session',
    amount_total: 500,
    currency: 'usd',
    customer_details: { email: 'ada@example.com', name: 'Ada Lovelace', address: { country: 'GB', postal_code: 'W1' } },
    livemode: false,
    metadata: { check: 'id' },
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    url: null,
    ...over,
  }
}

type Seen = { method: string; url: string; auth: string | undefined; type: string | undefined; body: string }
const seen: Seen[] = []
let reply: (req: IncomingMessage) => [number, unknown] = () => [500, {}]
let base = ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, type: req.headers['content-type'], body })
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

const client = () => new StripeClient({ secretKey: KEY, price: PRICE, baseUrl: base + '/' })

test('a Checkout page for one of the Price, by Stripe’s card method and the wallets on it, marked as the verifier’s, back to the app either way', async () => {
  seen.length = 0
  const url = `https://checkout.stripe.com/c/pay/${PAYMENT}#fidkdWxOYHwnPyd1blpxYHZxWjA0`
  reply = () => [200, sessionBody({ payment_status: 'unpaid', status: 'open', url })]
  assert.deepEqual(await client().checkout('https://app.example/paid?for=id'), { payment: PAYMENT, url })

  const [made] = seen
  assert.deepEqual([made!.method, made!.url, made!.auth, made!.type], ['POST', '/v1/checkout/sessions', `Bearer ${KEY}`, 'application/x-www-form-urlencoded'])
  assert.deepEqual(Object.fromEntries(new URLSearchParams(made!.body)), {
    mode: 'payment',
    'line_items[0][price]': PRICE,
    'line_items[0][quantity]': '1',
    'payment_method_types[0]': 'card',
    success_url: 'https://app.example/paid?for=id',
    cancel_url: 'https://app.example/paid?for=id',
    'metadata[check]': 'id',
  }, 'nothing of the person: no email, no stamp number, no session')

  for (const answer of [sessionBody({ url: null }), sessionBody({ id: 'pi_3Mtw', url }), 'not json']) {
    reply = () => [200, answer]
    await assert.rejects(client().checkout('https://app.example/'), PaymentUnavailable)
  }
  reply = () => [400, { error: { type: 'invalid_request_error', message: 'No such price' } }]
  await assert.rejects(client().checkout('https://app.example/'), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe answered 400 to a new payment')
})

test('paid: a session the verifier made, its payment paid; anything else is not, and Stripe not answering throws, naming no payment', async () => {
  seen.length = 0
  reply = () => [200, sessionBody()]
  assert.equal(await client().paid(PAYMENT), true)
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.auth], ['GET', `/v1/checkout/sessions/${PAYMENT}`, `Bearer ${KEY}`])

  for (const over of [{ payment_status: 'unpaid', status: 'open' }, { payment_status: 'unpaid', status: 'expired' }, { payment_status: 'no_payment_required' }, { metadata: {} }, { metadata: { check: 'face' } }, { metadata: null }]) {
    reply = () => [200, sessionBody(over)]
    assert.equal(await client().paid(PAYMENT), false, JSON.stringify(over))
  }
  // One Stripe does not have, as a test-mode session is to a live key.
  reply = () => [404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }]
  assert.equal(await client().paid(PAYMENT), false)

  for (const [status, answer] of [[401, { error: { type: 'invalid_request_error' } }], [500, {}], [200, 'not json']] as const) {
    reply = () => [status, answer]
    await assert.rejects(client().paid(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && !error.message.includes(PAYMENT))
  }
  const gone = new StripeClient({ secretKey: KEY, price: PRICE, baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(gone.paid(PAYMENT), (error: Error) => error instanceof PaymentUnavailable && error.message === 'Stripe could not be reached')
})
