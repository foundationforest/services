// End to end, on loopback, over real HTTP: this repo's host; two profiles with real stamp proofs
// from a stand-in verifier key the index lists; an offer and a review; the index reading the host
// on its own schedule, counting the review, and serving the rating and the trust it gives. Then
// `rebuild`: every table dropped but when each proof and review was first seen and the signed
// roots, read again, the same rating and trust; on a file from before tags were called tags, the
// kept table's column renamed, what it held kept; and in a process of its own, as `npm run rebuild`
// runs it, the process ends once it is done.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { ROOT } from '../src/index.ts'
import { FILE, openStore } from '../src/store.ts'
import { MARKETS, at, cleanup, index, listsDir, verifier, post, profile, publishProfile, startHost, startRpc, tmp } from './world.ts'

test('a review between two checked profiles, read from a host, counted, and served', async () => {
  const host = await startHost()
  const rpc = await startRpc()
  const by = verifier()
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  await publishProfile(host.url, tutor)
  await publishProfile(host.url, student)
  const offer = `${tutor.key.address}/offer/maths`
  await post(host.url, [at(tutor, 'offer/maths', { description: 'Maths for secondary school, online.', subjects: ['maths'], levels: ['secondary'], place: { online: true }, price: { amount: '25', currency: 'USD', per: 'hour' } })])
  await post(host.url, [at(student, 'review/maths', { subject: tutor.key.address, score: '8.5', text: 'Patient and clear.', offer })])

  const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
  // On its own schedule, a pass every second, as main.ts runs one every READ_SECONDS.
  const i = await index({ hosts: [host.url], keys }, rpc.url, { port: 0, readSeconds: 1 })
  const get = async <T>(path: string) => {
    const res = await fetch(`${i.url}${path}`)
    return { status: res.status, body: (await res.json()) as T }
  }
  type Profile = { checks: unknown[]; ratings: { value: number | null; count: number }; trust: number; uniqueness: number; pickiness: string; posts: Array<{ listed: boolean }> }
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
  const shown = { ratings: p.ratings, trust: p.trust, uniqueness: p.uniqueness, pickiness: p.pickiness }
  assert.deepEqual(shown, { ratings: { value: 8.5, count: 1 }, trust: 44, uniqueness: 75, pickiness: 'average' })
  assert.equal(p.posts[0]!.listed, true)
  const found = (await get<{ total: number; results: Array<{ post: { address: string }; ratings: { value: number }; trust: number }> }>('/search.json?q=maths&market=tutoring&role=tutor')).body
  assert.equal(found.total, 1)
  assert.equal(found.results[0]!.post.address, offer)
  assert.deepEqual([found.results[0]!.ratings.value, found.results[0]!.trust], [8.5, 44])
  const html = await (await fetch(`${i.url}/profiles/${tutor.key.address}`)).text()
  assert.match(html, /Rated 8\.5 by 1 · trust 44 · uniqueness 75 <span class="badge">face check by /)
  // A leaf for each counted profile: the tutor's and the student's.
  const tree = (await get<{ root: string; leaves: number }>('/v1/reputation')).body
  assert.equal(tree.leaves, 2)
  const first = i.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first
  await i.close()

  // rebuild: drops what the hosts and the chain give back, keeps when each proof was first seen and every root.
  const store = openStore(i.dataDir)
  store.drop()
  assert.equal(store.db.prepare('select count(*) n from records').get()!.n, 0)
  store.close()
  const again = await index({ hosts: [host.url], keys }, rpc.url, { dataDir: i.dataDir })
  assert.equal(again.address, i.address)
  await again.pass()
  assert.equal(again.store.db.prepare('select first from seen where profile = ?').get(tutor.key.address)!.first, first)
  assert.deepEqual({ ...again.store.db.prepare('select value, count, trust, uniqueness, pickiness from ratings where profile = ?').get(tutor.key.address) }, { value: 8.5, count: 1, trust: 44, uniqueness: 75, pickiness: 'average' })
  assert.equal(again.store.db.prepare('select root from roots order by time desc limit 1').get()!.root, tree.root)
  await again.close()
  await host.close()
  await rpc.close()
})

test('rebuild, on a file from before tags were called tags: seen keeps its rows under tag, the rest made fresh', () => {
  const dir = tmp('old')
  const old = new DatabaseSync(join(dir, FILE))
  old.exec(`create table seen (profile text not null, key text not null, stamp text not null, first integer not null, primary key (profile, key));
    insert into seen values ('a profile', 'a key', 'ab', 1);
    create table leaves (n integer primary key, stamp text not null, scope text not null, score integer not null, count integer not null);
    create table profiles (address text primary key, body text not null, market text, role text, pay text, time integer not null, stamps text not null default '[]')`)
  old.close()
  const store = openStore(dir)
  store.drop()
  assert.deepEqual({ ...store.db.prepare('select profile, key, tag, first from seen').get() }, { profile: 'a profile', key: 'a key', tag: 'ab', first: 1 })
  const columns = (table: string) => store.db.prepare(`select name from pragma_table_info('${table}')`).all().map((c) => c.name)
  assert.ok(columns('leaves').includes('tag') && !columns('leaves').includes('stamp'))
  assert.ok(columns('profiles').includes('tags') && !columns('profiles').includes('pay'))
  store.close()
  cleanup(dir)
})

test('rebuild, in a process of its own as `npm run rebuild` runs it, ends the process once it is done, with a stamp proof checked', async () => {
  const host = await startHost()
  const rpc = await startRpc()
  const by = verifier()
  const tutor = await profile('tutoring/tutor', [by])
  await publishProfile(host.url, tutor)
  const dataDir = tmp('rebuild')
  const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
  const options = { dataDir, publicUrl: 'https://index.test.example', settings: { RPC_URL: rpc.url }, listsRoot: listsDir({ hosts: [host.url], keys }), marketsDir: MARKETS }
  const run = `import { rebuild } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/index.ts')).href)}; await rebuild(JSON.parse(process.argv[1]))`
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', run, JSON.stringify(options)], { stdio: 'ignore' })
  // A rebuild of one profile takes a second or two; one that is done and still running never ends.
  const ended = await new Promise<number | null | 'still running'>((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('still running')
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  try {
    assert.equal(ended, 0)
    const store = openStore(dataDir)
    assert.equal(store.db.prepare('select count(*) n from profiles').get()!.n, 1, 'it read the profile, its stamp proof checked')
    store.close()
  } finally {
    await host.close()
    await rpc.close()
    cleanup(dataDir)
  }
})
