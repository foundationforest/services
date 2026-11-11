// The morning email, through the whole host on loopback, its front and its host API, on a clock the
// test moves, with a stand-in Resend that keeps what would be sent: no real email. A profile is
// refused without its main key's signature for that email address, or when it is not here; the
// code confirms, a wrong one counts against it, and codes are limited; nothing new sends nothing;
// one email a day at most, with its counts, its profiles, its button and its stop link, and never
// a message's words; each email address gets its email at 8:00 where it is; changing the email
// address moves the profiles; and the stop link shows one button, whose POST deletes everything.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type IncomingHttpHeaders, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { type Body, type Key, entry, leave, write } from '@foundationforest/folders'
import { inboxEntry } from '@foundationforest/folders/locked'
import { mainKey, newSeed, openingHalf } from '@foundationforest/keys'

import { inboxPayment } from '../client/client.ts'
import { signEmail } from '../client/email.ts'
import { type RunningHost, readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'
import { Clock, freePort } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** 6:00 in Mexico City (UTC−6, no summer time), 21:00 in Tokyo (UTC+9). */
const START = Date.UTC(2026, 10, 2, 12, 0, 0)
/** 8:00 in Mexico City, that day. */
const MEXICO_8AM = Date.UTC(2026, 10, 2, 14, 0, 0)
const gift = sponsor()
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

type Sent = { headers: IncomingHttpHeaders; body: { from: string; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> } }

/** A stand-in for Resend's `POST /emails`: it keeps each email, and takes one idempotency key once, as Resend does. */
async function standInResend(): Promise<{ url: string; sent: Sent[]; close(): Promise<void> }> {
  const sent: Sent[] = []
  const keys = new Set<string>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const key = req.headers['idempotency-key'] as string | undefined
      if (req.method !== 'POST' || req.url !== '/emails') return void res.writeHead(404).end()
      if (key === undefined || !keys.has(key)) sent.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      if (key !== undefined) keys.add(key)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: crypto.randomUUID() }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

type World = { running: RunningHost; resend: Awaited<ReturnType<typeof standInResend>>; clock: Clock; dir: string; close(): Promise<void> }

/** The whole host, with Resend's key, on the test's clock, whose public origin is its own address so inbox payments sign it. */
async function world(): Promise<World> {
  const resend = await standInResend()
  const clock = new Clock(START)
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'host-email-'))
  dirs.push(dir)
  const env = { DATA_DIR: dir, PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port), SPONSORS: gift.address, RESEND_API_KEY: 're_test' }
  const running = await startHost(readConfig(env), { now: clock.now, resendUrl: resend.url })
  return {
    running,
    resend,
    clock,
    dir,
    async close() {
      await running.close()
      await resend.close()
    },
  }
}

type Profile = { key: Key; body: Body }

/** A profile here, with a credit to write with: its profile entry names its market and role, and its public encryption key. */
async function profile(w: World, seed: Uint8Array, label: string): Promise<Profile> {
  const key = await mainKey(seed, label)
  const { url } = w.running
  const b = await buy(url, await keyOf(url), 1)
  const got = await collect(url, b.bytes, `ticket ${gift.ticket(url, b.reference, 1)}`)
  assert.equal((await spend(url, key.address, await b.finish(got.body))).status, 200)
  const [market, role] = label.split('/')
  const body: Body = { market: market!, role: role!, hosts: [url], openKey: (await openingHalf(key.secret)).openKey }
  await entries(w, [entry(key, 'profile', body, w.clock.now())])
  return { key, body }
}

async function entries(w: World, list: Parameters<typeof write>[1]) {
  for (const r of (await write([w.running.url], list))[0]!.results) assert.ok(r.ok, r.message)
}

/** A message from one profile to another, paid from the sender's balance. */
async function message(w: World, from: Profile, to: Profile, text: string) {
  const e = await inboxEntry(from.key, to.key.address, { text }, w.clock.now(), to.body)
  for (const r of (await leave([w.running.url], [e], { payment: inboxPayment(from.key) }))[0]!.results) assert.ok(r.ok, r.message)
}

async function post(w: World, path: string, body: unknown): Promise<{ status: number; body: { id?: string; error?: string } }> {
  const res = await fetch(`${w.running.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
}

const signed = (w: World, email: string, keys: Key[]) => keys.map((key) => signEmail(key, w.running.url, email))
/** The code in the last email sent. */
const lastCode = (w: World) => /\b([0-9]{6})\b/.exec(w.resend.sent.at(-1)!.body.text)![1]!

/** Turns email on for `profiles` and confirms it with the code it sent: the id. */
async function turnOn(w: World, email: string, timeZone: string, profiles: Profile[]): Promise<string> {
  const on = await post(w, '/email', { email, timeZone, profiles: signed(w, email, profiles.map((p) => p.key)) })
  assert.equal(on.status, 200, on.body.error)
  const confirmed = await post(w, '/email/confirm', { id: on.body.id, code: lastCode(w) })
  assert.deepEqual(confirmed, { status: 200, body: { id: on.body.id } })
  return on.body.id!
}

/** A morning look at `time`: how many emails went. */
const morning = (w: World, time: number) => {
  w.clock.t = time
  return w.running.email!.morning()
}

test('a profile without its main key’s signature for that email address, or not here, is refused, and nothing is sent', async () => {
  const w = await world()
  try {
    const seed = newSeed()
    const tutor = await profile(w, seed, 'tutoring/tutor')
    const seller = await mainKey(seed, 'goods/seller') // no folder here
    const email = 'ana@example.com'
    const on = (profiles: unknown[]) => post(w, '/email', { email, timeZone: 'America/Mexico_City', profiles })
    const [own] = signed(w, email, [tutor.key])
    assert.deepEqual((await on([{ profile: tutor.key.address }])).body.error, 'bad_request', 'no signature')
    assert.deepEqual((await on([{ ...own, sig: signEmail(tutor.key, w.running.url, 'eve@example.com').sig }])).body.error, 'not_signed', 'signed for another email address')
    assert.deepEqual((await on([{ ...own, sig: signEmail(seller, w.running.url, email).sig }])).body.error, 'not_signed', 'signed by another key')
    assert.deepEqual((await on([{ ...own, sig: signEmail(tutor.key, 'https://host.example', email).sig }])).body.error, 'not_signed', 'signed for another host')
    assert.deepEqual((await on([own, signEmail(seller, w.running.url, email)])).body.error, 'not_here', 'a profile with no folder here')
    assert.deepEqual((await post(w, '/email', { email, timeZone: 'Mars/Olympus', profiles: [own] })).body.error, 'bad_request', 'a time zone there is not')
    assert.equal(w.resend.sent.length, 0)
  } finally {
    await w.close()
  }
})

test('the code confirms; a wrong one counts against it, five delete it, it expires, and codes to one email address are limited', async () => {
  const w = await world()
  try {
    const tutor = await profile(w, newSeed(), 'tutoring/tutor')
    const email = 'ana@example.com'
    const on = () => post(w, '/email', { email, timeZone: 'America/Mexico_City', profiles: signed(w, email, [tutor.key]) })
    const first = await on()
    assert.equal(first.status, 200)
    const letter = w.resend.sent.at(-1)!
    assert.equal(letter.headers.authorization, 'Bearer re_test')
    assert.deepEqual([letter.body.from, letter.body.to, letter.body.subject], ['Forest <notify@forest.foundation>', [email], `${lastCode(w)} is your Forest code`])
    const code = lastCode(w)
    const wrong = code === '000000' ? '111111' : '000000'
    assert.equal((await post(w, '/email/confirm', { id: first.body.id, code: wrong })).body.error, 'code')
    assert.deepEqual(await post(w, '/email/confirm', { id: first.body.id, code }), { status: 200, body: { id: first.body.id } })
    assert.equal((await post(w, '/email/confirm', { id: first.body.id, code })).body.error, 'code', 'once confirmed, its code is gone')

    assert.deepEqual(await on(), { status: 429, body: { error: 'too_soon', detail: 'a code to one email address once a minute and 5 times a day' } })
    w.clock.advance(MINUTE + 1)
    const second = await on()
    const secondCode = lastCode(w)
    for (let i = 0; i < 5; i++) assert.equal((await post(w, '/email/confirm', { id: second.body.id, code: secondCode === '000000' ? '111111' : '000000' })).body.error, 'code')
    assert.equal((await post(w, '/email/confirm', { id: second.body.id, code: secondCode })).body.error, 'code', 'five wrong codes deleted it')

    w.clock.advance(MINUTE + 1)
    const third = await on()
    w.clock.advance(16 * MINUTE)
    assert.equal((await post(w, '/email/confirm', { id: third.body.id, code: lastCode(w) })).body.error, 'code', 'a code works for 15 minutes')

    for (let i = 0; i < 2; i++) {
      w.clock.advance(MINUTE + 1)
      assert.equal((await on()).status, 200)
    }
    w.clock.advance(MINUTE + 1)
    assert.equal((await on()).body.error, 'too_soon', 'five codes a day to one email address')
    assert.equal(w.resend.sent.length, 5)
  } finally {
    await w.close()
  }
})

test('nothing new sends nothing', async () => {
  const w = await world()
  try {
    const tutor = await profile(w, newSeed(), 'tutoring/tutor')
    await turnOn(w, 'ana@example.com', 'America/Mexico_City', [tutor])
    const before = w.resend.sent.length
    assert.equal(await morning(w, MEXICO_8AM), 0)
    assert.equal(w.resend.sent.length, before)
  } finally {
    await w.close()
  }
})

test('one email a day at most, at 8:00 where the person is, with the counts, the profiles, the button and the stop link, never a message’s words', async () => {
  const w = await world()
  try {
    const seed = newSeed()
    const tutor = await profile(w, seed, 'tutoring/tutor')
    const seller = await profile(w, seed, 'goods/seller')
    const bob = await profile(w, newSeed(), 'tutoring/student')
    const other = await profile(w, newSeed(), 'tutoring/tutor')
    const id = await turnOn(w, 'ana@example.com', 'America/Mexico_City', [tutor, seller])

    w.clock.advance(HOUR)
    await message(w, bob, tutor, 'My secret words')
    await message(w, bob, other, 'Not hers')
    await entries(w, [
      entry(bob.key, 'review/1', { subject: tutor.key.address, score: '9', text: 'Great' }, w.clock.now()),
      entry(bob.key, 'review/2', { subject: other.key.address, score: '3', text: 'Someone else' }, w.clock.now()),
      entry(bob.key, 'review/3', { subject: seller.key.address, score: '1', text: 'Taken back' }, w.clock.now()),
      entry(bob.key, 'vouch/1', { subject: seller.key.address, text: 'Real and honest' }, w.clock.now()),
    ])
    w.clock.advance(1)
    await entries(w, [entry(bob.key, 'review/3', null, w.clock.now())])

    assert.equal(await morning(w, MEXICO_8AM - 15 * MINUTE), 0, '7:45 is not the morning')
    const before = w.resend.sent.length
    assert.equal(await morning(w, MEXICO_8AM), 1)
    const letter = w.resend.sent.at(-1)!
    const stop = `${w.running.url}/email/stop/${id}`
    assert.equal(letter.body.subject, '3 new on Forest')
    assert.deepEqual(letter.body.to, ['ana@example.com'])
    assert.equal(letter.headers['idempotency-key'], `${id}/2026-11-02`)
    assert.deepEqual(letter.body.headers, { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    assert.equal(
      letter.body.text,
      `You have 1 new message, 1 review and 1 vouch.\nOn your Tutoring tutor and Goods seller.\n\nOpen Forest: https://app.forest.foundation\n\nYou turned this on in Forest. Stop these emails: ${stop}\n`,
    )
    for (const part of ['You have 1 new message, 1 review and 1 vouch.', 'On your Tutoring tutor and Goods seller.', '>Open Forest</a>', 'href="https://app.forest.foundation"', `href="${stop}"`, 'Stop these emails']) assert.ok(letter.body.html.includes(part), part)

    w.clock.advance(MINUTE)
    await message(w, bob, tutor, 'More secret words')
    assert.equal(await morning(w, MEXICO_8AM + 15 * MINUTE), 0, 'once a day')
    assert.equal(await morning(w, MEXICO_8AM + 30 * MINUTE), 0, 'once a day')
    assert.equal(w.resend.sent.length, before + 1)

    assert.equal(await morning(w, MEXICO_8AM + 24 * HOUR), 1, 'the next morning, what came since the last email')
    assert.equal(w.resend.sent.at(-1)!.body.text.split('\n').slice(0, 2).join('\n'), 'You have 1 new message.\nOn your Tutoring tutor.')
    for (const sent of w.resend.sent) assert.ok(!/secret|Great|honest/.test(sent.body.html + sent.body.text), 'never what a message or a review says')
  } finally {
    await w.close()
  }
})

test('each email address gets its email at 8:00 in its own time zone', async () => {
  const w = await world()
  try {
    const ana = await profile(w, newSeed(), 'tutoring/tutor')
    const kenji = await profile(w, newSeed(), 'goods/seller')
    const bob = await profile(w, newSeed(), 'tutoring/student')
    await turnOn(w, 'ana@example.com', 'America/Mexico_City', [ana])
    await turnOn(w, 'kenji@example.jp', 'Asia/Tokyo', [kenji])
    w.clock.advance(30 * MINUTE)
    await message(w, bob, ana, 'Hola')
    await message(w, bob, kenji, 'Konnichiwa')
    const to = async (time: number) => {
      const before = w.resend.sent.length
      await morning(w, time)
      return w.resend.sent.slice(before).map((s) => s.body.to[0])
    }
    assert.deepEqual(await to(MEXICO_8AM - 15 * MINUTE), [], '7:45 in Mexico City')
    assert.deepEqual(await to(MEXICO_8AM), ['ana@example.com'], '8:00 in Mexico City, 23:00 in Tokyo')
    const tokyo8am = Date.UTC(2026, 10, 2, 23, 0, 0)
    assert.deepEqual(await to(tokyo8am - 15 * MINUTE), [], '7:45 in Tokyo')
    assert.deepEqual(await to(tokyo8am), ['kenji@example.jp'], '8:00 in Tokyo, 17:00 in Mexico City')
  } finally {
    await w.close()
  }
})

test('a change of profiles needs no code; a new email address takes the profiles once its code confirms, and the old one is deleted', async () => {
  const w = await world()
  try {
    const seed = newSeed()
    const tutor = await profile(w, seed, 'tutoring/tutor')
    const seller = await profile(w, seed, 'goods/seller')
    const old = await turnOn(w, 'ana@example.com', 'America/Mexico_City', [tutor])
    const sent = w.resend.sent.length
    assert.deepEqual(await post(w, `/email/${old}`, { timeZone: 'Europe/Madrid', profiles: signed(w, 'ana@example.com', [tutor.key, seller.key]) }), { status: 200, body: { id: old } })
    assert.equal((await post(w, `/email/${old}`, { timeZone: 'Europe/Madrid', profiles: signed(w, 'eve@example.com', [tutor.key]) })).body.error, 'not_signed', 'signed for this email address')
    assert.equal(w.resend.sent.length, sent, 'no code for a change')

    w.clock.advance(MINUTE + 1)
    const now = await turnOn(w, 'ana@new.example', 'Europe/Madrid', [tutor, seller])
    assert.equal((await post(w, `/email/${old}`, { timeZone: 'Europe/Madrid', profiles: signed(w, 'ana@example.com', [tutor.key]) })).body.error, 'unknown', 'the old email address, left with no profile, is deleted')
    assert.notEqual(now, old)
  } finally {
    await w.close()
  }
})

test('the stop link shows one button; its POST deletes everything, and nothing more is sent', async () => {
  const w = await world()
  try {
    const tutor = await profile(w, newSeed(), 'tutoring/tutor')
    const bob = await profile(w, newSeed(), 'tutoring/student')
    const email = 'ana@example.com'
    const id = await turnOn(w, email, 'America/Mexico_City', [tutor])
    const file = join(w.dir, 'email', 'email.sqlite')
    const held = () => {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n
      } finally {
        db.close()
      }
    }
    const stop = `${w.running.url}/email/stop/${id}`

    const page = await fetch(stop)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<form method="post"[^>]*><button type="submit"[^>]*>Stop these emails<\/button><\/form>/)
    assert.equal(held(), 1, 'opening the link stops nothing')

    // As a mail client's one-click unsubscribe sends it (RFC 8058).
    const stopped = await fetch(stop, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    assert.equal(stopped.status, 200)
    assert.match(await stopped.text(), /These emails are stopped/)
    assert.equal(held(), 0)
    const bytes = readFileSync(file)
    for (const kept of [email, tutor.key.address, id]) assert.ok(!bytes.includes(kept), `nothing of it is left in the file: ${kept}`)

    await message(w, bob, tutor, 'Hello')
    assert.equal(await morning(w, MEXICO_8AM), 0)
    assert.equal((await post(w, `/email/${id}`, { timeZone: 'America/Mexico_City', profiles: signed(w, email, [tutor.key]) })).body.error, 'unknown')
    assert.equal((await fetch(stop, { method: 'POST' })).status, 200, 'stopping again says the same')
  } finally {
    await w.close()
  }
})

test('without RESEND_API_KEY there is no email: its routes are the host API’s 404', async () => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'host-email-'))
  dirs.push(dir)
  const running = await startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) }))
  try {
    assert.equal(running.email, undefined)
    assert.equal((await fetch(`${running.url}/email`, { method: 'POST', body: '{}' })).status, 404)
    assert.throws(() => readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: running.url, RESEND_API_KEY: 'not a key' }), /RESEND_API_KEY is a Resend API key/)
  } finally {
    await running.close()
  }
})
