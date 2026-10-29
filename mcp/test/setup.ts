// What the tests act on, all on loopback: this repo's host (its plug, host/src/plug.ts), which the
// person's app, the stranger and this copy write to; a stand-in index serving its skill.md and three
// answers in the index's JSON as it is now, each with a field this copy has never seen, and a search
// that answers with what it was asked; a stand-in for the app's connect page, where the reference
// app (app.ts) makes the connection for the profiles the person ticks and hands back its pointer;
// and this copy, started in-process, reading the index, reaching the loopback host.
//
// Two people:
// - the person, whose app holds three profiles, tutoring/tutor, tutoring/student and
//   clothing/seller;
// - a stranger, a tutoring/tutor with three offers, physics, chemistry and biology, whose folder
//   takes inbox entries.
//
// And an AI app: the MCP SDK's own client, with an OAuth provider that follows the browser's
// redirects through the login, by registration (DCR) or by a client document (CIMD).

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { type Body, entry, write } from '@foundationforest/folders'
import { type MainKey, mainKey, newSeed, openingHalf, payAddresses } from '@foundationforest/keys'
import { Host } from '../../host/src/plug.ts'
import { type Served, serve } from '../src/server.ts'
import { App, type Choice } from './app.ts'

export const TUTORING = JSON.parse(readFileSync(new URL('../../markets/markets/tutoring.json', import.meta.url), 'utf8'))

/** A post that fits tutoring's post fields. */
export const lesson = (description: string): Body => ({
  description,
  price: { amount: '30', currency: 'USD', per: 'hour' },
  subjects: ['maths', 'physics'],
  levels: ['secondary'],
  place: { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid', online: true },
  hours: { zone: 'Europe/Madrid', slots: [{ days: ['tuesday', 'thursday'], from: '18:00', to: '20:00' }] },
})

/** What the person ticks at the connect page, unless a test says otherwise: their two tutoring profiles, every switch. */
export const CHOICE: Choice = { profiles: ['tutoring/tutor', 'tutoring/student'] }

/** Where the AI app is sent back to, and where it keeps its client document: never fetched over the network. */
export const REDIRECT = 'https://ai-app.example/callback'
export const CLIENT_DOCUMENT = 'https://ai-app.example/client.json'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const close = (server: Server) => new Promise((resolve) => server.close(resolve))

/** What the stand-in index says about itself, for AI agents. */
export const SKILL = '# A stand-in index\n\nEach answer here holds badge, a field the mcp has never seen, and search takes badge as a filter.\n'

/**
 * The stand-in index: its skill.md, and three answers in the index's JSON as it is now, each with
 * `badge`, a field the mcp has never seen. Its search answers with `asked` too: the filters it got.
 */
async function standIn(stranger: string, post: string): Promise<{ url: string; server: Server; said: World['said'] }> {
  const checks = [{ verifier: 'verifier.forest.foundation', key: '7XtHEJ8gL8hMm4TbSpjtx4fvjsT4zz7FRdYW6V1nF3GC', label: 'face check' }]
  const shown = { ratings: { value: 9.2, count: 14 }, trust: 42, uniqueness: 75 }
  const result = { profile: stranger, market: 'tutoring', role: 'tutor', post: { address: post, body: lesson('Physics, from the stranger.') }, ...shown, checks }
  const badge = 'early'
  const said: World['said'] = {
    '/skill.md': SKILL,
    '/index.json': { index: 'stand-in', markets: [{ name: 'tutoring', description: TUTORING.description, roles: ['tutor', 'student'] }], lists: {}, badge },
    '/search.json': { index: 'stand-in', total: 1, results: [result], badge },
    [`/profiles/${stranger}.json`]: { index: 'stand-in', address: stranger, profile: { market: 'tutoring', role: 'tutor' }, checks, ...shown, posts: [], reviews: { received: [], given: [] }, proofs: [], badge },
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = said[url.pathname]
    if (body === undefined) res.writeHead(404).end()
    else if (typeof body === 'string') res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }).end(body)
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(url.pathname === '/search.json' ? { ...body, asked: Object.fromEntries(url.searchParams) } : body))
  })
  return { url: await listen(server), server, said }
}

/** The stand-in connect page: hands the login to the person's app, with what the person chooses (`page.choice`), and sends the browser where it says. */
async function connectPage(app: App): Promise<{ url: string; server: Server; choice: Choice }> {
  const page = { url: '', server: undefined as unknown as Server, choice: CHOICE }
  page.server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    app
      .connect(q.get('connector')!, q.get('request')!, page.choice)
      .then((to) => res.writeHead(302, { location: to }).end())
      .catch((err: Error) => res.writeHead(500).end(err.message))
  })
  page.url = await listen(page.server)
  return page
}

/** The AI app's side of the login, as the MCP SDK runs it: what it registered, its tokens, its PKCE verifier, and where it sent the browser. */
export class AiApp implements OAuthClientProvider {
  readonly clientMetadataUrl: string | undefined
  private info: OAuthClientInformationMixed | undefined
  private saved: OAuthTokens | undefined
  private verifier = ''
  authorization: URL | undefined

  constructor(how: 'dcr' | 'cimd' = 'dcr') {
    this.clientMetadataUrl = how === 'cimd' ? CLIENT_DOCUMENT : undefined
  }
  get redirectUrl() {
    return REDIRECT
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'An AI app', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }
  clientInformation() {
    return this.info
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorization = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

/** The client document the AI app keeps at CLIENT_DOCUMENT. */
export const clientDocument = { client_id: CLIENT_DOCUMENT, client_name: 'An AI app', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }

/** How this copy fetches client documents in the tests: the AI app's, served here; nothing else. */
export const clientFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input)
  return url === CLIENT_DOCUMENT ? new Response(JSON.stringify(clientDocument), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 })
}

/** The person's browser, from `from` through every redirect, until it reaches the AI app: what the AI app gets there. */
export async function browse(from: URL | string): Promise<URLSearchParams> {
  let url = String(from)
  for (let hops = 0; hops < 6; hops++) {
    if (url.startsWith(REDIRECT)) return new URL(url).searchParams
    const res = await fetch(url, { redirect: 'manual' })
    const to = res.headers.get('location')
    if (!to) throw new Error(`${url} answered ${res.status}: ${await res.text()}`)
    url = new URL(to, url).href
  }
  throw new Error('too many redirects')
}

/** An AI app's client on `mcp`, connected with no login, as a chat starts. */
export async function aiApp(mcp: string, app = new AiApp()): Promise<{ client: Client; transport: StreamableHTTPClientTransport; app: AiApp }> {
  const transport = new StreamableHTTPClientTransport(new URL(mcp), { authProvider: app })
  const client = new Client({ name: 'an-ai-app', version: '0' })
  await client.connect(transport)
  return { client, transport, app }
}

/** The login, as an AI app goes through it: a call to a tool that acts for the person gets the challenge, the person goes through the connect page, the code becomes a token. Gives back the code's query. */
export async function logIn(c: { client: Client; transport: StreamableHTTPClientTransport; app: AiApp }): Promise<URLSearchParams> {
  await assert.rejects(c.client.callTool({ name: 'my_profiles', arguments: {} }), UnauthorizedError)
  const back = await browse(c.app.authorization!)
  await c.transport.finishAuth(back.get('code')!)
  return back
}

/** A stranger: a tutoring tutor whose folder takes inbox entries, with its open key's identity. */
export type Stranger = { address: string; post: string; posts: { [subject: string]: string }; tutor: MainKey; identity: string }

export type World = {
  mcp: Served
  host: string
  /** The stand-in index, and the stand-in connect page. */
  index: string
  /** What the stand-in index serves, by path; its search adds `asked`. */
  said: { [path: string]: unknown }
  appUrl: string
  /** What the person chooses at the connect page, from now on. */
  choose: (choice: Choice) => void
  /** The person's app. */
  app: App
  /** The person's seed, for the tests to make their keys: never given to an AI app. */
  seed: Uint8Array
  /** The person's profiles' addresses, by label: for the tests to read their hosts, never given to an AI app. */
  own: { [label: string]: string }
  stranger: Stranger
  dataDir: string
  close: () => Promise<void>
}

/** The world, with this copy given the connect page unless told to wait for one. */
export async function world(options: { noApp?: boolean } = {}): Promise<World> {
  const host = new Host()
  await host.listen()
  const hosts = [host.url!]

  const seed = newSeed()
  const app = new App({ seed, hosts })
  const own: World['own'] = {}
  for (const label of ['tutoring/tutor', 'tutoring/student', 'clothing/seller']) own[label] = await app.addProfile(label)

  const strangerSeed = newSeed()
  const tutor = await mainKey(strangerSeed, 'tutoring/tutor')
  const opening = await openingHalf(tutor.secret)
  const now = Date.now()
  // Only its Solana pay address: a profile's pay may list any of the chains.
  const pay = { solana: (await payAddresses(strangerSeed, 'tutoring/tutor')).solana }
  const profile = { market: 'tutoring', role: 'tutor', hosts, openKey: opening.openKey, pay }
  const subjects = ['physics', 'chemistry', 'biology']
  const posted = subjects.map((s) => entry(tutor, `post/${s}`, lesson(`${s[0]!.toUpperCase()}${s.slice(1)}, from the stranger.`), now))
  await write(hosts, [entry(tutor, 'profile', profile, now), ...posted])
  const post = `${tutor.address}/post/physics`

  const index = await standIn(tutor.address, post)
  const page = await connectPage(app)
  const dataDir = mkdtempSync(join(tmpdir(), 'forest-mcp-'))
  const mcp = await serve({ ...(!options.noApp && { appUrl: page.url }), dataDir, read: { index: index.url }, clientFetch, hostFetch: fetch }, '127.0.0.1', 0)

  return {
    mcp,
    host: host.url!,
    index: index.url,
    said: index.said,
    appUrl: page.url,
    choose: (choice) => {
      page.choice = choice
    },
    app,
    seed,
    own,
    stranger: { address: tutor.address, post, posts: Object.fromEntries(subjects.map((s) => [s, `${tutor.address}/post/${s}`])), tutor, identity: opening.identity },
    dataDir,
    close: async () => {
      await mcp.close()
      await close(index.server)
      await close(page.server)
      await host.close()
    },
  }
}
