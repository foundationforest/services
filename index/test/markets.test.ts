// Reading the markets this index uses from the markets repo: its `directory.md` and each named
// market's file. No aliases: a market is its one name. No network: the repo is a map of paths to
// texts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Directory, parseDirectory } from '../src/markets.ts'
import { MARKETS_FOLDER, serveMarkets } from './markets-repo.ts'

const BASE = 'https://markets.test/main'
const list = (...markets: string[]) => ({ directory: BASE, markets })
const tutors = readFileSync(join(MARKETS_FOLDER, 'freelance-work/online-tutors.json'), 'utf8')
const exchange = readFileSync(join(MARKETS_FOLDER, 'learning/language-exchange.json'), 'utf8')
const plumbing = JSON.stringify({ ...JSON.parse(tutors), name: 'plumbing', folder: 'home-services', offerFields: {}, roleNames: undefined })

// The markets repo's own layout: a line per market under its folder, and other sections whose
// bullets link nothing.
const md = (lines: string) => `# Directory

## home-services

- [\`plumbing\`](home-services/plumbing.json): Pipes, taps, drains.

## freelance-work

${lines}

## Scopes

- The roles come from the market's sides.
`

function repo(files: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const path = url.slice(BASE.length + 1)
    return path in files ? new Response(files[path]) : new Response('404: Not Found', { status: 404 })
  }) as typeof fetch
}

test('the markets the list names, each read through its line in the directory, and nothing else', async () => {
  const text = md('- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.')
  assert.deepEqual(parseDirectory(text), [
    { name: 'plumbing', path: 'home-services/plumbing.json' },
    { name: 'online-tutors', path: 'freelance-work/online-tutors.json' },
  ])
  const files = repo({ 'directory.md': text, 'home-services/plumbing.json': plumbing, 'freelance-work/online-tutors.json': tutors })
  const d = await Directory.fetch(list('plumbing', 'online-tutors'), files)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors'])
  assert.deepEqual(d.refused, [])
  assert.deepEqual([...d.folders()], [['freelance-work', ['online-tutors']], ['home-services', ['plumbing']]])
  assert.equal(d.labelOf('plumber/seller'), null, 'no aliases: another spelling is another name, not a market here')
  assert.deepEqual(d.labelOf('plumbing/seller'), { market: 'plumbing', role: 'seller' })
  assert.equal(d.labelOf('plumbing'), null, 'a plain market counts for nothing')

  // A market the directory lists but the list does not name is no market here; one the list names
  // but the directory does not list is refused.
  const one = await Directory.fetch(list('online-tutors', 'stays'), files)
  assert.deepEqual([...one.markets.keys()], ['online-tutors'])
  assert.deepEqual(one.refused, [{ market: 'stays', errors: ['not in the directory'] }])
  assert.equal(one.labelOf('plumbing/seller'), null)
})

test('roles come from sides; role names are words for pages', async () => {
  const d = new Directory([
    { file: 'freelance-work/online-tutors.json', market: JSON.parse(tutors) },
    { file: 'learning/language-exchange.json', market: JSON.parse(exchange) },
  ])
  assert.deepEqual(d.markets.get('online-tutors')!.roles, ['seller', 'buyer'])
  assert.deepEqual(d.markets.get('language-exchange')!.roles, ['peer'])
  assert.deepEqual(d.labelOf('language-exchange/peer'), { market: 'language-exchange', role: 'peer' })
  assert.equal(d.labelOf('language-exchange/seller'), null, 'a one-sided market has no seller')
  assert.equal(d.labelOf('online-tutors/peer'), null, 'a two-sided market has no peer')
  assert.equal(d.labelOf('online-tutors/tutor'), null, 'a role name is not a role')
  assert.deepEqual([d.sideWord('online-tutors', 'seller'), d.sideWord('online-tutors', 'buyer')], ['tutor', 'student'])
  assert.deepEqual([d.sideWord('language-exchange', 'buyer'), d.sideWord(null, 'seller'), d.sideWord('nowhere', 'buyer')], ['buyer', 'seller', 'buyer'])
})

test('a file listed under another name, at another path, or not a market file is refused; the rest count', async () => {
  const d = await Directory.fetch(
    list('plumbing', 'online-tutoring', 'broken', 'bare', 'old', 'language-exchange'),
    repo({
      'directory.md': md(
        [
          '- [`online-tutoring`](freelance-work/online-tutors.json): Wrong name.',
          '- [`broken`](freelance-work/broken.json): Not JSON.',
          '- [`bare`](freelance-work/bare.json): Not a market file.',
          '- [`old`](freelance-work/old.json): The old keys.',
          '- [`language-exchange`](freelance-work/language-exchange.json): In another folder than its file says.',
        ].join('\n'),
      ),
      'home-services/plumbing.json': plumbing,
      'freelance-work/online-tutors.json': tutors,
      'freelance-work/broken.json': '{',
      'freelance-work/bare.json': JSON.stringify({ name: 'bare', folder: 'freelance-work' }),
      'freelance-work/old.json': JSON.stringify({ name: 'old', folder: 'freelance-work', category: 'freelance-work', fields: {}, evidenceTypes: [], credentialIssuers: [] }),
      'freelance-work/language-exchange.json': exchange,
    }),
  )
  assert.deepEqual([...d.markets.keys()], ['plumbing'])
  assert.deepEqual(d.refused.map((r) => r.market).sort(), ['bare', 'broken', 'language-exchange', 'old', 'online-tutoring'])
})

test('a file the directory links that cannot be fetched stops the load', async () => {
  await assert.rejects(
    Directory.fetch(list('online-tutors'), repo({ 'directory.md': md('- [`online-tutors`](freelance-work/online-tutors.json): Missing.'), 'home-services/plumbing.json': plumbing })),
    /freelance-work\/online-tutors\.json answered 404/,
  )
  await assert.rejects(Directory.fetch(list('plumbing'), repo({})), /directory\.md answered 404/)
})

test("the tests' own markets repo, over HTTP", async () => {
  const served = await serveMarkets()
  try {
    const d = await Directory.fetch({ directory: served.url, markets: ['online-tutors', 'language-exchange'] })
    assert.deepEqual([...d.markets.keys()], ['online-tutors', 'language-exchange'])
    assert.deepEqual(d.refused, [])
  } finally {
    await served.close()
  }
})
