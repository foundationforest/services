// The connections service: an MCP server an assistant connects to with OAuth, so it can post offers
// and reviews for one profile without ever holding the profile's key.
//
// OAuth (the MCP SDK's own authorization server router, unchanged): the assistant registers itself,
// then sends the person to /authorize. The person names their profile; this service makes one
// writer key for the connection and shows its address. The person adds that writer key to their
// profile's permissions record in their own app, which signs it with the profile's key. Once a host
// the profile names shows the key on the list, for offers and reviews, the grant goes through and
// the assistant gets its tokens. From then on its token is that connection: the profile and the
// writer key, and nothing else (tools.ts).
//
// What a person sends goes in a form's body, never in a URL: hosting platforms log paths. The page
// that waits for the permissions record carries only the connection's random id. No request is
// logged, and no network address is kept.

import { randomBytes } from 'node:crypto'
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
import express, { type Response } from 'express'

import { keyFromPrivate, normalizeOrigin, pathCovers, publicKeyFromAddress, readProfile } from '../../forest/records/src/index.ts'

import { connectedPage, gonePage, namePage, PAGE_POLICY, waitPage } from './pages.ts'
import { ACCESS_MS, type Connection, Store } from './store.ts'
import { toolServer } from './tools.ts'

export type Config = {
  /** This service's own https origin: the OAuth issuer, and the MCP server at `/mcp`. */
  publicUrl: string
  /** The hosts it reads a profile from first; it then reads the hosts the profile's hosts record names. */
  hosts: string[]
  /** The one file: assistants, connections and their writer keys, codes and tokens. */
  databasePath: string
  port: number
}

/** The paths a connection's writer key must be listed for. */
export const PATHS = ['offer', 'review']

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/** Reads the variables `README.md` lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['PUBLIC_URL', 'HOSTS'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const publicUrl = new URL(env.PUBLIC_URL!.trim())
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_URL is an origin, with no path')
  const hosts = env.HOSTS!.split(',').map((h) => h.trim()).filter(Boolean)
  for (const h of hosts) if (normalizeOrigin(h) !== h) throw new Error(`HOSTS: ${h} is not a host's origin`)
  return {
    publicUrl: publicUrl.origin,
    hosts,
    databasePath: env.DATABASE_PATH || './data/connections.sqlite',
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

/** Whether a profile's current permissions list this writer key for every path a connection needs, now. */
export function listed(writers: { key: string; paths: string[]; until?: number }[], key: string, now: number): boolean {
  return writers.some((w) => w.key === key && PATHS.every((p) => w.paths.some((q) => pathCovers(q, p))) && (w.until === undefined || now < w.until))
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

  /** The person's first page: a connection waiting for them, and the form naming the profile. */
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
    page(res, 200, namePage(id, client.client_name ?? null))
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

export type Service = { url: string; server: HttpServer; store: Store; close(): Promise<void> }

export async function startConnections(config: Config, options: { now?: () => number } = {}): Promise<Service> {
  const now = options.now ?? Date.now
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true })
  const store = new Store(config.databasePath)
  const mcpUrl = new URL('/mcp', config.publicUrl)
  const provider = new Provider(store, mcpUrl, now)

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
      .send('Forest connections: an MCP server at /mcp that lets an assistant post offers and reviews for a profile, with a writer key the profile allows. It holds no profile key.\n')
  })

  // The person names the profile: a writer key is made for this connection, once.
  app.post('/connect/:id', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const c = store.connection(req.params.id)
    if (!c || c.granted || c.expires <= now()) return page(res, 404, gonePage())
    const profile = String(req.body?.profile ?? '').trim()
    if (!publicKeyFromAddress(profile)) return page(res, 400, namePage(c.id, null, 'That is not a profile’s address. Copy it from your Forest app.'))
    if (!c.profile) store.name(c.id, profile, new Uint8Array(randomBytes(32)))
    res.redirect(303, `/connect/${c.id}`)
  })

  // Waiting for the profile's permissions record to list the writer key; then the grant.
  app.get('/connect/:id', async (req, res) => {
    const c = store.connection(req.params.id)
    if (!c || c.expires <= now() || !c.pending) return page(res, 404, gonePage())
    if (!c.profile || !c.writerKey) return page(res, 200, namePage(c.id, null))
    if (c.granted) return page(res, 200, connectedPage())
    const writer = keyFromPrivate(c.writerKey).address
    let ok = false
    try {
      const view = await readProfile(config.hosts, c.profile, now())
      ok = listed(view.writers, writer, now())
    } catch {
      ok = false
    }
    if (!ok) return page(res, 200, waitPage(c.id, c.profile, writer, PATHS))
    const code = store.grant(c.id, now())
    const back = new URL(c.pending.redirectUri)
    back.searchParams.set('code', code)
    if (c.pending.state !== null) back.searchParams.set('state', c.pending.state)
    res.redirect(302, back.href)
  })

  app.post(
    '/mcp',
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl }),
    express.json({ limit: '128kb' }),
    async (req, res) => {
      const c = store.connection(String(req.auth?.extra?.connection ?? ''))
      if (!c?.granted || !c.profile || !c.writerKey) return void res.status(401).json({ error: 'invalid_token' })
      // Stateless: one server and one transport per request, answered as JSON.
      const server = toolServer({ profile: c.profile, writerKey: c.writerKey }, config.hosts)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    },
  )
  app.all('/mcp', (_req, res) => void res.status(405).set('allow', 'POST').json({ error: 'post_only' }))

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s))
    s.once('error', reject)
  })
  const hourly = setInterval(() => store.prune(now()), 3_600_000).unref()

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    store,
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
