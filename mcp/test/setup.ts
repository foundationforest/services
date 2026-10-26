// What the tests act on, all on loopback: the standard's reference host; a stand-in index serving
// the four answers this copy reads, in the index's JSON as it is now; a stand-in for the app's
// connect page, where the reference signer (signer.ts) makes the connection with the person's
// choice; and this copy, started in-process, reading the host and the index.
//
// Two people:
// - the person, whose signer holds three profiles, tutoring/tutor, tutoring/student and
//   clothing/seller, and pays with a stand-in that only counts;
// - a stranger, a tutoring/tutor with three offers, physics, chemistry and biology, who wrote to the
//   person's tutor profile.
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
import { inboxKey, mainKey, newSeed, payAddresses } from '@foundationforest/keys'
import { type Body, deliver, hostsRecord, ownerRecord, publish, readProfile } from '@foundationforest/records'
import { Host } from '@foundationforest/records/host'
import { message } from '@foundationforest/records/private'
import { type Served, serve } from '../src/server.ts'
import { type Choice, type PayWith, Signer } from './signer.ts'

export const TUTORING = JSON.parse(readFileSync(new URL('../../markets/markets/tutoring.json', import.meta.url), 'utf8'))

/** A post that fits tutoring's offer fields. */
export const lesson = (description: string): Body => ({
  description,
  price: { amount: '30', currency: 'USD', per: 'hour' },
  payment: ['direct', 'session'],
  subjects: ['maths', 'physics'],
  levels: ['secondary'],
  place: { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid', online: true },
  hours: { zone: 'Europe/Madrid', slots: [{ days: ['tuesday', 'thursday'], from: '18:00', to: '20:00' }] },
})

/** What the person chooses on the connect page, unless a test says otherwise: their two tutoring profiles, everything, $50 a day. */
export const CHOICE: Choice = { profiles: ['tutoring/tutor', 'tutoring/student'], can: ['post', 'message', 'read', 'pay'], limit: { amount: '50', currency: 'USD', per: 'day' } }

/** Where the AI app is sent back to, and where it keeps its client document: never fetched over the network. */
export const REDIRECT = 'https://ai-app.example/callback'
export const CLIENT_DOCUMENT = 'https://ai-app.example/client.json'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const close = (server: Server) => new Promise((resolve) => server.close(resolve))

/** The stand-in index: the four answers, in the index's JSON as #83 left it. */
async function standIn(stranger: string, offer: string): Promise<{ url: string; server: Server }> {
  const checks = [{ verifier: 'verifier.forest.foundation', key: '7XtHEJ8gL8hMm4TbSpjtx4fvjsT4zz7FRdYW6V1nF3GC', label: 'face' }]
  const rating = { value: 9.2, backing: 3.4, reviews: 14, statement: '{}', signature: 'x' }
  const result = { profile: stranger, market: 'tutoring', role: 'tutor', post: { address: offer, body: lesson('Physics, from the stranger.') }, rating, checks }
  const files: { [path: string]: unknown } = {
    '/index.json': { index: 'stand-in', markets: [{ name: 'tutoring', description: TUTORING.description, roles: ['tutor', 'student'] }], lists: {} },
    '/markets/tutoring.json': { index: 'stand-in', market: TUTORING, posts: { tutor: [result], student: [] } },
    '/search.json': { index: 'stand-in', total: 1, results: [result] },
    [`/profiles/${stranger}.json`]: { index: 'stand-in', address: stranger, profile: {}, checks, rating, posts: [], reviews: { received: [], given: [] }, proofs: [] },
  }
  const server = createServer((req, res) => {
    const body = files[new URL(req.url ?? '/', 'http://x').pathname]
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  return { url: await listen(server), server }
}

/** The stand-in connect page: hands the login to the person's signer, with the person's choice, and sends the browser where it says. */
async function connectPage(signer: Signer, choice: Choice): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    signer
      .connect(q.get('connector')!, q.get('request')!, choice)
      .then((to) => res.writeHead(302, { location: to }).end())
      .catch((err: Error) => res.writeHead(500).end(err.message))
  })
  return { url: await listen(server), server }
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

/** The login, as an AI app goes through it: a relayed tool's call gets the challenge, the person goes through the connect page, the code becomes a token. Gives back the code's query. */
export async function logIn(c: { client: Client; transport: StreamableHTTPClientTransport; app: AiApp }): Promise<URLSearchParams> {
  await assert.rejects(c.client.callTool({ name: 'profiles', arguments: {} }), UnauthorizedError)
  const back = await browse(c.app.authorization!)
  await c.transport.finishAuth(back.get('code')!)
  return back
}

export type World = {
  mcp: Served
  host: string
  /** The stand-in index, and the stand-in connect page. */
  index: string
  appUrl: string
  person: Signer
  /** The person's seed, for another of their devices in a test: never given to an AI app. */
  seed: Uint8Array
  /** The person's profiles' addresses, by label: for the tests to read their hosts, never given to an AI app. */
  own: { [label: string]: string }
  /** The stranger: `offer` is the physics one, and `offers` all three by subject. */
  stranger: { address: string; offer: string; offers: { [subject: string]: string }; tutor: Awaited<ReturnType<typeof mainKey>> }
  /** Every payment the person's signer made, with the evidence it gave back. */
  paid: Array<{ to: string; amount: string; evidence: string }>
  dataDir: string
  close: () => Promise<void>
}

/** The world, with this copy given `appUrl` unless told to wait for one. */
export async function world(options: { noApp?: boolean } = {}): Promise<World> {
  const host = new Host()
  await host.listen()
  const hosts = [host.url!]

  const paid: World['paid'] = []
  const payWith: PayWith = async ({ to, amount }) => {
    const evidence = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:stand-in-payment-${paid.length + 1}`
    paid.push({ to, amount, evidence })
    return evidence
  }
  const seed = newSeed()
  const person = new Signer({ seed, hosts, appUrl: 'https://app.forest.test', payWith })
  const own: World['own'] = {}
  for (const label of ['tutoring/tutor', 'tutoring/student', 'clothing/seller']) own[label] = await person.addProfile(label)
  const personTutor = own['tutoring/tutor']!

  const tutor = await mainKey(newSeed(), 'tutoring/tutor')
  const now = Date.now()
  const profile = { market: 'tutoring', role: 'tutor', inboxKey: (await inboxKey(tutor.secret)).encryptTo, inbox: { senders: 'anyone' }, pay: { ...(await payAddresses(newSeed(), 'tutoring/tutor')) } }
  const subjects = ['physics', 'chemistry', 'biology']
  const offered = subjects.map((s) => ownerRecord(tutor, `offer/${s}`, lesson(`${s[0]!.toUpperCase()}${s.slice(1)}, from the stranger.`), now))
  await publish(hosts, [hostsRecord(tutor, hosts, now), ownerRecord(tutor, 'profile', profile, now), ...offered])
  const theirs = (await readProfile(hosts, personTutor, Date.now())).current.get('profile')!.record.body!
  await deliver(hosts, [await message({ from: tutor, host: hosts[0]! }, personTutor, { text: 'Hello from a stranger: do you teach physics too?' }, Date.now(), theirs)])
  const offer = `${tutor.address}/offer/physics`

  const index = await standIn(tutor.address, offer)
  const page = await connectPage(person, CHOICE)
  const dataDir = mkdtempSync(join(tmpdir(), 'forest-mcp-'))
  const mcp = await serve({ ...(!options.noApp && { appUrl: page.url }), dataDir, read: { hosts, index: index.url }, clientFetch }, '127.0.0.1', 0)

  return {
    mcp,
    host: host.url!,
    index: index.url,
    appUrl: page.url,
    person,
    seed,
    own,
    stranger: { address: tutor.address, offer, offers: Object.fromEntries(subjects.map((s) => [s, `${tutor.address}/offer/${s}`])), tutor },
    paid,
    dataDir,
    close: async () => {
      person.close()
      await mcp.close()
      await close(index.server)
      await close(page.server)
      await host.close()
    },
  }
}
