// README.md says what the code holds: the codes its Its API names that are this host's own, and not
// the standard's checks, are CODES. Each is read from the README as an app reads it: every code in
// backticks from Its API to How we run it. The standard's checks are the standard's own CODES,
// imported here, never copied.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CODES as STANDARD } from '@foundationforest/folders'

import { CODES } from '../src/codes.ts'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test("the host's own codes README.md's Its API names are CODES, each once, and none of them the standard's", () => {
  const standard = new Set<string>(STANDARD)
  const api = README.slice(README.indexOf('## Its API'), README.indexOf('## How we run it'))
  const own = [...api.matchAll(/`([a-z_]+)`/g)].map(([, code]) => code!).filter((code) => !standard.has(code))
  assert.equal(new Set(CODES).size, CODES.length, 'no code twice in the list')
  assert.deepEqual(new Set(own), new Set(CODES))
  assert.deepEqual(CODES.filter((code) => standard.has(code)), [], "none of the host's own codes is one of the standard's")
})
