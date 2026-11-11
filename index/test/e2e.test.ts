// End to end, on loopback, over real HTTP: this repo's host; two profiles with real verifications
// from a stand-in verifier key the index lists; an offer and a review; the index reading the host
// on its own schedule, counting the review, and serving the rating and the trust it gives. Then
// `rebuild`: every table dropped but when each proof and review was first seen and the signed
// roots, read again, the same rating and trust; in a process of its own, as `npm run rebuild` runs
// it, the process ends once it is done; and `node src/main.ts rebuild`, with something still open,
// says so and exits.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { ROOT } from '../src/index.ts'
import { SEED_FILE } from '../src/seed.ts'
import { openStore } from '../src/store.ts'
import { MARKETS, at, cleanup, index, listsDir, verifier, post, profile, publishProfile, startHost, tmp } from './world.ts'

/** A child process's exit code once its output is all read, or 'still running' once `ms` pass, when it is killed. */
function exitOf(child: ReturnType<typeof spawn>, ms: number): Promise<number | null | 'still running'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('still running')
    }, ms)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

test('a review between two checked profiles, read from a host, counted, and served', async () => {
  const host = await startHost()
  const by = verifier()
  const tutor = await profile('lessons/tutor', [by])
  const student = await profile('lessons/student', [by])
  await publishProfile(host.url, tutor)
  await publishProfile(host.url, student)
  const offer = `${tutor.key.address}/listing/maths`
  await post(host.url, [at(tutor, 'listing/maths', { description: 'Maths for secondary school, online.', subjects: ['maths'], levels: ['secondary'], mode: ['online'], price: [{ amount: '25', currency: 'USD', per: 'hour' }] })])
  await post(host.url, [at(student, 'review/maths', { subject: tutor.key.address, score: '8.5', text: 'Patient and clear.', listing: offer })])

  const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
  // On its own schedule, a pass every second, as main.ts runs one every READ_SECONDS.
  const i = await index({ hosts: [host.url], keys }, { port: 0, readSeconds: 1 })
  const get = async <T>(path: string) => {
    const res = await fetch(`${i.url}${path}`)
    return { status: res.status, body: (await res.json()) as T }
  }
  type Profile = { checks: unknown[]; ratings: { value: number | null; count: number }; trust: number; uniqueness: number; listings: Array<{ listed: boolean }> }
  let p: Profile | undefined
  for (const until = Date.now() + 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
    const got = await get<Profile>(`/profiles/${tutor.key.address}.json`)
    if (got.status === 200 && got.body.ratings.count === 1) {
      p = got.body
      break
    }
  }
  assert.ok(p, 'the index served the rating within a minute')
  assert.deepEqual(p.checks, [{ verifier: by.name, key: by.key, label: 'face check' }])
  // One 8.5 is a rating of 8.5, shown as it is. It is the student's word too, a vouch weighing the
  // student's uniqueness times trust, 0.75 times 0.375: it lifts the tutor's trust from half its
  // uniqueness, 37.5, to 0.75 (1 - 0.5 x 0.5^0.28125), 44.
  const shown = { ratings: p.ratings, trust: p.trust, uniqueness: p.uniqueness }
  assert.deepEqual(shown, { ratings: { value: 8.5, count: 1 }, trust: 44, uniqueness: 75 })
  assert.equal(p.listings[0]!.listed, true)
  const found = (await get<{ total: number; results: Array<{ listing: { address: string }; ratings: { value: number }; trust: number }> }>('/search.json?q=maths&market=lessons&role=tutor')).body
  assert.equal(found.total, 1)
  assert.equal(found.results[0]!.listing.address, offer)
  assert.deepEqual([found.results[0]!.ratings.value, found.results[0]!.trust], [8.5, 44])
  const html = await (await fetch(`${i.url}/profiles/${tutor.key.address}`)).text()
  assert.ok(html.includes('Lessons tutor<span class="vb lg" role="img" aria-label="Verified with a selfie"'))
  assert.match(html, /<span class="rated"><span class="rate"><svg[^>]*>.*?<\/svg>8\.5<\/span><span class="s">1 review<\/span><\/span>/)
  for (const n of ['8.5', '44', '75']) assert.ok(html.includes(`<div class="num"><span class="d">${n}</span>`), n)
  // The listing's own page, over HTTP, at its address under /profiles.
  const listingPage = await fetch(`${i.url}/profiles/${tutor.key.address}/listing/maths`)
  assert.equal(listingPage.status, 200)
  assert.ok((await listingPage.text()).includes('<h1>Maths for secondary school, online.</h1><p class="cost"><span class="d big">$25</span> <span class="s">per hour</span></p>'))
  // A leaf for each counted profile: the tutor's and the student's.
  const tree = (await get<{ root: string; leaves: number }>('/v1/reputation')).body
  assert.equal(tree.leaves, 2)
  const first = i.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first
  await i.close()

  // rebuild: drops what the hosts give back, keeps when each proof was first seen and every root.
  const store = openStore(i.dataDir)
  store.drop()
  assert.equal(store.db.prepare('select count(*) n from entries').get()!.n, 0)
  store.close()
  const again = await index({ hosts: [host.url], keys }, { dataDir: i.dataDir })
  assert.equal(again.address, i.address)
  await again.pass()
  assert.equal(again.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first, first)
  assert.deepEqual({ ...again.store.db.prepare('select value, count, trust, uniqueness from ratings where profile = ?').get(tutor.key.address) }, { value: 8.5, count: 1, trust: 44, uniqueness: 75 })
  assert.equal(again.store.db.prepare('select root from roots order by time desc limit 1').get()!.root, tree.root)
  await again.close()
  await host.close()
})

test('rebuild, in a process of its own as `npm run rebuild` runs it, ends the process once it is done, with a verification checked', async () => {
  const host = await startHost()
  const by = verifier()
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  const dataDir = tmp('rebuild')
  const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
  const options = { dataDir, publicUrl: 'https://index.test.example', listsRoot: listsDir({ hosts: [host.url], keys }), marketsDir: MARKETS }
  const run = `import { rebuild } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/index.ts')).href)}; await rebuild(JSON.parse(process.argv[1]))`
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', run, JSON.stringify(options)], { stdio: 'ignore' })
  // A rebuild of one profile takes a second or two; one that is done and still running never ends.
  const ended = await exitOf(child, 30_000)
  try {
    assert.equal(ended, 0)
    const store = openStore(dataDir)
    assert.equal(store.db.prepare('select count(*) n from profiles').get()!.n, 1, 'it read the profile, its verification checked')
    store.close()
  } finally {
    await host.close()
    cleanup(dataDir)
  }
})

test('`node src/main.ts rebuild`, with something still open, says it rebuilt and exits, keeping when the proof was first seen', async () => {
  const host = await startHost()
  const by = verifier()
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  // main.ts reads the lists in its own directory, so it runs from a copy of this one whose lists
  // name the loopback host and the test's verifier key, with the markets beside it as in the repo.
  const parent = tmp('main')
  const dir = join(parent, 'index')
  mkdirSync(dir)
  for (const f of ['src', 'package.json', 'llms.txt', 'skill.md']) cpSync(join(ROOT, f), join(dir, f), { recursive: true })
  const lists = listsDir({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  for (const f of ['lists', 'config']) cpSync(join(lists, f), join(dir, f), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
  symlinkSync(MARKETS, join(parent, 'markets'))
  // The data a deploy rebuilds: its seed, a root it signed, and the tutor's proof first seen long ago.
  const dataDir = tmp('old')
  const old = openStore(dataDir)
  old.db.prepare('insert into seen values (?, ?, ?)').run(tutor.key.address, by.key, 1)
  old.db.prepare('insert into roots values (?, 1, ?, 1)').run('00'.repeat(32), 'a signature')
  old.close()
  writeFileSync(join(dataDir, SEED_FILE), JSON.stringify({ seed: 'ab'.repeat(32) }), { mode: 0o600 })

  // As `npm run rebuild` runs it, with a timer that never ends loaded first: whatever a rebuild
  // leaves open, the deploy's next command must still start.
  const forever = 'data:text/javascript,setInterval(() => {}, 2 ** 30)'
  const env = { ...process.env, DATA_DIR: dataDir, PUBLIC_URL: 'https://index.test.example' }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', forever, 'src/main.ts', 'rebuild'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout!.on('data', (chunk) => (out += chunk))
  const ended = await exitOf(child, 30_000)
  try {
    assert.equal(ended, 0)
    assert.match(out, /^rebuilt: read the hosts again, and ranked$/m)
    const store = openStore(dataDir)
    assert.deepEqual({ ...store.db.prepare('select * from seen').get() }, { profile: tutor.key.address, key: by.key, first: 1 }, 'seen keeps its row')
    assert.equal(store.db.prepare('select counted from profiles where address = ?').get(tutor.key.address)!.counted, 1, 'it read the profile, its verification checked')
    assert.equal(store.db.prepare('select count(*) n from roots where time = 1').get()!.n, 1, 'the old root is kept')
    store.close()
  } finally {
    await host.close()
    for (const d of [parent, lists, dataDir]) cleanup(d)
  }
})
