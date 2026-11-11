// For developers: the morning email at any host, end to end, with a real email address.
// `SEED=<64 hex characters> npm run check-email -- https://host.example you@example.com [time zone]`
// turns the email on for check/a of SEED, asks for the code the host emails, confirms it, then
// leaves check/a one message from check/b, paid from check/b's balance there, so the next morning
// (8:00 to 9:00 in the time zone, this machine's when none is given) brings "1 new on Forest". As
// for check-host, check/a and check/b are folders there already, with credits; check/a's profile
// entry has its public encryption key. Its Stop link turns it off.

import { createInterface } from 'node:readline/promises'

import { hex, leave, readFolder } from '@foundationforest/folders'
import { CHECK_LABELS } from '@foundationforest/folders/check'
import { inboxEntry } from '@foundationforest/folders/locked'
import { mainKey } from '@foundationforest/keys'

import { inboxPayment } from './client/client.ts'
import { signEmail } from './client/email.ts'

const [host, email, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone] = process.argv.slice(2)
if (!host || !email || !process.env.SEED) {
  console.error('SEED=<64 hex characters> npm run check-email -- <the host’s address> <your email address> [time zone]')
  process.exit(2)
}
const seed = hex.decode(process.env.SEED)
const [a, b] = await Promise.all(CHECK_LABELS.map((label) => mainKey(seed, label)))

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${host}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string; detail?: string } }
}
const fail = (what: string, answer: { status: number; body: { error?: string; detail?: string } }) => {
  console.error(`${what}: ${answer.status} ${answer.body.error ?? ''} ${answer.body.detail ?? ''}`)
  process.exit(1)
}

const on = await post('/email', { email, timeZone, profiles: [signEmail(a!, host, email)] })
if (on.status !== 200) fail('turning it on', on)
const ask = createInterface({ input: process.stdin, output: process.stdout })
const code = (await ask.question(`The code ${host} emailed to ${email}: `)).trim()
ask.close()
const confirmed = await post('/email/confirm', { id: on.body.id, code })
if (confirmed.status !== 200) fail('confirming it', confirmed)

const profile = (await readFolder([host], a!.address, Date.now())).current.get('profile')?.entry.body
const left = (await leave([host], [await inboxEntry(b!, a!.address, { text: 'A check of the morning email' }, Date.now(), profile)], { payment: inboxPayment(b!) }))[0]!
const result = left.results[0]
if (!result?.ok) {
  console.error(`turned on, but the message from check/b was not left: ${result?.error ?? left.error ?? left.status} ${result?.message ?? ''}`)
  process.exit(1)
}
console.log(`On. Between 8:00 and 9:00 in ${timeZone}, ${email} gets "1 new on Forest", with its Stop link.`)
