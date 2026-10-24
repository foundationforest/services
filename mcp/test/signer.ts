// A reference signer: what Forest on a person's device does for the mcp, in plain code, for the app
// to read and for the tests (and the loop, later) to run. It holds the person's seed, keeps their
// vault in the standard's format, makes connections on the connect page, opens a socket to each
// connector its permissions name, and answers each ask by the person's permissions, exactly as the
// standard says (records/README.md, Permissions; keys/README.md, Signers):
//
// - an entry is for one who: here a connection, { connector, connection };
// - it acts on no entry it does not know whole (knowsPermission), nor on one that has ended;
// - `post` never covers a profile's profile record or its hosts record (and the vault is no
//   label's, so no ask reaches it): those it always asks the person about;
// - `pay` only within every limit that holds, counting what this who asked for over any day, week
//   or month;
// - anything no entry covers waits for the person's yes: here a link to open, and approve().
//
// Whatever it does, it signs with the profile's main key and publishes straight to the profile's
// hosts. Its answers carry no address of the person's: a message from one of their own profiles
// shows its label, and numbers stand in for messages.
//
// What is the app's and not the standard's, chosen here the simplest way: the connection keys are
// kept in the vault's settings (`connections`), so each of the person's signers can serve each
// connection; messages are numbered per connection, in memory; what a who spent is counted in
// memory; and a payment is made by the function the signer is given.

import { type KeyObject, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { type PayKey, inboxKey, mainKey, payAddresses, payKey, vaultKey } from '@foundationforest/keys'
import { type Body, RecordError, b64u, deliver, hostsRecord, nextTime, ownerRecord, publish, pull, pullRequest, readProfile } from '@foundationforest/records'
import { PERIODS, type Permission, type Vault, knowsPermission, message, openMessage, readVault, vaultRecord } from '@foundationforest/records/private'
import { LOGIN, REGISTER } from '../src/connection.ts'

export type Answer = { status: 'done'; result: Body } | { status: 'approval'; link: string; why: string } | { status: 'refused'; why: string }
/** A payment: from a pay key, to a Solana address, so many dollars, naming the post. Gives back its evidence, `<chain>:<id>`. */
export type PayWith = (payment: { from: PayKey; to: string; amount: string; memo: string }) => Promise<string>
/** What the person chose on the connect page: a permission without its who, or no. */
export type Choice = Omit<Permission, 'who'> | 'no'

type Connection = { connector: string; connection: string; secret: string }
type Numbered = { id: string; label: string; from: string }
type Ask = { connector: string; connection: string; tool: string; args: Body }

const done = (result: Body = {}): Answer => ({ status: 'done', result })
const refused = (why: string): Answer => ({ status: 'refused', why })

/** Decimal dollars, up to six places, as whole millionths. */
function micros(amount: string): bigint {
  const [whole, part = ''] = amount.split('.')
  return BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, '0'))
}

/** What each tool asks to do, in the standard's actions. `profiles` asks for nothing. */
const ACTION: { [tool: string]: string } = { post: 'post', remove: 'post', message: 'message', reply: 'message', inbox: 'read', pay: 'pay' }

/**
 * Whether an entry lets its who ask for `action` on the profile `label`, at `path` for a write: an
 * entry this signer knows whole, not ended, covering the profile and the action. `post` never covers
 * the profile record or the hosts record.
 */
export function permits(entry: Permission, label: string, action: string, path?: string, now = Date.now()): boolean {
  if (!knowsPermission(entry)) return false
  if (entry.until !== undefined && now > entry.until) return false
  if (entry.profiles !== 'all' && !entry.profiles.includes(label)) return false
  if (!entry.can.includes(action)) return false
  if (action === 'post' && (path === 'profile' || path === 'hosts')) return false
  return true
}

export class Signer {
  private readonly seed: Uint8Array
  private readonly hosts: string[]
  private readonly appUrl: string
  private readonly payWith: PayWith | undefined
  private vault: Vault = {}
  private vaultTime = -1
  /** One socket per connector, and its challenge. */
  private readonly sockets = new Map<string, { ws: WebSocket; challenge?: string }>()
  /** Each connection's numbered messages: number n is the (n-1)th. */
  private readonly numbers = new Map<string, Numbered[]>()
  /** What each who spent, and when. */
  private readonly spent: Array<{ who: string; label: string; micros: bigint; time: number }> = []
  /** What waits for the person's yes, by number. */
  private readonly waiting: Ask[] = []
  /** Every ask it answered, for the tests to count. */
  readonly asked: Array<{ tool: string; args: Body }> = []

  constructor(options: { seed: Uint8Array; hosts: string[]; appUrl: string; payWith?: PayWith }) {
    this.seed = options.seed
    this.hosts = options.hosts
    this.appUrl = options.appUrl
    this.payWith = options.payWith
  }

  // -------------------------------------------------------------------------------------------
  // The vault

  /** The vault, read from the hosts, or a new one. */
  async restore(): Promise<void> {
    const vk = await vaultKey(this.seed)
    const read = await readVault(this.hosts, { address: vk.address, identity: (await inboxKey(vk.secret)).identity }, Date.now())
    this.vault = read?.vault ?? {}
    this.vaultTime = read?.time ?? -1
  }

  /** The vault, written to the hosts, at a time past the last. */
  private async saveVault(): Promise<void> {
    const vk = await vaultKey(this.seed)
    const time = Math.max(Date.now(), this.vaultTime + 1)
    const records = [...(this.vaultTime < 0 ? [hostsRecord(vk, this.hosts, time)] : []), await vaultRecord(vk, (await inboxKey(vk.secret)).encryptTo, this.vault, time)]
    await publish(this.hosts, records)
    this.vaultTime = time
  }

  /** The person's permissions, as the vault holds them. */
  permissions(): Permission[] {
    return this.vault.permissions ?? []
  }

  /** The labels of the person's profiles. */
  labels(): string[] {
    return (this.vault.profiles ?? []).map((p) => p.label)
  }

  /** Every address of the person's: each profile's, its pay addresses, and the vault's. For the tests to look for. */
  async addresses(): Promise<string[]> {
    const out = [(await vaultKey(this.seed)).address]
    for (const label of this.labels()) out.push((await mainKey(this.seed, label)).address, ...Object.values(await payAddresses(this.seed, label)))
    return out
  }

  /** A new profile, `<market>/<role>`, with an inbox anyone may write to: its hosts record and profile record, then the vault. */
  async addProfile(label: string): Promise<string> {
    const [market, role] = label.split('/')
    const main = await mainKey(this.seed, label)
    const now = Date.now()
    const body = { market: market!, role: role!, inboxKey: (await inboxKey(main.secret)).encryptTo, inbox: { senders: 'anyone' }, pay: { ...(await payAddresses(this.seed, label)) } }
    await publish(this.hosts, [hostsRecord(main, this.hosts, now), ownerRecord(main, 'profile', body, now)])
    this.vault.profiles = [...(this.vault.profiles ?? []), { label, hosts: this.hosts }]
    await this.saveVault()
    return main.address
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  private connections(): Connection[] {
    return ((this.vault.settings?.connections ?? []) as Connection[]).filter((c) => typeof c.secret === 'string')
  }

  private keyOf(c: Connection): KeyObject {
    return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: c.secret, x: c.connection }, format: 'jwk' })
  }

  private signAs(c: Connection, text: string): string {
    return b64u.encode(sign(null, Buffer.from(text, 'utf8'), this.keyOf(c)))
  }

  /**
   * The connect page: the person saw the AI app's name, where it sends them back and the connector,
   * and chose. On a yes: a new connection key, its id and the person's choice saved as a permission
   * in the vault, the login request signed with it, and, if a socket to that connector is open, the
   * connection registered there. Gives back where to send the person's browser.
   */
  async connect(connector: string, request: string, choice: Choice): Promise<string> {
    const back = new URL('/connected', connector)
    back.searchParams.set('request', request)
    if (choice === 'no') {
      back.searchParams.set('error', 'access_denied')
      return back.href
    }
    const { name } = JSON.parse(Buffer.from(b64u.decode(request.split('.')[0]!)).toString('utf8')) as { name: string }
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    const c: Connection = { connector, connection: jwk.x!, secret: jwk.d! }
    this.vault.permissions = [...(this.vault.permissions ?? []), { who: { connector, connection: c.connection, name }, ...choice }]
    this.vault.settings = { ...this.vault.settings, connections: [...this.connections(), c] }
    await this.saveVault()
    const open = this.sockets.get(connector)
    if (open?.challenge) open.ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: this.signAs(c, `${REGISTER}${connector}\n${open.challenge}`) }))
    back.searchParams.set('connection', c.connection)
    back.searchParams.set('sig', this.signAs(c, LOGIN + request))
    return back.href
  }

  /** A connection removed: its permission and its key, so this signer serves it no more. */
  async disconnect(connection: string): Promise<void> {
    this.vault.permissions = (this.vault.permissions ?? []).filter((p) => (p.who as { connection?: string }).connection !== connection)
    this.vault.settings = { ...this.vault.settings, connections: this.connections().filter((c) => c.connection !== connection) }
    await this.saveVault()
  }

  /** Forest opened: a socket to `connector`, every connection for it registered. */
  async open(connector: string): Promise<void> {
    const mine = this.connections().filter((c) => c.connector === connector)
    const ws = new WebSocket(`${connector.replace(/^http/, 'ws')}/signer`)
    const socket: { ws: WebSocket; challenge?: string } = { ws }
    this.sockets.set(connector, socket)
    await new Promise<void>((resolve, reject) => {
      const left = new Set(mine.map((c) => c.connection))
      ws.addEventListener('error', () => reject(new Error(`no socket to ${connector}`)))
      ws.addEventListener('close', () => this.sockets.get(connector) === socket && this.sockets.delete(connector))
      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Body
        if (frame.type === 'challenge') {
          socket.challenge = frame.challenge as string
          for (const c of mine) ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: this.signAs(c, `${REGISTER}${connector}\n${socket.challenge}`) }))
          if (!left.size) resolve()
        } else if (frame.type === 'registered' || frame.type === 'refused') {
          left.delete(frame.connection as string)
          if (!left.size) resolve()
        } else if (frame.type === 'ask') {
          void this.handle(connector, frame.connection as string, frame.tool as string, frame.args as Body)
            .catch((err: Error) => refused(err.message))
            .then((answer) => ws.send(JSON.stringify({ type: 'answer', id: frame.id, ...answer })))
        }
      })
    })
  }

  /** Forest closed: every socket. */
  close(): void {
    for (const { ws } of this.sockets.values()) ws.close()
    this.sockets.clear()
  }

  // -------------------------------------------------------------------------------------------
  // Asks

  private entryFor(connector: string, connection: string): Permission | undefined {
    return (this.vault.permissions ?? []).find((p) => {
      const who = p.who as { connector?: string; connection?: string }
      return who.connector === connector && who.connection === connection
    })
  }

  /** Whether paying `amount` keeps `who` within every limit of `entry` that holds on `label`. */
  private withinLimits(entry: Permission, who: string, label: string, amount: string): boolean {
    const now = Date.now()
    for (const limit of entry.limits ?? []) {
      if (limit.profile !== undefined && limit.profile !== label) continue
      const since = now - PERIODS[limit.per as keyof typeof PERIODS]
      const spent = this.spent.filter((s) => s.who === who && s.time > since && (limit.profile === undefined || s.label === label)).reduce((sum, s) => sum + s.micros, 0n)
      if (spent + micros(amount) > micros(limit.amount)) return false
    }
    return true
  }

  /** What waits for the person's yes, and the link that shows it to them. */
  private wait(ask: Ask, why: string): Answer {
    this.waiting.push(ask)
    return { status: 'approval', link: `${this.appUrl}/approve/${this.waiting.length}`, why }
  }

  /** An ask from `connection` through `connector`: done within the person's permissions, waiting for their yes outside them. */
  async handle(connector: string, connection: string, tool: string, args: Body): Promise<Answer> {
    this.asked.push({ tool, args })
    if (!this.connections().some((c) => c.connector === connector && c.connection === connection)) return refused('this connection was removed')
    const entry = this.entryFor(connector, connection)
    if (tool === 'profiles') {
      const covered = entry && knowsPermission(entry) ? this.labels().filter((l) => entry.profiles === 'all' || entry.profiles.includes(l)) : []
      return done({ profiles: covered.map((l) => ({ market: l.split('/')[0]!, role: l.split('/').slice(1).join('/') })) })
    }
    const action = ACTION[tool] ?? null
    if (!action) return refused(`no tool ${tool}`)
    let label: string
    let ask: Body = args
    if (tool === 'reply') {
      const m = this.numbers.get(connection)?.[(args.number as number) - 1]
      if (!m) return refused(`no message numbered ${String(args.number)}: read the inbox first`)
      label = m.label
    } else label = `${args.market as string}/${args.role as string}`
    if (!this.labels().includes(label)) return refused(`the person has no profile as ${label.split('/')[1]} in ${label.split('/')[0]}; they make one in Forest`)
    // A new record's id is chosen now, so a yes later writes the same path.
    if (tool === 'post' && args.id === undefined) ask = { ...args, id: randomBytes(8).toString('hex') }
    const path = tool === 'post' || tool === 'remove' ? `${ask.kind as string}/${ask.id as string}` : undefined
    const pending = { connector, connection, tool, args: ask }
    if (!entry || !permits(entry, label, action, path)) return this.wait(pending, `${tool} as ${label} is not in what this connection may do`)
    if (tool === 'pay' && !this.withinLimits(entry, `${connector} ${connection}`, label, ask.amount as string)) return this.wait(pending, `this payment goes beyond a limit the person set`)
    return this.act(pending, label)
  }

  /** The person said yes to what waits at `link`: it is done. */
  async approve(link: string): Promise<Answer> {
    const ask = this.waiting[Number(link.split('/').at(-1)) - 1] ?? null
    if (!ask) return refused('nothing waits at that link')
    const label = ask.tool === 'reply' ? this.numbers.get(ask.connection)![(ask.args.number as number) - 1]!.label : `${ask.args.market as string}/${ask.args.role as string}`
    return this.act(ask, label)
  }

  /** The ask done, as `label`, signed with its main key and published straight to its hosts. */
  private async act({ connector, connection, tool, args }: Ask, label: string): Promise<Answer> {
    const main = await mainKey(this.seed, label)
    const view = await readProfile(this.hosts, main.address, Date.now(), { post: true })
    if (tool === 'post' || tool === 'remove') {
      const path = `${args.kind as string}/${args.id as string}`
      if (tool === 'remove' && !view.current.get(path)?.record.body) return refused(`nothing at ${args.kind as string} ${args.id as string}`)
      const outcomes = await publish(view.hosts, [ownerRecord(main, path, tool === 'post' ? (args.body as Body) : null, nextTime(Date.now(), view, path))])
      const took = outcomes.filter((o) => o.results[0]?.ok)
      if (!took.length) return refused(`no host took it: ${outcomes.map((o) => o.error ?? o.results[0]?.message ?? o.status).join('; ')}`)
      return done({ kind: args.kind as string, id: args.id as string })
    }
    if (tool === 'message' || tool === 'reply') {
      const to = tool === 'message' ? (args.to as string) : this.numbers.get(connection)![(args.number as number) - 1]!.from
      const theirs = await readProfile(this.hosts, to, Date.now())
      const body = theirs.current.get('profile')?.record.body
      if (!body) return refused('no profile at that address on the hosts this signer reads')
      try {
        const sent = await message({ from: main, host: view.hosts[0]! }, to, { text: args.text as string }, Date.now(), body)
        const outcomes = await deliver(theirs.hosts, [sent])
        if (!outcomes.some((o) => o.results[0]?.ok)) return refused(`no host took it: ${outcomes.map((o) => o.results[0]?.message ?? o.status).join('; ')}`)
      } catch (err) {
        if (err instanceof RecordError && err.code === 'no_inbox') return refused('that profile has no inbox')
        throw err
      }
      return done()
    }
    if (tool === 'inbox') {
      const own = new Map<string, string>()
      for (const l of this.labels()) own.set((await mainKey(this.seed, l)).address, l)
      const { identity } = await inboxKey(main.secret)
      const numbered = this.numbers.get(connection) ?? []
      this.numbers.set(connection, numbered)
      const messages: Body[] = []
      const seen = new Set<string>()
      for (const host of view.hosts) {
        for (let cursor = 0; ; ) {
          const page = await pull(host, pullRequest(main, cursor, Date.now()))
          for (const { message: m, id } of page.messages) {
            if (seen.has(id)) continue
            seen.add(id)
            const opened = await openMessage(m, identity).catch(() => null)
            if (!opened) continue
            let n = numbered.findIndex((x) => x.id === id) + 1
            if (!n) n = numbered.push({ id, label, from: m.from })
            const { text, ...rest } = opened.body
            messages.push({ number: n, from: own.get(m.from) ?? m.from, time: m.time, ...(typeof text === 'string' && { text }), ...(Object.keys(rest).length > 0 && { body: rest }) })
          }
          if (page.cursor === cursor) break
          cursor = page.cursor
        }
      }
      return done({ messages: messages.sort((a, b) => (a.time as number) - (b.time as number)) })
    }
    // pay
    if (!this.payWith) return refused('this signer has no way to pay')
    const offer = args.offer as string
    const theirs = await readProfile(this.hosts, offer.split('/')[0]!, Date.now())
    const to = (theirs.current.get('profile')?.record.body?.pay as { solana?: unknown } | undefined)?.solana
    if (typeof to !== 'string') return refused('that profile gives no Solana pay address')
    const evidence = await this.payWith({ from: await payKey(this.seed, label, 'solana'), to, amount: args.amount as string, memo: offer })
    this.spent.push({ who: `${connector} ${connection}`, label, micros: micros(args.amount as string), time: Date.now() })
    return done({ evidence })
  }
}
