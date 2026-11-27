// The links the AI hands the person, written once. Two kinds:
//
// - The person's own things and what needs their passkey are the Forest app's. The app's origin is
//   APP_URL's; what a link is about reads like a path after #, which a browser never sends to a
//   server, so the app's host never learns which profile or listing it was. A profile's path is its
//   label, <market>/<role>; the app builds these same paths, so they are written exactly as it does:
//   each part encoded, the label's `/` kept, though a market, a role, an id and an address are made
//   of characters a fragment takes as they are. A profile's link opens it, or makes it when the
//   person has none.
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
    /** One of their profiles, by its label, <market>/<role>: the app makes it when they have none. */
    profile: (label: string) => at(`/#/${part(label)}`),
    /** One of its listings: photos are added there. */
    listing: (label: string, id: string) => at(`/#/${part(label)}/listing/${part(id)}`),
    /** A conversation, to send a photo, a proof or their location. */
    conversation: (label: string, address: string) => at(`/#/${part(label)}/messages/${part(address)}`),
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
