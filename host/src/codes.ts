// The host's own codes, in one list: the plug's `invalid` and the front's, answered as
// `{"error": "<code>"}` by a credit route. The code answers none of its own that is not here (they
// take a `Code`), README.md's Its API says each, and test/readme.test.ts holds the two together. An
// app imports the list to say each code in its own words. It imports nothing, so an app in a
// browser imports it as it is. The rest of the plug's codes are the standard's checks, which the
// standard names, so none of them is copied here.

export const CODES = [
  // The plug's: a line that fails in a way none of the standard's codes names.
  'invalid',
  // The front's: a buy (credits/seller.ts), a spend and a balance (credits.ts), and any credit route
  // (host.ts).
  'not_a_buy',
  'too_many',
  'bad_payment',
  'not_paid',
  'bad_request',
  'credit',
  'spent',
  'method',
  'too_big',
] as const

/** One of the host's own codes. */
export type Code = (typeof CODES)[number]
