// The devnet test host: forest's host behind the front, and the label at `/`.
//
//   npm test

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { profileKey } from '../../../forest/keys/src/index.ts'
import { hostsRecord, ownerRecord, publish, readAll, readProfile } from '../../../forest/records/src/index.ts'

import { LABEL, type TestHost, readConfig, startHost } from '../src/host.ts'

let host: TestHost
before(async () => {
  host = await startHost(readConfig({ PORT: '0' }))
})
after(async () => {
  await host?.close()
})

test('`/` says what this is; every other path is forest’s host', async () => {
  const res = await fetch(`${host.url}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), LABEL)
  assert.match(LABEL, /devnet testing only/)
  assert.equal((await fetch(`${host.url}/elsewhere`)).status, 404)
})

test('records go in and come back through the front, for the whole host and by profile', async () => {
  const now = Date.now()
  const people = [await profileKey(randomBytes(32), 'tutoring/seller'), await profileKey(randomBytes(32), 'tutoring/buyer')]
  for (const who of people) {
    const outcomes = await publish([host.url], [
      hostsRecord(who, [host.url], now),
      ownerRecord(who, 'profile', { market: 'tutoring', role: who.label.split('/')[1]!, name: 'Test', createdAt: '2026-10-02T00:00:00Z' }, now),
    ])
    assert.ok(outcomes[0]!.results.every((r) => r.ok), JSON.stringify(outcomes))
  }
  assert.equal((await readAll(host.url)).records.length, 4, 'what is new on the whole host')
  const view = await readProfile([host.url], people[0]!.address, Date.now())
  assert.deepEqual(view.hosts, [host.url])
  assert.equal(view.current.get('profile')!.record.profile, people[0]!.address)
})
