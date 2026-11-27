// What the AI is shown of an index's answer: the answer itself, passed on as the index gave it, so a
// field an index adds later reaches the AI with no change here, with two rules that name no field of
// an index's own making:
//
// - A field only machines read is left out: proofs, keys, openKey, pay, statement and signature,
//   and each check's `key`. They carry nothing a person or an AI acts on, and an app directory
//   rejects debug payloads in answers.
// - Every entry's `body`, the words its writer wrote, moves under `strangersWrote`, so the AI tells
//   what a stranger wrote from what the person said. A body the person wrote themselves (the
//   entries a profile's page lists as given) keeps its name, when the profile is the person's own.

import { isObject } from './forest.ts'

/** The fields only machines read. */
const MACHINE = new Set(['proofs', 'keys', 'openKey', 'pay', 'statement', 'signature'])

/** The name every stranger's words sit under, in every answer. */
export const STRANGERS = 'strangersWrote'

/**
 * `value`, an index's JSON, without the machine fields and with each entry's `body` moved under
 * `strangersWrote`. `ownGiven`: the answer is the person's own profile's page, so what it lists as
 * `given` is the person's words and keeps `body`.
 */
export function forAi(value: unknown, ownGiven = false): unknown {
  const walk = (v: unknown, own: boolean, inChecks: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, own, inChecks))
    if (!isObject(v)) return v
    const out: { [key: string]: unknown } = {}
    for (const [k, x] of Object.entries(v)) {
      if (MACHINE.has(k) || (inChecks && k === 'key')) continue
      out[k === 'body' && !own ? STRANGERS : k] = walk(x, own || (ownGiven && k === 'given'), k === 'checks')
    }
    return out
  }
  return walk(value, false, false)
}

/** A listing's title as the index shows it: its `title`, else the first line of its description. */
export function titleOf(body: { [key: string]: unknown }): string {
  if (typeof body.title === 'string' && body.title.trim()) return body.title.trim()
  const first = typeof body.description === 'string' ? (body.description.split('\n').find((l) => l.trim()) ?? '') : ''
  return first.trim().slice(0, 120)
}
