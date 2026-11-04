// Every code the verifier answers, as `{"error": "<code>"}`, in one list: the server answers none
// that is not here (its errors take a `Code`), README.md's Its API says each, and
// test/readme.test.ts holds the two together. An app imports the list to say each code in its own
// words. It imports nothing, so an app in a browser imports it as it is. A gift's own `bad_gift`
// and `given` are not here: they ride inside a stamp's answer, in its `gift`, not as its error.

export const CODES = [
  // 400: a body the route does not take
  'not_json',
  'not_an_object',
  'expected_empty_body',
  'expected_exactly_returnUrl',
  'expected_exactly_payment',
  'expected_exactly_payment_and_returnUrl',
  'expected_exactly_sessionId_and_stampNumber',
  'expected_exactly_sessionId_and_stampNumber_and_payment',
  'expected_exactly_stampNumber',
  'bad_session_id',
  'bad_stamp_number',
  'bad_return_url',
  'bad_payment',
  // 402
  'not_paid',
  // 403: the check does not count
  'unknown_session',
  'wrong_workflow',
  'declined',
  'expired',
  'not_approved',
  'no_liveness',
  'liveness_not_passed',
  'no_document',
  'document_not_passed',
  'no_face_match',
  'face_match_not_passed',
  'no_face',
  'no_document_data',
  'duplicate_document',
  // 409
  'session_used',
  'payment_used',
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
