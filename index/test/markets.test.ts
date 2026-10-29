// The markets, read from the pinned checkout through the markets package: a post that does not fit
// its market (the package's checkEntry, whose own tests are the markets repo's) is kept, not listed,
// and says why.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { MarketPage } from '../src/pages/market.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
import { at, index, verifier, post, profile, publishProfile, startHost, twin } from './world.ts'

const by = verifier()
let host: Awaited<ReturnType<typeof startHost>>
before(async () => {
  host = await startHost()
})
after(async () => {
  await host.close()
})

test('a post that does not fit its market is kept, not listed, and its profile page says why', async () => {
  const tutor = await profile('tutoring/tutor', [by])
  const student = await profile('tutoring/student', [by])
  for (const p of [tutor, student]) await publishProfile(host.url, p)
  await post(host.url, [
    at(tutor, 'post/good', { description: 'Maths, any level.', subjects: ['maths'] }),
    at(tutor, 'post/odd', { description: 'Maths.', colour: 'red' }),
    at(student, 'post/physics', { description: 'Help with physics, please.', subjects: ['physics'] }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()

  const m = (await twin<MarketPage>(i, '/markets/tutoring.json')).body
  assert.deepEqual(Object.keys(m.posts), ['tutor', 'student'])
  assert.deepEqual(m.posts.tutor!.map((r) => r.post.address), [`${tutor.key.address}/post/good`])
  assert.deepEqual(m.posts.student!.map((r) => r.post.address), [`${student.key.address}/post/physics`])

  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  const odd = t.posts.find((p) => p.address.endsWith('/post/odd'))!
  assert.equal(odd.listed, false)
  assert.equal(odd.why, 'a post in tutoring has no field colour')
  assert.deepEqual(odd.body, { description: 'Maths.', colour: 'red' })
  assert.equal(t.posts.find((p) => p.address.endsWith('/post/good'))!.listed, true)
  assert.equal('why' in t.posts.find((p) => p.address.endsWith('/post/good'))!, false)
  await i.close()
})
