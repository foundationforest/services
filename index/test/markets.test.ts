// Reading the markets this index uses from the markets repo: its `directory.md` and each listed
// market's file. No aliases: a market is its one name. No network: the repo is a map of paths to
// texts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Directory, parseDirectory } from '../src/markets.ts'
import { MARKETS_FOLDER, serveMarkets } from './markets-repo.ts'

const BASE = 'https://markets.test/main'
const list = { directory: BASE }
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

test('every market the directory lists, each read through its line in the directory, and nothing else', async () => {
  const text = md('- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.')
  assert.deepEqual(parseDirectory(text), [
    { name: 'plumbing', path: 'home-services/plumbing.json' },
    { name: 'online-tutors', path: 'freelance-work/online-tutors.json' },
  ])
  const files = repo({ 'directory.md': text, 'home-services/plumbing.json': plumbing, 'freelance-work/online-tutors.json': tutors })
  const d = await Directory.fetch(list, files)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors'])
  assert.deepEqual(d.refused, [])
  assert.deepEqual([...d.folders()], [['freelance-work', ['online-tutors']], ['home-services', ['plumbing']]])
  assert.equal(d.labelOf('plumber/seller'), null, 'no aliases: another spelling is another name, not a market here')
  assert.deepEqual(d.labelOf('plumbing/seller'), { market: 'plumbing', role: 'seller' })
  assert.equal(d.labelOf('plumbing'), null, 'a plain market counts for nothing')

  // No other list: a market the directory does not list is no market here.
  assert.equal(d.labelOf('stays/seller'), null)
  assert.equal(d.markets.has('stays'), false)
})

test('a market counts once the directory lists it, at the next read, and stops when it is gone', async () => {
  const files: Record<string, string> = {
    'directory.md': md('- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.'),
    'home-services/plumbing.json': plumbing,
    'freelance-work/online-tutors.json': tutors,
  }
  const d = await Directory.fetch(list, repo(files))
  const same = d.markets
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors'])
  assert.equal(d.labelOf('language-exchange/peer'), null)
  assert.equal(await d.refresh(), false, 'nothing new: nothing changed')

  files['directory.md'] = md(
    '- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.\n- [`language-exchange`](learning/language-exchange.json): Two people teach each other.',
  )
  files['learning/language-exchange.json'] = exchange
  assert.equal(await d.refresh(), true)
  assert.equal(d.markets, same, 'the same object, so what holds it sees the change')
  assert.deepEqual(d.labelOf('language-exchange/peer'), { market: 'language-exchange', role: 'peer' })

  files['directory.md'] = md('- [`language-exchange`](learning/language-exchange.json): Two people teach each other.')
  assert.equal(await d.refresh(), true)
  assert.equal(d.labelOf('online-tutors/seller'), null)
  assert.deepEqual(d.labelOf('language-exchange/peer'), { market: 'language-exchange', role: 'peer' })
})

test('a read in which the directory does not answer keeps the markets as they were', async () => {
  const files: Record<string, string> = {
    'directory.md': md('- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.'),
    'home-services/plumbing.json': plumbing,
    'freelance-work/online-tutors.json': tutors,
  }
  const d = await Directory.fetch(list, repo(files))
  delete files['directory.md']
  await assert.rejects(d.refresh(), /directory\.md answered 404/)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors'])
  // The directory answers again: the next read takes what it says.
  files['directory.md'] = md('- [`language-exchange`](learning/language-exchange.json): Two people teach each other.')
  files['learning/language-exchange.json'] = exchange
  assert.equal(await d.refresh(), true)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'language-exchange'])
  // A directory built from files has nowhere to read again.
  await assert.rejects(new Directory([]).refresh(), /not read from a markets directory/)
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
    list,
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

test('a market file that cannot be fetched, is not JSON, or is JSON null is skipped; every other market counts', async () => {
  const files: Record<string, string> = {
    'directory.md': md(
      [
        '- [`online-tutors`](freelance-work/online-tutors.json): Missing.',
        '- [`broken`](freelance-work/broken.json): Not JSON.',
        '- [`nothing`](freelance-work/nothing.json): JSON null.',
        '- [`down`](freelance-work/down.json): The request itself fails.',
        '- [`language-exchange`](learning/language-exchange.json): Fine.',
      ].join('\n'),
    ),
    'home-services/plumbing.json': plumbing,
    'freelance-work/broken.json': '{',
    'freelance-work/nothing.json': 'null',
    'learning/language-exchange.json': exchange,
  }
  const get = repo(files)
  const fetchOrFail = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('freelance-work/down.json')) throw new TypeError('fetch failed')
    return get(url, init)
  }) as typeof fetch
  const d = await Directory.fetch(list, fetchOrFail)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'language-exchange'])
  assert.deepEqual(
    d.refused.map((r) => r.market).sort(),
    ['broken', 'down', 'nothing', 'online-tutors'],
  )
  assert.match(d.refused.find((r) => r.market === 'online-tutors')!.errors[0]!, /could not be fetched: .*answered 404/)
  assert.match(d.refused.find((r) => r.market === 'down')!.errors[0]!, /could not be fetched: fetch failed/)
  assert.deepEqual(d.refused.find((r) => r.market === 'nothing')!.errors, ['not a market file: the JSON is not an object'])
  assert.deepEqual(d.refused.find((r) => r.market === 'broken')!.errors, ['not JSON'])

  // On a later read the same holds, and a file that lands is taken.
  files['freelance-work/online-tutors.json'] = tutors
  assert.equal(await d.refresh(), true)
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors', 'language-exchange'])
  assert.deepEqual(d.refused.map((r) => r.market).sort(), ['broken', 'down', 'nothing'])

  // The directory itself must answer.
  await assert.rejects(Directory.fetch(list, repo({})), /directory\.md answered 404/)
})

test("the tests' own markets repo, over HTTP", async () => {
  const served = await serveMarkets()
  try {
    const d = await Directory.fetch({ directory: served.url })
    assert.deepEqual([...d.markets.keys()], ['online-tutors', 'language-exchange'])
    assert.deepEqual(d.refused, [])
  } finally {
    await served.close()
  }
})
