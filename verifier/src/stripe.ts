// The ID check's payment: Stripe's API, and what the verifier asks of it.
//
// The person pays for the ID check on a Stripe Checkout page the verifier makes, for the Price
// `STRIPE_ID_PRICE` names. The verifier asks Stripe two things: to make a Checkout Session for one of
// that Price, and, when the app comes back with the session's id, whether it was paid. From a session
// it reads its id, its page's address, whether it was paid, and the mark the verifier gave it
// (`metadata.check`), so a payment made with the same key for anything else opens no ID check.
// Everything else Stripe answers, the payer's email, name and what they paid with among it, is
// dropped the moment the answer is parsed.
//
// No webhook: the app holds the session's id from the moment the session is made, so it comes back
// with it whenever it likes, and nothing waits on Stripe's redirect. Stripe sends the person back to
// the app's page as it is, paid or not, with no id in its address: the id stays in the app, and out
// of every log of addresses.
//
// It names no payment method: the key's payment method settings at Stripe choose them. One that
// settles later leaves `payment_status` unpaid until it does, so the app gets `not_paid` till then.
//
// Stripe's API as its documents give it (docs.stripe.com, Checkout Sessions, API version
// STRIPE_VERSION): form-encoded, the key as a Bearer token; `POST /v1/checkout/sessions`, which needs
// the key's Checkout Sessions: Write and nothing else; `GET /v1/checkout/sessions/{id}`, a 404 for a
// session Stripe does not have, as one made in test mode is to a live key. A refusal is
// `{error: {type, code, param, message}}`: the thrown error keeps its status, type, code and param,
// for the log line (server.ts), and never its message.

/**
 * The Stripe API version this code and its stand-in (test/stripe.test.ts) follow, sent with every
 * request, so a new default version at Stripe changes nothing here. Moving it is a change here, with
 * its test.
 */
export const STRIPE_VERSION = '2026-10-28.endive'

/** A Stripe Checkout Session's id, which is the payment's id here: `cs_test_…` or `cs_live_…`. */
export const PAYMENT = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/

/** The mark each Checkout Session the verifier makes carries, as its `metadata[check]`. */
const MARK = 'id'

export interface Payments {
  /** A Checkout page for one ID check, sending the person back to `returnUrl`: the payment's id, and the page. */
  checkout(returnUrl: string): Promise<{ payment: string; url: string }>
  /** Whether the verifier made this Checkout Session and it was paid; false for one Stripe does not have. Throws if Stripe can't answer. */
  paid(payment: string): Promise<boolean>
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

async function body(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await res.json()
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null
  } catch {
    throw new PaymentUnavailable('Stripe answered something that is not JSON', { status: res.status })
  }
}

/** Stripe refused `what`: its status, and its error's type, code and param. Its message is dropped. */
async function refused(res: Response, what: string): Promise<PaymentUnavailable> {
  let error: Record<string, unknown> = {}
  try {
    const json = (await res.json()) as { error?: unknown } | null
    if (typeof json?.error === 'object' && json.error !== null) error = json.error as Record<string, unknown>
  } catch {
    // No JSON: the status alone says why.
  }
  const codes = [error.type, error.code, error.param].filter((code) => code !== undefined)
  return new PaymentUnavailable(`Stripe answered ${res.status} to ${what}`, { status: res.status, codes })
}

export class StripeClient implements Payments {
  readonly #secretKey: string
  readonly #price: string
  readonly #baseUrl: string

  /** `baseUrl` is for tests, against a stand-in on this machine; it is no setting. */
  constructor(options: { secretKey: string; price: string; baseUrl?: string }) {
    this.#secretKey = options.secretKey
    this.#price = options.price
    this.#baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  }

  /** Back to `returnUrl` paid or not: the app asks the verifier which. */
  async checkout(returnUrl: string): Promise<{ payment: string; url: string }> {
    const res = await this.#fetch('/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mode: 'payment',
        'line_items[0][price]': this.#price,
        'line_items[0][quantity]': '1',
        success_url: returnUrl,
        cancel_url: returnUrl,
        'metadata[check]': MARK,
      }).toString(),
    })
    if (!res.ok) throw await refused(res, 'a new payment')
    const json = await body(res)
    if (typeof json?.id !== 'string' || !PAYMENT.test(json.id) || typeof json.url !== 'string') {
      throw new PaymentUnavailable('Stripe answered a new payment without an id or a page', { status: res.status })
    }
    return { payment: json.id, url: json.url }
  }

  async paid(payment: string): Promise<boolean> {
    const res = await this.#fetch(`/v1/checkout/sessions/${encodeURIComponent(payment)}`, { method: 'GET' })
    if (res.status === 404) return false
    if (!res.ok) throw await refused(res, 'a payment')
    const json = await body(res)
    const metadata = json?.metadata as Record<string, unknown> | null | undefined
    return json?.payment_status === 'paid' && metadata?.check === MARK
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
