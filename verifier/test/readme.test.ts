// README.md says what the code holds: its consent screen is the text GET / serves (CONSENT), and the
// codes its Its API lists are the server's (CODES). Each is read from the README as an app reads it:
// the paragraph after **The consent screen.**, and every code in backticks from where errors are
// named to How we run it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CODES } from '../src/codes.ts'
import { CONSENT } from '../src/service.ts'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('the consent screen in README.md is the text GET / serves, word for word', () => {
  const block = README.slice(README.indexOf('**The consent screen.**')).split('\n\n')[1]!
  assert.match(block, /^> /, 'a quote, right after its heading')
  assert.equal(block.split('\n').map((line) => line.replace(/^> /, '')).join(' '), CONSENT)
})

test("the codes README.md's Its API lists are CODES, each once", () => {
  const errors = README.slice(README.indexOf('Errors are `{"error": "<code>"}`'), README.indexOf('## How we run it'))
  const listed = [...errors.matchAll(/`(?:\d{3} )?([a-zA-Z_]+)`/g)].map(([, code]) => code!)
  assert.equal(new Set(CODES).size, CODES.length, 'no code twice in the list')
  assert.deepEqual(new Set(listed), new Set(CODES))
})
