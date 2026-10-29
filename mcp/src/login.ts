// The login: the MCP specification's authorization flow (2025-11-25), with this copy as both the
// server the AI app calls and the authorization server that logs it in, kept stateless. An AI app
// finds the flow from a 401 (Protected Resource Metadata, then Authorization Server Metadata),
// registers by a client document (CIMD) or by registration (DCR), and sends the person to
// /authorize. From there the person goes to the app's connect page (APP_URL), where, on their yes,
// their app makes an access key for each profile they ticked, lists it in that profile's entry, and
// hands back a pack locked to this copy's open key (pack.ts); back at /connected, this copy opens
// the pack, checks it is for this login, and gives the AI app a code, which /token turns into an
// access token carrying the pack.
//
// Nothing is stored: a registered client's id, a login request, a code and a token are each a body
// this copy wrote, with an HMAC-SHA256 under its own 32-byte key, kept in DATA_DIR. Only this copy
// checks them, so a MAC is enough: no public half is needed. The MAC covers the kind, so a code is
// never a token. What one cannot hold without a store: a code works more than once in its 60
// seconds (only the AI app holding its PKCE verifier can use it). A token carries no expiry, so
// there is no refresh token: what it can do ends when the person removes its access keys from
// their profile entries, which every host and reader then counts for nothing.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { b64u } from '@foundationforest/folders'
import type { OpeningHalf } from '@foundationforest/keys'
import { isObject, readJson } from './forest.ts'
import { json, page, readBody } from './http.ts'
import { type Pack, openPack, requestHash } from './pack.ts'

/** How long the person has on the connect page: to unlock their device and tick the profiles the AI app acts in. */
export const REQUEST_MS = 10 * 60_000
/** How long a code lasts: the AI app redeems it as soon as the person is sent back to it. */
export const CODE_MS = 60_000
/** A client document: at most this many bytes, read within this many ms. */
const CLIENT_DOC_BYTES = 65_536
const CLIENT_DOC_MS = 10_000
/** A registration: at most this many redirect addresses, each at most this long, in a body at most this long. */
const MAX_REDIRECTS = 8
const MAX_REDIRECT = 512
const MAX_FORM = 65_536

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic']

/** A redirect address the login takes: https, or http on loopback, with no fragment. */
function isRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_REDIRECT || !URL.canParse(value)) return false
  const u = new URL(value)
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  return !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))
}

/** Two resource addresses for one server: equal once parsed, so a trailing slash does not matter. */
function sameResource(a: unknown, b: string): boolean {
  return typeof a === 'string' && URL.canParse(a) && new URL(a).href === new URL(b).href
}

type Body = { [key: string]: unknown }
type Client = { id: string; name: string; redirects: string[] }

export type LoginSettings = {
  /** This copy's origin: the authorization server and the resource. */
  origin: string
  /** The app's connect page; without it, logins wait. */
  appUrl?: string
  /** How a client document is fetched: publicFetch (public.ts), which reaches only public addresses. */
  clientFetch: typeof fetch
}

export class Login {
  private readonly key: Buffer
  private readonly opening: OpeningHalf
  private readonly settings: LoginSettings

  constructor(key: Buffer, opening: OpeningHalf, settings: LoginSettings) {
    this.key = key
    this.opening = opening
    this.settings = settings
  }

  private mac(kind: string, text: string): string {
    return b64u.encode(createHmac('sha256', this.key).update(`forest-mcp/v1/${kind}\n${text}`).digest())
  }

  /** A body of `kind`, as text only this copy can write: the body's JSON in base64url, a dot, its MAC. */
  sign(kind: string, body: Body): string {
    const text = b64u.encode(Buffer.from(JSON.stringify(body), 'utf8'))
    return `${text}.${this.mac(kind, text)}`
  }

  /** The body of `kind` this copy wrote as `token`, or null. */
  read(kind: string, token: unknown): Body | null {
    if (typeof token !== 'string') return null
    const [text, mac, ...rest] = token.split('.')
    if (rest.length || !text || !mac) return null
    const want = Buffer.from(this.mac(kind, text))
    const got = Buffer.from(mac)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    try {
      const body = JSON.parse(Buffer.from(b64u.decode(text)).toString('utf8')) as unknown
      return isObject(body) ? body : null
    } catch {
      return null
    }
  }

  private get origin(): string {
    return this.settings.origin
  }

  /** Where the AI app learns how to log in: the 401's challenge names it. */
  get resourceMetadataUrl(): string {
    return `${this.origin}/.well-known/oauth-protected-resource`
  }

  /** The Protected Resource Metadata (RFC 9728). */
  protectedResource(res: ServerResponse): void {
    json(res, 200, { resource: this.origin, authorization_servers: [this.origin], bearer_methods_supported: ['header'], resource_name: 'Forest' })
  }

  /** The Authorization Server Metadata (RFC 8414). */
  authorizationServer(res: ServerResponse): void {
    json(res, 200, {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      registration_endpoint: `${this.origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
  }

  /** A 401: no login, or (`invalid`) one this copy does not take. */
  challenge(res: ServerResponse, invalid: boolean): void {
    const error = invalid ? ', error="invalid_token", error_description="this login is not one this server gave"' : ''
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.resourceMetadataUrl}"${error}`, 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: invalid ? 'Log in again: this login is not one this server gave.' : 'Acting for the person needs a login.' } }))
  }

  /** The pack a request's token carries, still locked; null with no token; 'bad' for one this copy did not give, or one from before packs. */
  bearer(req: IncomingMessage): string | null | 'bad' {
    const header = req.headers.authorization
    if (header === undefined) return null
    const token = this.read('access', /^Bearer (\S+)$/i.exec(header)?.[1])
    if (!token || !sameResource(token.aud, this.origin) || typeof token.pack !== 'string') return 'bad'
    return token.pack
  }

  /** What /open-key answers: the open key a person's app locks the pack to, readable from the app's own page. */
  openKey(res: ServerResponse): void {
    json(res, 200, { openKey: this.opening.openKey }, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' })
  }

  /** A pack a token carries, opened for one request with this copy's identity. */
  open(pack: unknown) {
    return openPack(pack, this.opening.identity)
  }

  /** A client secret, for a registered client that asked for one: made from its id, so nothing is kept. */
  private secret(clientId: string): string {
    return this.mac('secret', clientId)
  }

  /** Registration (RFC 7591): the client's id holds what it registered, under this copy's MAC. */
  async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (error: string, description: string) => json(res, 400, { error, error_description: description })
    let meta: unknown
    try {
      meta = JSON.parse(await readBody(req, MAX_FORM))
    } catch {
      return fail('invalid_client_metadata', 'the body is a JSON object')
    }
    if (!isObject(meta)) return fail('invalid_client_metadata', 'the body is a JSON object')
    const redirects = meta.redirect_uris
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > MAX_REDIRECTS || !redirects.every(isRedirect)) {
      return fail('invalid_redirect_uri', `redirect_uris is 1 to ${MAX_REDIRECTS} addresses, each https or http on loopback, with no fragment`)
    }
    // RFC 7591's default when none is named.
    const auth = meta.token_endpoint_auth_method ?? 'client_secret_basic'
    if (typeof auth !== 'string' || !AUTH_METHODS.includes(auth)) return fail('invalid_client_metadata', `token_endpoint_auth_method is one of ${AUTH_METHODS.join(', ')}`)
    if (meta.grant_types !== undefined && !(Array.isArray(meta.grant_types) && meta.grant_types.includes('authorization_code'))) return fail('invalid_client_metadata', 'grant_types holds authorization_code')
    if (meta.response_types !== undefined && !(Array.isArray(meta.response_types) && meta.response_types.includes('code'))) return fail('invalid_client_metadata', 'response_types holds code')
    const name = typeof meta.client_name === 'string' && meta.client_name.trim() ? meta.client_name.trim().slice(0, 100) : new URL(redirects[0]).host
    const id = this.sign('client', { redirects, name, auth })
    json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: auth,
      ...(auth !== 'none' && { client_secret: this.secret(id), client_secret_expires_at: 0 }),
    })
  }

  /** The client an id names: a client document at an https address, or one this copy registered; else why not. */
  private async client(id: string | null): Promise<Client | string> {
    if (!id) return 'The AI app gave no client_id.'
    if (!id.startsWith('https://')) {
      const c = this.read('client', id)
      return c ? { id, name: c.name as string, redirects: c.redirects as string[] } : "The AI app's client_id is not one this server registered, nor a client document's https address."
    }
    if (!URL.canParse(id) || new URL(id).pathname === '/' || new URL(id).hash) return "A client document's address is https, with a path."
    let doc: unknown
    try {
      doc = await readJson(id, this.settings.clientFetch, CLIENT_DOC_BYTES, CLIENT_DOC_MS)
    } catch (err) {
      return `The AI app's client document at ${id} could not be read: ${(err as Error).message}.`
    }
    if (!isObject(doc) || doc.client_id !== id) return `The document at ${id} does not name itself as its client_id.`
    const redirects = doc.redirect_uris
    if (!Array.isArray(redirects) || !redirects.length || !redirects.every(isRedirect)) return `The document at ${id} lists no redirect address this server takes.`
    const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : new URL(id).host
    return { id, name, redirects }
  }

  /** The person's browser, sent to `to` with `params` added. */
  private back(res: ServerResponse, to: string, params: { [name: string]: string }): void {
    const url = new URL(to)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    res.writeHead(302, { location: url.href, 'cache-control': 'no-store' }).end()
  }

  /**
   * The authorization request: checked, then on to the app's connect page with a login request only
   * this copy can write: base64url of a JSON object holding the AI app's `name` and `redirect`,
   * which the page shows the person, a dot, then this copy's MAC.
   */
  async authorize(url: URL, res: ServerResponse): Promise<void> {
    if (!this.settings.appUrl) return page(res, 503, "Logins here wait for the Forest app's connect page, which is not set up yet. Reading works without a login.")
    const q = url.searchParams
    const client = await this.client(q.get('client_id'))
    if (typeof client === 'string') return page(res, 400, client)
    const redirect = q.get('redirect_uri') ?? (client.redirects.length === 1 ? client.redirects[0]! : null)
    if (!redirect || !client.redirects.includes(redirect)) return page(res, 400, `${redirect ?? 'No redirect_uri'} is not one of ${client.name}'s redirect addresses.`)
    const state = q.get('state')
    const fail = (error: string, description: string) => this.back(res, redirect, { error, error_description: description, ...(state !== null && { state }), iss: this.origin })
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type is code')
    const challenge = q.get('code_challenge')
    if (!challenge || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'a PKCE code_challenge with S256 is needed')
    const resource = q.get('resource') ?? this.origin
    if (!sameResource(resource, this.origin)) return fail('invalid_target', `this server is ${this.origin}`)
    const request = this.sign('request', { client: client.id, name: client.name, redirect, challenge, ...(state !== null && { state }), resource, exp: Date.now() + REQUEST_MS })
    this.back(res, this.settings.appUrl, { connector: this.origin, request })
  }

  /** Back from the connect page: the pack, opened and checked to be for this login, then a code for the AI app carrying it. */
  async connected(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams
    const text = q.get('request') ?? ''
    const request = this.read('request', text)
    if (!request) return page(res, 400, 'This login was not made here, or was changed on the way.')
    if (Date.now() > (request.exp as number)) return page(res, 400, 'This login took more than 10 minutes. Start again from the AI app.')
    const redirect = request.redirect as string
    const after = { ...(typeof request.state === 'string' && { state: request.state }), iss: this.origin }
    if (q.has('error')) return this.back(res, redirect, { error: 'access_denied', error_description: 'the person said no', ...after })
    const pack = q.get('pack')
    let opened: Pack
    try {
      opened = await this.open(pack)
    } catch (err) {
      return page(res, 400, `The app's answer gives no access: ${(err as Error).message}.`)
    }
    if (opened.request !== requestHash(text)) return page(res, 400, "The app's answer is for another login, so it gives no access here.")
    const code = this.sign('code', { pack, client: request.client, redirect, challenge: request.challenge, resource: request.resource, exp: Date.now() + CODE_MS })
    this.back(res, redirect, { code, ...after })
  }

  /** The token request: the code, the client, the redirect, the PKCE verifier and the resource it was made for. */
  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (status: number, error: string, description: string) => json(res, status, { error, error_description: description }, { 'cache-control': 'no-store' })
    let form: URLSearchParams
    try {
      form = new URLSearchParams(await readBody(req, MAX_FORM))
    } catch {
      return deny(400, 'invalid_request', `a form of at most ${MAX_FORM} bytes`)
    }
    if (form.get('grant_type') !== 'authorization_code') return deny(400, 'unsupported_grant_type', 'grant_type is authorization_code')
    let clientId = form.get('client_id')
    let secret = form.get('client_secret')
    const basic = /^Basic (\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (basic) {
      const [id = '', pass = ''] = Buffer.from(basic, 'base64').toString('utf8').split(':')
      clientId = decodeURIComponent(id)
      secret = decodeURIComponent(pass)
    }
    if (!clientId) return deny(401, 'invalid_client', 'client_id is needed')
    const code = this.read('code', form.get('code'))
    if (!code || Date.now() > (code.exp as number)) return deny(400, 'invalid_grant', 'the code is not one this server gave, or its 60 seconds are over')
    if (clientId !== code.client) return deny(400, 'invalid_grant', 'the code was given to another client')
    const registered = clientId.startsWith('https://') ? null : this.read('client', clientId)
    if (registered && registered.auth !== 'none') {
      const want = Buffer.from(this.secret(clientId))
      const got = Buffer.from(secret ?? '')
      if (want.length !== got.length || !timingSafeEqual(want, got)) return deny(401, 'invalid_client', 'the client secret is not the one this server gave')
    }
    const redirect = form.get('redirect_uri')
    if (redirect !== null && redirect !== code.redirect) return deny(400, 'invalid_grant', 'redirect_uri is not the one the login was made with')
    const verifier = form.get('code_verifier')
    if (!verifier || b64u.encode(createHash('sha256').update(verifier).digest()) !== code.challenge) return deny(400, 'invalid_grant', 'code_verifier does not match the code challenge')
    const resource = form.get('resource')
    if (resource !== null && !sameResource(resource, code.resource as string)) return deny(400, 'invalid_target', `the code was made for ${code.resource as string}`)
    const access = this.sign('access', { pack: code.pack, client: code.client, aud: code.resource })
    json(res, 200, { access_token: access, token_type: 'Bearer' }, { 'cache-control': 'no-store' })
  }
}
