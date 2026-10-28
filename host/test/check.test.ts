// The standard's host check (@foundationforest/records/check) against this host: the plug alone,
// which chooses nothing of its own, passes every check; the whole host, credits and all, refuses a
// fresh seed's first write by its own choice, so the check stops there unchecked and nothing fails;
// and given a seed whose two folders hold credits, as `npm run check-host` is given one against the
// deployed copy, it passes every check.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { mainKey, newSeed } from '@foundationforest/keys'
import { CHECK_LABELS, type HostCheck, checkHost } from '@foundationforest/records/check'

import { readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'
import { startPlug } from './helpers.ts'

const ORIGIN = 'http://127.0.0.1'
const gift = sponsor()
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The checks that did not pass, as `status: name. why`. */
const notOk = (results: HostCheck[]) => results.filter((r) => r.status !== 'ok').map((r) => `${r.status}: ${r.name}. ${r.why ?? ''}`)

test('the plug alone passes every check', async () => {
  const plug = await startPlug()
  try {
    const results = await checkHost(plug.url)
    assert.ok(results.length >= 8)
    assert.deepEqual(notOk(results), [])
  } finally {
    await plug.close()
  }
})

test('the whole host: a fresh seed stops at its first write, refused for credits, and nothing fails; a seed whose folders hold credits passes every check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-check-'))
  dirs.push(dir)
  const running = await startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: ORIGIN, PORT: '0', SPONSORS: gift.address }))
  try {
    const fresh = await checkHost(running.url)
    assert.deepEqual(fresh.filter((r) => r.status === 'failed'), [], 'a refusal for credits is the host’s own choice, never a failure')
    assert.equal(fresh[0]!.status, 'unchecked')
    assert.match(fresh[0]!.why!, /refused .* by its own choice: refused, .*credit/)

    const seed = newSeed()
    for (const label of CHECK_LABELS) {
      const folder = (await mainKey(seed, label)).address
      const b = await buy(ORIGIN, await keyOf(running.url), 5)
      const got = await collect(running.url, b.bytes, `ticket ${gift.ticket(ORIGIN, b.reference, 5)}`)
      assert.equal(got.status, 200)
      assert.equal((await spend(running.url, folder, await b.finish(got.body))).status, 200)
    }
    assert.deepEqual(notOk(await checkHost(running.url, { seed })), [])
  } finally {
    await running.close()
  }
})
