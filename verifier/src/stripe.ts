// The ID check's payment: Stripe's API, and what the verifier asks of it.
//
// The ID check's price is held on a Stripe Checkout page the verifier makes, and taken only when the
// check gives a new ID stamp: the Price `STRIPE_ID_PRICE` names for a stamp number that holds no ID
// stamp, the one `STRIPE_ADDED_ID_PRICE` names for one that holds one. The verifier asks Stripe what
// each Price is (`prices`: its amount and currency, for `GET /`); to make a Checkout Session for one
// of a Price whose PaymentIntent is captured by hand (`payment_intent_data[capture_method]=manual`),
// so paying only holds the money, with PAGE_TEXT by its Pay button: Stripe's own page, which sends
// the person back to the app, or, with no page to send them back to, one embedded in the verifier's
// payment page (page.ts), which never sends them anywhere; later, whether a session it made
// holds the money, and since when; to take it (capture); to cancel it; and, every hour, for the holds
// it made long ago, to cancel them. From a session it reads its id, its
// page's address, the mark the verifier gave it and its PaymentIntent (`metadata.check`, on both, so a
// payment made with the same key for anything else opens no ID check and its hold is never touched),
// and of that PaymentIntent its id, its status and when it was made. Everything else Stripe answers,
// the payer's email, name and what they paid with among it, is dropped the moment the answer is
// parsed.
//
// No webhook, and nothing of a payment kept but its hash (store.ts): the app holds the session's id
// from the moment the session is made, and sends it each time, so the verifier finds the hold through
// it; and Stripe itself keeps every hold, so the hourly search finds the old ones by their mark.
// Stripe sends the person back to the app's page as it is, paid or not, with no id in its address:
// the id stays in the app, and out of every log of addresses. An embedded session's client secret,
// which Stripe's script on the payment page mounts it with, goes to the app in the answer and no
// further: it is never logged, and the app puts it after the page's `#`, which no browser sends.
//
// It names no payment method: the key's payment method settings at Stripe choose them, among those
// that can hold money. A card's hold usually lasts 7 days; the verifier cancels each after two.
//
// Stripe's API as its documents give it (docs.stripe.com, Prices, Checkout Sessions and their custom
// text, PaymentIntents, placing a hold, and search, API version STRIPE_VERSION): form-encoded, the key
// as a Bearer token; `GET /v1/prices/{id}`, its `unit_amount` in the currency's smallest unit and its
// `currency`, lower case; `POST /v1/checkout/sessions`, `custom_text[submit][message]` the text above
// its Pay button, `ui_mode=embedded_page` with `redirect_on_completion=never` for one embedded with
// no page to return to (which leaves out the payment methods that send a person to another page),
// answering its `client_secret` instead of its `url`;
// `GET /v1/checkout/sessions/{id}?expand[]=payment_intent`, a 404 for a session Stripe does not
// have, as one made in test mode is to a live key; `POST /v1/payment_intents/{id}/capture` and `/cancel`; `GET /v1/payment_intents/search`, whose
// results can lag a minute behind, so each one's own status is checked before it is cancelled. A
// held PaymentIntent is `requires_capture`, a taken one `succeeded`, a cancelled one `canceled`. This
// needs the key's Prices: Read, Checkout Sessions: Write and PaymentIntents: Write, and nothing else. A refusal is
// `{error: {type, code, param, message, payment_intent}}`: the thrown error keeps its status, type,
// code and param, for the log line (server.ts), and never its message; a capture or a cancel refused
// for a PaymentIntent already taken or cancelled is read by that PaymentIntent's status.

/**
 * The Stripe API version this code and its stand-in (test/stripe.test.ts) follow, sent with every
 * request, so a new default version at Stripe changes nothing here. Moving it is a change here, with
 * its test.
 */
export const STRIPE_VERSION = '2026-10-28.endive'

/** A Stripe Checkout Session's id, which is the payment's id here: `cs_test_…` or `cs_live_…`. */
export const PAYMENT = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/

/** The mark each Checkout Session the verifier makes, and its PaymentIntent, carries, as its `metadata[check]`. */
const MARK = 'id'

/** What Stripe's page says above its Pay button: the hold is taken only for a stamp. README.md quotes it. */
export const PAGE_TEXT = 'You are charged only if the check passes.'

/** A new payment: its Checkout Session's id, and Stripe's page to send the person to, or the client secret Stripe's script mounts an embedded one with. */
export type Checkout = { payment: string; url: string } | { payment: string; clientSecret: string }

/** A Price, as Stripe gives it: its amount, in the currency's smallest unit (500 for $5), and its currency, lower case (`usd`). */
export type Price = { amount: number; currency: string }

/** The ID check's two prices: `price` for a stamp number that holds no ID stamp, `addedPrice` for one that holds one. */
export type Prices = { price: Price; addedPrice: Price }

export interface Payments {
  /** Whether its key is a test key, `sk_test_…` or `rk_test_…`: its payments take only Stripe's test cards, and charge nobody. */
  readonly test: boolean
  /** The key's publishable key, `pk_…`, which Stripe's script on the payment page (page.ts) runs with: public. */
  readonly publishableKey: string
  /** What the two Prices are. Throws if Stripe can't answer, or answers a Price with no amount. */
  prices(): Promise<Prices>
  /**
   * A Checkout page for one ID check, at the added-ID Price when `added`: Stripe's own, sending the
   * person back to `returnUrl`, its id and the page; or, with no `returnUrl`, one to embed, which
   * sends the person nowhere, its id and its client secret.
   */
  checkout(returnUrl: string | undefined, added: boolean): Promise<Checkout>
  /**
   * When this payment's money was held, in milliseconds: when its PaymentIntent was made, if the
   * verifier made it and it holds the money or took it in full; null for anything else, or one Stripe
   * does not have. Throws if Stripe can't answer.
   */
  held(payment: string): Promise<number | null>
  /** Takes the held money: true once it is taken, now or before; false when the hold was cancelled. Throws if Stripe can't answer. */
  capture(payment: string): Promise<boolean>
  /** Cancels the hold; nothing to do once it is taken or cancelled. Throws if Stripe can't answer. */
  cancel(payment: string): Promise<void>
  /**
   * Cancels each hold the verifier made before `before` (milliseconds) that still holds the money: how
   * many it cancelled, how many Stripe would not, and why the last would not. Throws if Stripe can't answer the search.
   */
  cancelOld(before: number): Promise<{ cancelled: number; failed: number; error?: unknown }>
}

/**
 * Stripe could not be asked, refused, or answered something other than a Checkout Session. Its
 * message names no payment. With an answer, its HTTP status; with a refusal, its error's `type`,
 * `code` and `param`, as Stripe sent them.
 */
export class PaymentUnavailable extends Error {
  readonly status: number | undefined
  readonly codes: unknown[]
  constructor(message: string, answer?: { status: number; codes?: unknown[] }) {
    super(message)
    this.status = answer?.status
    this.codes = answer?.codes ?? []
  }
}

const object = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

async function body(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return object(await res.json())
  } catch {
    throw new PaymentUnavailable('Stripe answered something that is not JSON', { status: res.status })
  }
}

/** A refusal's error: what it says, or nothing for an answer that is not JSON. */
async function errorOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return object(object(await res.json())?.error) ?? {}
  } catch {
    // No JSON: the status alone says why.
    return {}
  }
}

/** Stripe refused `what`: its status, and its error's type, code and param. Its message is dropped. */
function refused(status: number, error: Record<string, unknown>, what: string): PaymentUnavailable {
  const codes = [error.type, error.code, error.param].filter((code) => code !== undefined)
  return new PaymentUnavailable(`Stripe answered ${status} to ${what}`, { status, codes })
}

/** What the verifier reads of a PaymentIntent: its id, its status, and when it was made, in milliseconds. */
type Intent = { id: string; status: string; created: number }

function intentOf(value: unknown): Intent | null {
  const json = object(value)
  if (typeof json?.id !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(json.id) || typeof json.status !== 'string' || typeof json.created !== 'number') return null
  return { id: json.id, status: json.status, created: json.created * 1000 }
}

/** What taking or letting go of a hold came to: done, or already settled one way or the other. */
type Settled = 'done' | 'succeeded' | 'canceled'

export class StripeClient implements Payments {
  readonly test: boolean
  readonly publishableKey: string
  readonly #secretKey: string
  readonly #price: string
  readonly #addedPrice: string
  readonly #baseUrl: string

  /** `baseUrl` is for tests, against a stand-in on this machine; it is no setting. */
  constructor(options: { secretKey: string; publishableKey: string; price: string; addedPrice: string; baseUrl?: string }) {
    this.test = /^(sk|rk)_test_/.test(options.secretKey)
    this.publishableKey = options.publishableKey
    this.#secretKey = options.secretKey
    this.#price = options.price
    this.#addedPrice = options.addedPrice
    this.#baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  }

  async prices(): Promise<Prices> {
    return { price: await this.#priceOf(this.#price), addedPrice: await this.#priceOf(this.#addedPrice) }
  }

  /**
   * Back to `returnUrl` paid or not: the app asks the verifier which. Embedded, with no `returnUrl`,
   * the person stays on the page, and the app is told only that they are done (page.ts). Paying only
   * holds the money.
   */
  async checkout(returnUrl: string | undefined, added: boolean): Promise<Checkout> {
    const page: Record<string, string> = returnUrl === undefined ? { ui_mode: 'embedded_page', redirect_on_completion: 'never' } : { success_url: returnUrl, cancel_url: returnUrl }
    const res = await this.#fetch('/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mode: 'payment',
        'line_items[0][price]': added ? this.#addedPrice : this.#price,
        'line_items[0][quantity]': '1',
        'custom_text[submit][message]': PAGE_TEXT,
        ...page,
        'metadata[check]': MARK,
        'payment_intent_data[capture_method]': 'manual',
        'payment_intent_data[metadata][check]': MARK,
      }).toString(),
    })
    if (!res.ok) throw refused(res.status, await errorOf(res), 'a new payment')
    const json = await body(res)
    if (typeof json?.id !== 'string' || !PAYMENT.test(json.id)) throw new PaymentUnavailable('Stripe answered a new payment without an id or a page', { status: res.status })
    if (returnUrl !== undefined && typeof json.url === 'string') return { payment: json.id, url: json.url }
    // A Checkout Session's client secret starts as its id does.
    if (returnUrl === undefined && typeof json.client_secret === 'string' && /^cs_(test|live)_\S+$/.test(json.client_secret)) return { payment: json.id, clientSecret: json.client_secret }
    throw new PaymentUnavailable('Stripe answered a new payment without an id or a page', { status: res.status })
  }

  /** A held payment, or one taken in full, as one made before the ID check held its money was. */
  async held(payment: string): Promise<number | null> {
    const found = await this.#session(payment)
    if (!found) return null
    const { session, intent } = found
    if (session.status !== 'complete' || !intent) return null
    return intent.status === 'requires_capture' || session.payment_status === 'paid' ? intent.created : null
  }

  async capture(payment: string): Promise<boolean> {
    const intent = (await this.#session(payment))?.intent
    if (!intent || intent.status === 'canceled') return false
    if (intent.status === 'succeeded') return true
    if (intent.status !== 'requires_capture') return false
    return (await this.#settle(intent.id, 'capture')) !== 'canceled'
  }

  async cancel(payment: string): Promise<void> {
    const intent = (await this.#session(payment))?.intent
    if (intent?.status === 'requires_capture') await this.#settle(intent.id, 'cancel')
  }

  async cancelOld(before: number): Promise<{ cancelled: number; failed: number; error?: unknown }> {
    const query = `status:'requires_capture' AND metadata['check']:'${MARK}' AND created<${Math.floor(before / 1000)}`
    const outcome: { cancelled: number; failed: number; error?: unknown } = { cancelled: 0, failed: 0 }
    let page: string | undefined
    do {
      const params = new URLSearchParams({ query, limit: '100', ...(page && { page }) })
      const res = await this.#fetch(`/v1/payment_intents/search?${params}`, { method: 'GET' })
      if (!res.ok) throw refused(res.status, await errorOf(res), 'a search')
      const json = await body(res)
      if (!Array.isArray(json?.data)) throw new PaymentUnavailable('Stripe answered a search without its results', { status: res.status })
      for (const found of json.data) {
        // The search can lag behind: only a hold still held, by its own status, is cancelled.
        const intent = intentOf(found)
        if (intent?.status !== 'requires_capture' || object(object(found)?.metadata)?.check !== MARK) continue
        try {
          if ((await this.#settle(intent.id, 'cancel')) === 'done') outcome.cancelled++
        } catch (error) {
          outcome.failed++
          outcome.error = error
        }
      }
      page = json.has_more === true && typeof json.next_page === 'string' ? json.next_page : undefined
    } while (page)
    return outcome
  }

  /** A Price's amount and currency. */
  async #priceOf(price: string): Promise<Price> {
    const res = await this.#fetch(`/v1/prices/${encodeURIComponent(price)}`, { method: 'GET' })
    if (!res.ok) throw refused(res.status, await errorOf(res), 'a price')
    const json = await body(res)
    const amount = json?.unit_amount
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || typeof json?.currency !== 'string' || !/^[a-z]{3}$/.test(json.currency)) {
      throw new PaymentUnavailable('Stripe answered a price without an amount and a currency', { status: res.status })
    }
    return { amount, currency: json.currency }
  }

  /** The Checkout Session, if the verifier made it, with its PaymentIntent; null for one Stripe does not have or that is not its. */
  async #session(payment: string): Promise<{ session: Record<string, unknown>; intent: Intent | null } | null> {
    const res = await this.#fetch(`/v1/checkout/sessions/${encodeURIComponent(payment)}?expand[]=payment_intent`, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw refused(res.status, await errorOf(res), 'a payment')
    const session = await body(res)
    if (!session) throw new PaymentUnavailable('Stripe answered a payment that is not one', { status: res.status })
    if (object(session.metadata)?.check !== MARK) return null
    return { session, intent: intentOf(session.payment_intent) }
  }

  /** Takes or cancels a hold: done, or how it was settled before, when Stripe refuses for that. */
  async #settle(intent: string, how: 'capture' | 'cancel'): Promise<Settled> {
    const res = await this.#fetch(`/v1/payment_intents/${encodeURIComponent(intent)}/${how}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
    if (res.ok) return 'done'
    const error = await errorOf(res)
    const status = object(error.payment_intent)?.status
    if (res.status === 400 && (status === 'succeeded' || status === 'canceled')) return status
    throw refused(res.status, error, how === 'capture' ? 'a capture' : 'a cancel')
  }

  async #fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.#baseUrl + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.#secretKey}`, 'stripe-version': STRIPE_VERSION },
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      // The network error may carry the URL, which carries the payment: it is not passed on.
      throw new PaymentUnavailable('Stripe could not be reached')
    }
  }
}
