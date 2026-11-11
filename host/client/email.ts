// The morning email, the app's side: what each profile's main key signs to have this host email a
// count of what's new on it to an email address (the host's README.md, Email). The host checks
// exactly this text (../src/email.ts), so the two never differ. It imports only the standard's
// folders, so an app in a browser imports it as it is.

import { type Key, signAs } from '@foundationforest/folders'

/**
 * What a profile's main key signs to have its counts emailed to `email` by the host at `origin`:
 * the host, the profile and the email address, so it is good for that address at that host alone.
 */
export function emailMessage(origin: string, profile: string, email: string): Uint8Array {
  return new TextEncoder().encode(`forest email\n${origin}\n${profile}\n${email}`)
}

/** One profile as the host's email routes list it: its address, and its main key's signature over `emailMessage`. */
export function signEmail(key: Key, origin: string, email: string): { profile: string; sig: string } {
  return { profile: key.address, sig: signAs(key, key.address, emailMessage(origin, key.address, email)) }
}
