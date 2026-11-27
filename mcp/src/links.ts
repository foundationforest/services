// The links the AI hands the person, written once. Two kinds:
//
// - The person's own things and what needs their passkey are the Forest app's. The app's origin is
//   APP_URL's; what a link is about comes after #, which a browser never sends to a server, so the
//   app's host never learns which profile or listing it was. The app's chat builds these same
//   strings, so they are written exactly as it does: only the label's `/` is kept as it is, since a
//   market, a role, an id and an address are made of characters a fragment takes as they are.
// - Other people's things are the index's pages, never the app's.
//
// No link to buy credits or to any checkout exists here: a profile that runs out says to add credits
// in the Forest app, with no link.

import type { Context } from './forest.ts'

/** The app's origin, from APP_URL; undefined with none, and then no tool gives an app link. */
export const appOrigin = (appUrl: string | undefined): string | undefined => (appUrl ? new URL(appUrl).origin : undefined)

/** A part of a link's fragment: encoded, with a label's `/` kept. */
const part = (text: string) => encodeURIComponent(text).replaceAll('%2F', '/')

/** The app's links, each undefined without an app. */
export function appLinks(app: string | undefined) {
  const at = (rest: string) => (app === undefined ? undefined : `${app}${rest}`)
  return {
    /** Make a profile in a market, as a role. */
    newProfile: (market: string, role: string) => at(`/new#market=${part(market)}&role=${part(role)}`),
    /** One of their listings: photos are added there. */
    listing: (label: string, id: string) => at(`/listing#label=${part(label)}&id=${part(id)}`),
    /** A conversation, to send a photo, a proof or their location. */
    thread: (label: string, address: string) => at(`/thread#label=${part(label)}&with=${part(address)}`),
    /** Get verified, or add the ID check. */
    id: () => at('/id'),
    /** Which profiles the AI uses. */
    aiApps: () => at('/ai-apps'),
    /** Anything else: email, passkeys. */
    you: () => at('/you'),
  }
}

const base = (ctx: Context) => ctx.index.replace(/\/+$/, '')

/** A profile's page at the index. */
export const profilePage = (ctx: Context, address: string) => `${base(ctx)}/profiles/${encodeURIComponent(address)}`

/** The same search, as a page at the index for the person to open. */
export const searchPage = (ctx: Context, filters: { [name: string]: string }) => {
  const query = new URLSearchParams(filters).toString()
  return `${base(ctx)}/search${query ? `?${query}` : ''}`
}
