// The key holder behind connections: it holds the access keys a person's app hands it, for a party
// that can log in but cannot keep a key (an AI assistant, today), and acts with them through tools.
//
// OAuth (the MCP SDK's own authorization server router, unchanged): the assistant registers itself,
// then sends the person to /authorize, which opens a connection and shows them a link. Their app
// makes the access keys (write, message, read; never pay), lists them in the profile's permissions
// record with the main key, and posts them to that link in forest's grant shape. Once a host the
// profile names lists every key, the grant goes through and the assistant gets its tokens. From
// then on its token is that connection: the profile and its keys, and nothing else (tools.ts),
// on two doors: MCP at /mcp, and plain HTTP at /v1/tools.
//
// The keys live in the key store (keys.ts), encrypted; this file never reads a private half. What a
// person sends goes in a request's body, never in a URL: hosting platforms log paths. The link
// carries only the connection's random id. No request is logged, and no network address is kept.

import { mkdirSync } from 'node:fs'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import express, { type Request, type Response } from 'express'

import { type AccessKey, type Grant, MAX_ACCESS_KEYS, RecordError, checkGrant, normalizeOrigin, readProfile } from '../../forest/records/src/index.ts'

import { FileKeys, type Held, type KeyStore, addressOf } from './keys.ts'
import { connectPage, connectedPage, gonePage, PAGE_POLICY, waitPage } from './pages.ts'
import { ACCESS_MS, type Connection, Store } from './store.ts'
import { type Context, callTool, listTools, toolServer } from './tools.ts'

export type Config = {
  /** This service's own https origin: the OAuth issuer, the MCP server at `/mcp`, the links it shows. */
  publicUrl: string
  /** The hosts it reads a profile from first; it then reads the hosts the profile's hosts record names. */
  hosts: string[]
  /** The index it reads markets and scores from: an origin. */
  index: string
  /** What the key store mixes the key that encrypts the keys from: at least 32 random characters. */
  secret: string
  /** The one file: assistants, connections, their keys (encrypted), codes and tokens. */
  databasePath: string
  port: number
}

/** Why it never holds a pay key, as it answers an app that hands one over. */
export const NO_PAY =
  'This key holder never holds a pay key. A key it holds can sign, so holding a pay key would let it move money; that needs signing inside an enclave with a cap, a later version.'

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

function origin(name: string, value: string): string {
  const url = new URL(value.trim())
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} is an origin, with no path`)
  return url.origin
}

/** Reads the variables `README.md` lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['PUBLIC_URL', 'HOSTS', 'INDEX', 'KEYHOLDER_SECRET'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const hosts = env.HOSTS!.split(',').map((h) => h.trim()).filter(Boolean)
  for (const h of hosts) if (normalizeOrigin(h) !== h) throw new Error(`HOSTS: ${h} is not a host's origin`)
  const secret = env.KEYHOLDER_SECRET!.trim()
  if (secret.length < 32) throw new Error('KEYHOLDER_SECRET is at least 32 random characters')
  return {
    publicUrl: origin('PUBLIC_URL', env.PUBLIC_URL!),
    hosts,
    index: origin('INDEX', env.INDEX!),
    secret,
    databasePath: env.DATABASE_PATH || './data/keyholder.sqlite',
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

/** Whether a profile's current permissions list every key a connection holds, each with its grant's scope. */
export function listed(access: readonly AccessKey[], held: readonly Held[]): boolean {
  return held.length > 0 && held.every((h) => access.some((k) => k.key === h.address && k.scope === h.scope))
}

/**
 * The grants an app hands over, checked: forest's shape for each, none a pay key, all for one
 * folder, none its main key, each key once, at most as many as a permissions record lists. Throws
 * a RecordError.
 */
export async function checkGrants(value: unknown): Promise<Grant[]> {
  const grants = (value as { grants?: unknown } | null)?.grants
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > MAX_ACCESS_KEYS) {
    throw new RecordError('grant', `the body is { "grants": [ … ] }, 1 to ${MAX_ACCESS_KEYS} grants`)
  }
  for (const g of grants) checkGrant(g)
  if (grants.some((g) => g.scope === 'pay')) throw new RecordError('pay', NO_PAY)
  if (new Set(grants.map((g) => g.folder)).size !== 1) throw new RecordError('grant', 'every grant is for one folder: the profile this connection acts for')
  const addresses = await Promise.all(grants.map(addressOf))
  if (addresses.includes(grants[0]!.folder)) throw new RecordError('grant', 'a main key is never handed over: only access keys')
  if (new Set(addresses).size !== grants.length) throw new RecordError('grant', 'each key once')
  return grants
}

/** The OAuth server: the SDK's router asks it everything, and it answers from the store. */
class Provider implements OAuthServerProvider {
  readonly #store: Store
  readonly #resource: URL
  readonly #now: () => number

  constructor(store: Store, resource: URL, now: () => number) {
    this.#store = store
    this.#resource = resource
    this.#now = now
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id) => this.#store.client(id) as OAuthClientInformationFull | undefined,
      registerClient: async (info) => {
        const client = info as OAuthClientInformationFull
        this.#store.addClient(client.client_id, client)
        return client
      },
    }
  }

  /** A connection waiting for the person, and their page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = this.#store.open(
      client.client_id,
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        scopes: params.scopes ?? [],
        resource: params.resource?.href ?? null,
      },
      this.#now(),
    )
    res.redirect(303, `/connect/${id}`)
  }

  #byCode(client: OAuthClientInformationFull, code: string): Connection {
    const c = this.#store.codeConnection(code, this.#now())
    if (!c || c.clientId !== client.client_id || !c.pending) throw new InvalidGrantError('the code is not good')
    return c
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.#byCode(client, code).pending!.codeChallenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.#byCode(client, code)
    if (redirectUri !== undefined && redirectUri !== c.pending!.redirectUri) throw new InvalidGrantError('the redirect is not the one the code was made for')
    if (!this.#store.spendCode(code)) throw new InvalidGrantError('the code was used')
    return this.#tokens(c.id)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const t = this.#store.token(refreshToken, 'refresh', this.#now())
    if (!t || t.connection.clientId !== client.client_id) throw new InvalidGrantError('the refresh token is not good')
    this.#store.drop(refreshToken)
    return this.#tokens(t.connection.id)
  }

  #tokens(connection: string): OAuthTokens {
    const { access, refresh } = this.#store.issue(connection, this.#now())
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.#store.token(token, 'access', this.#now())
    if (!t || !t.connection.granted) throw new InvalidTokenError('the token is not good')
    return { token, clientId: t.connection.clientId, scopes: [], expiresAt: Math.floor(t.expires / 1000), resource: this.#resource, extra: { connection: t.connection.id } }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    this.#store.drop(request.token)
  }
}

function page(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
    .send(html)
}

export type Service = { url: string; server: HttpServer; store: Store; keys: KeyStore; prune(): Promise<void>; close(): Promise<void> }

export async function startKeyholder(config: Config, options: { now?: () => number } = {}): Promise<Service> {
  const now = options.now ?? Date.now
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true })
  const store = new Store(config.databasePath)
  const keys: KeyStore = new FileKeys(store.db, config.secret)
  const mcpUrl = new URL('/mcp', config.publicUrl)
  const provider = new Provider(store, mcpUrl, now)
  /** End a connection: its keys first, so a crash between leaves nothing the next prune misses. */
  const end = async (id: string) => {
    await keys.drop(id)
    store.end(id)
  }

  const app = express()
  app.disable('x-powered-by')
  // The SDK's limits count each address in memory; none of them is used, so none is kept.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: mcpUrl,
      resourceName: 'Forest connections',
      authorizationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: false },
      revocationOptions: { rateLimit: false },
    }),
  )

  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        "Forest's key holder, behind connections: it holds the write, message and read keys a person's app hands it, never a pay key and never a main key, and acts with them for an assistant: MCP at /mcp, plain HTTP at /v1/tools.\n",
      )
  })

  /** A connection still waiting for the person, or null. */
  const waiting = (id: string) => {
    const c = store.connection(id)
    return c && !c.granted && c.pending && c.expires > now() ? c : null
  }

  // The app hands over the keys, once: forest's grants, in a JSON body.
  app.post('/connect/:id', express.json({ limit: '64kb' }), async (req, res) => {
    const c = waiting(req.params.id)
    if (!c) return void res.status(404).json({ ok: false, error: 'gone', message: 'This connection is gone: it ran out of time, or it was already made.' })
    let grants: Grant[]
    try {
      grants = await checkGrants(req.body)
    } catch (err) {
      const e = err as RecordError
      return void res.status(400).json({ ok: false, error: e.code ?? 'grant', message: e.message })
    }
    if (!store.take(c.id, grants[0]!.folder)) return void res.status(409).json({ ok: false, error: 'used', message: 'This connection already has its keys.' })
    await keys.put(c.id, grants)
    res.json({ ok: true, folder: grants[0]!.folder, keys: grants.length })
  })

  // The person's page: the link for their app; then waiting for the profile to list every key; then the grant.
  app.get('/connect/:id', async (req, res) => {
    const c = store.connection(req.params.id)
    if (c?.granted) return page(res, 200, connectedPage())
    if (!c || !waiting(c.id)) return page(res, 404, gonePage())
    if (!c.profile) {
      const client = store.client(c.clientId) as { client_name?: string } | undefined
      return page(res, 200, connectPage(c.id, client?.client_name ?? null, `${config.publicUrl}/connect/${c.id}`))
    }
    let ok = false
    try {
      const view = await readProfile(config.hosts, c.profile, now())
      ok = listed(view.access, await keys.held(c.id))
    } catch {
      ok = false
    }
    if (!ok) return page(res, 200, waitPage(c.id, c.profile))
    const code = store.grant(c.id, now())
    const back = new URL(c.pending!.redirectUri)
    back.searchParams.set('code', code)
    if (c.pending!.state !== null) back.searchParams.set('state', c.pending!.state)
    res.redirect(302, back.href)
  })

  // Both doors take the same token, and answer for its connection.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl })
  const context = (req: Request): Context | null => {
    const c = store.connection(String(req.auth?.extra?.connection ?? ''))
    if (!c?.granted || !c.profile) return null
    return { connection: c.id, profile: c.profile, keys, hosts: config.hosts, index: config.index, end: () => end(c.id) }
  }

  app.post('/mcp', bearer, express.json({ limit: '128kb' }), async (req, res) => {
    const c = context(req)
    if (!c) return void res.status(401).json({ error: 'invalid_token' })
    // Stateless: one server and one transport per request, answered as JSON.
    const server = toolServer(c)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
  app.all('/mcp', (_req, res) => void res.status(405).set('allow', 'POST').json({ error: 'post_only' }))

  app.get('/v1/tools', bearer, (req, res) => {
    if (!context(req)) return void res.status(401).json({ error: 'invalid_token' })
    res.json({ tools: listTools() })
  })
  app.post('/v1/tools/:name', bearer, express.json({ limit: '128kb' }), async (req, res) => {
    const c = context(req)
    if (!c) return void res.status(401).json({ error: 'invalid_token' })
    const out = await callTool(c, req.params.name as string, req.body)
    if (out.ok) res.json(out.data)
    else res.status(out.status).json({ error: out.error })
  })

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s))
    s.once('error', reject)
  })
  /** What the hour does: codes and tokens past their time go, and connections that are over end, keys first. */
  const prune = async () => {
    for (const id of store.prune(now())) await end(id)
  }
  const hourly = setInterval(() => void prune(), 3_600_000).unref()

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    store,
    keys,
    prune,
    async close() {
      clearInterval(hourly)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      store.close()
    },
  }
}
