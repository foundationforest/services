// README.md says what the code holds: its consent screens are the texts GET / serves (FACE_CONSENT and
// CONSENT), and so are the line the person ticks (AGREE) and the right to cancel (CANCEL_RIGHT); the
// codes its Its API lists are the server's (CODES); and what Stripe's page says by its Pay button is
// PAGE_TEXT. Each is read from the README as an app reads it: the quote after each heading, every
// code in backticks from where errors are named to How we run it, and the quote after **By the Pay
// button.**

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CODES } from '../src/codes.ts'
import { AGREE, CANCEL_RIGHT, CONSENT, FACE_CONSENT } from '../src/service.ts'
import { PAGE_TEXT } from '../src/stripe.ts'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** The quote right after a heading in README.md, one line however it wraps. */
function quoteAfter(heading: string): string {
  const block = README.slice(README.indexOf(heading)).split('\n\n')[1]!
  assert.match(block, /^> /, `a quote, right after ${heading}`)
  return block.split('\n').map((line) => line.replace(/^> /, '')).join(' ')
}

test('the consent screens, the line the person ticks and the right to cancel in README.md are what GET / serves, word for word', () => {
  assert.equal(quoteAfter("**The face check's consent screen.**"), FACE_CONSENT)
  assert.equal(quoteAfter("**The ID check's consent screen.**"), CONSENT)
  assert.equal(quoteAfter('**The line the person ticks.**'), AGREE)
  assert.equal(quoteAfter('**The right to cancel.**'), CANCEL_RIGHT)
})

test("the codes README.md's Its API lists are CODES, each once", () => {
  const errors = README.slice(README.indexOf('Errors are `{"error": "<code>"}`'), README.indexOf('## How we run it'))
  const listed = [...errors.matchAll(/`(?:\d{3} )?([a-zA-Z_]+)`/g)].map(([, code]) => code!)
  assert.equal(new Set(CODES).size, CODES.length, 'no code twice in the list')
  assert.deepEqual(new Set(listed), new Set(CODES))
})

test("the text README.md says Stripe's page shows by its Pay button is the one the verifier sends", () => {
  const after = README.slice(README.indexOf('**By the Pay button.**'))
  assert.equal(/"([^"]+)"/.exec(after)?.[1], PAGE_TEXT)
})
