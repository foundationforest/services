// Every code the verifier answers, as `{"error": "<code>"}`, in one list: the server answers none
// that is not here (its errors take a `Code`), README.md's Its API says each, and
// test/readme.test.ts holds the two together. An app imports the list to say each code in its own
// words. It imports nothing, so an app in a browser imports it as it is. A gift's own `bad_gift`
// and `given` are not here: they ride inside a stamp's answer, in its `gift`, not as its error.
// PAYMENT_DONE, below the list, is no error: it is the one message the payment page posts.

export const CODES = [
  // 400: a body the route does not take
  'not_json',
  'not_an_object',
  'expected_exactly_stampNumber',
  'expected_exactly_stampNumber_and_returnUrl',
  'expected_exactly_payment',
  'expected_exactly_payment_and_returnUrl',
  'expected_exactly_sessionId_and_stampNumber',
  'expected_exactly_sessionId_and_stampNumber_and_payment',
  'bad_session_id',
  'bad_stamp_number',
  'bad_return_url',
  'bad_payment',
  // 402
  'not_paid',
  // 403: the check does not count. Didit's refusal, the first that applies in this order
  // (didit.ts's REASONS), and then a session not the verifier's to judge, or one unfinished
  'known_person',
  'known_face',
  'face_mismatch',
  'id_unclear',
  'face_unclear',
  'other',
  'unknown_session',
  'wrong_workflow',
  'expired',
  'not_approved',
  // 409
  'session_used',
  'payment_used',
  'face_tries_used',
  // 404, 405, 413, 502, 503, 500
  'not_found',
  'post_only',
  'get_only',
  'too_large',
  'face_check_unavailable',
  'payment_unavailable',
  'not_for_sale',
  'internal',
] as const

/** One of the verifier's codes. */
export type Code = (typeof CODES)[number]

/**
 * The one message the payment page (`GET /id/pay`, page.ts) posts to the app around it, once the
 * person has paid on it: all Stripe's hosted page tells the app by sending the person back, which is
 * nothing but that they are done. The app then sends `POST /id/session` with the payment it holds,
 * and the verifier asks Stripe whether the money is held.
 */
export const PAYMENT_DONE = 'payment_done'
