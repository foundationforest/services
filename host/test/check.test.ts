// The standard's host check (@foundationforest/folders/check) against this host: the plug alone,
// which chooses nothing of its own, passes every check; the whole host, credits and all, refuses a
// fresh seed's first write by its own choice, so the check stops there unchecked and nothing fails;
// and given a seed whose two folders hold credits, and the payment `npm run check-host` gives it
// (check-host.ts), a credit for each inbox entry bought from check/b's balance, it passes every
// check, the inbox's included.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { mainKey, newSeed } from '@foundationforest/keys'
import { CHECK_LABELS, type HostCheck, checkHost } from '@foundationforest/folders/check'

import { checkPayment } from '../check-host.ts'
import { readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'
import { freePort, startPlug } from './helpers.ts'

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

test('the whole host: a fresh seed stops at its first write, refused for credits, and nothing fails; a seed whose folders hold credits, paying for its inbox entries, passes every check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-check-'))
  dirs.push(dir)
  const port = await freePort()
  const ORIGIN = `http://127.0.0.1:${port}`
  const running = await startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: ORIGIN, PORT: String(port), SPONSORS: gift.address }))
  try {
    const fresh = await checkHost(running.url)
    assert.deepEqual(fresh.filter((r) => r.status === 'failed'), [], 'a refusal for credits is the host’s own choice, never a failure')
    assert.equal(fresh[0]!.status, 'unchecked')
    assert.match(fresh[0]!.why!, /refused .* by its own choice: refused, .*credit/)

    // check/a pays for its writes; check/b for its writes and a credit for each inbox entry it leaves.
    const seed = newSeed()
    for (const [label, n] of [[CHECK_LABELS[0], 1], [CHECK_LABELS[1], 10]] as const) {
      const folder = (await mainKey(seed, label)).address
      const b = await buy(ORIGIN, await keyOf(running.url), n)
      const got = await collect(running.url, b.bytes, `ticket ${gift.ticket(ORIGIN, b.reference, n)}`)
      assert.equal(got.status, 200)
      assert.equal((await spend(running.url, folder, await b.finish(got.body))).status, 200)
    }
    const folders = await Promise.all(CHECK_LABELS.map(async (label) => (await mainKey(seed, label)).address))
    const unpaid = await checkHost(running.url, { seed })
    assert.deepEqual(unpaid.filter((r) => r.status === 'failed'), [], 'an inbox entry with no credit is refused by the host’s own choice')
    assert.ok(unpaid.some((r) => r.status === 'unchecked' && /inbox entry .*by its own choice: refused, an inbox entry here carries one credit/.test(r.why ?? '')))
    const before = folders.map((f) => running.credits.balance(f))
    assert.deepEqual(notOk(await checkHost(ORIGIN, { seed, payment: await checkPayment(seed) })), [])
    console.log(`# the check paid, check/a ${(before[0]! - running.credits.balance(folders[0]!)).toFixed(6)} credits, check/b ${(before[1]! - running.credits.balance(folders[1]!)).toFixed(6)}`)
  } finally {
    await running.close()
  }
})
