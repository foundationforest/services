// A reference signer: what Forest on a person's device does for the mcp, in plain code, for the app
// to read and for the tests (and the loop, later) to run. It holds the person's seed, keeps each
// profile's rules in the standard's format, makes connections on the connect page, opens a socket
// to each connector its rules name, and answers each ask by the person's rules, exactly as the
// standard says (records/README.md, Rules; keys/README.md, Signers):
//
// - a rule is for one who, on one profile: here a connection, { connector, connection };
// - it reads a profile's rules from its hosts before it acts on any ask for it (readRules), and acts
//   on no rule it does not know whole (knowsRule), nor on one that has ended;
// - `post` never covers a profile's profile record, its hosts record or a rule: those it always
//   asks the person about;
// - `pay` only within the rule's limit, counting what this who asked for over any day, week or
//   month; a rule with no limit sets no money cap;
// - anything no rule covers waits for the person's yes: here a link to open, and approve().
//
// Whatever it does, it signs with the profile's main key and publishes straight to the profile's
// hosts. Its answers carry no address of the person's: a message from one of their own profiles
// shows its label, and numbers stand in for messages.
//
// What is the app's and not the standard's, chosen here the simplest way: the labels of the
// profiles it made are kept in memory; messages are numbered per connection, in memory; what a who
// spent is counted in memory; and a payment is made by the function the signer is given.

import { type KeyObject, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { type MainKey, type PayKey, inboxKey, mainKey, payAddresses, payKey, signPay } from '@foundationforest/keys'
import { type Body, RecordError, type View, b64u, deliver, hostsRecord, nextTime, ownerRecord, publish, pull, pullRequest, readProfile } from '@foundationforest/records'
import { type Limit, PERIODS, RULE_PREFIX, type Rule, knowsRule, message, openMessage, readRules, ruleId, ruleRecord } from '@foundationforest/records/private'
import { LOGIN, REGISTER } from '../src/connection.ts'

export type Answer = { status: 'done'; result: Body } | { status: 'approval'; link: string; why: string } | { status: 'refused'; why: string }
/** A payment: from a pay key, to a Solana address, so many dollars. Gives back its evidence, `<chain>:<id>`. */
export type PayWith = (payment: { from: PayKey; to: string; amount: string }) => Promise<string>
/** What the person chose on the connect page: the profiles a rule goes on, and the rule without its who; or no. */
export type Choice = { profiles: string[]; can: string[]; limit?: Limit; until?: number } | 'no'

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
 * Whether a rule lets its who ask for `action`, at `path` for a write: a rule this signer knows
 * whole, not ended, covering the action. `post` never covers the profile record, the hosts record
 * or a rule.
 */
export function permits(rule: Rule, action: string, path?: string, now = Date.now()): boolean {
  if (!knowsRule(rule)) return false
  if (rule.until !== undefined && now > rule.until) return false
  if (!rule.can.includes(action)) return false
  if (action === 'post' && (path === 'profile' || path === 'hosts' || path?.startsWith(RULE_PREFIX))) return false
  return true
}

export class Signer {
  private readonly seed: Uint8Array
  private readonly hosts: string[]
  private readonly appUrl: string
  private readonly payWith: PayWith | undefined
  /** The labels of the profiles it made. */
  private readonly profiles: string[] = []
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
  // Profiles and their rules

  /** The labels of the person's profiles. */
  labels(): string[] {
    return [...this.profiles]
  }

  /** Every address of the person's: each profile's, and its pay addresses. For the tests to look for. */
  async addresses(): Promise<string[]> {
    const out: string[] = []
    for (const label of this.labels()) out.push((await mainKey(this.seed, label)).address, ...Object.values(await payAddresses(this.seed, label)))
    return out
  }

  /** A new profile, `<market>/<role>`, with an inbox anyone may write to: its hosts record and profile record, each pay address signed. */
  async addProfile(label: string): Promise<string> {
    const [market, role] = label.split('/')
    const main = await mainKey(this.seed, label)
    const now = Date.now()
    const paySig = { solana: signPay(await payKey(this.seed, label, 'solana'), main.address), evm: signPay(await payKey(this.seed, label, 'evm'), main.address) }
    const body = { market: market!, role: role!, inboxKey: (await inboxKey(main.secret)).encryptTo, inbox: { senders: 'anyone' }, pay: { ...(await payAddresses(this.seed, label)) }, paySig }
    await publish(this.hosts, [hostsRecord(main, this.hosts, now), ownerRecord(main, 'profile', body, now)])
    this.profiles.push(label)
    return main.address
  }

  /** A profile's main key, its view as its hosts serve it, and its rules by id, read before acting. */
  private async read(label: string): Promise<{ main: MainKey; view: View; rules: Map<string, Rule> }> {
    const main = await mainKey(this.seed, label)
    const view = await readProfile(this.hosts, main.address, Date.now(), { post: true })
    return { main, view, rules: await readRules(view, main) }
  }

  /** A profile's rules, as its hosts serve them. */
  async rules(label: string): Promise<Rule[]> {
    return [...(await this.read(label)).rules.values()]
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  /** Every connection a rule on any profile names, with its key. */
  private async connections(): Promise<Connection[]> {
    const out = new Map<string, Connection>()
    for (const label of this.labels()) {
      for (const { who } of await this.rules(label)) {
        if ('connector' in who && typeof who.key === 'string') out.set(`${who.connector} ${who.connection}`, { connector: who.connector, connection: who.connection, secret: who.key })
      }
    }
    return [...out.values()]
  }

  private keyOf(c: Connection): KeyObject {
    return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: c.secret, x: c.connection }, format: 'jwk' })
  }

  private signAs(c: Connection, text: string): string {
    return b64u.encode(sign(null, Buffer.from(text, 'utf8'), this.keyOf(c)))
  }

  /**
   * The connect page: the person saw the AI app's name, where it sends them back and the connector,
   * and chose. On a yes: a new connection key, and a rule on each profile chosen with its id, its
   * key and the person's choice, the login request signed with it, and, if a socket to that
   * connector is open, the connection registered there. Gives back where to send the person's
   * browser.
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
    const { profiles, ...rest } = choice
    const rule: Rule = { who: { connector, connection: c.connection, key: c.secret, name }, ...rest }
    for (const label of profiles) {
      const { main, view } = await this.read(label)
      const path = RULE_PREFIX + (await ruleId(main, rule.who))
      await publish(view.hosts, [await ruleRecord(main, rule, nextTime(Date.now(), view, path))])
    }
    const open = this.sockets.get(connector)
    if (open?.challenge) open.ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: this.signAs(c, `${REGISTER}${connector}\n${open.challenge}`) }))
    back.searchParams.set('connection', c.connection)
    back.searchParams.set('sig', this.signAs(c, LOGIN + request))
    return back.href
  }

  /** A connection removed: its rule on every profile, and with it its key, so this signer serves it no more. */
  async disconnect(connection: string): Promise<void> {
    for (const label of this.labels()) {
      const { main, view, rules } = await this.read(label)
      for (const [id, { who }] of rules) {
        if (!('connection' in who) || who.connection !== connection) continue
        const path = RULE_PREFIX + id
        await publish(view.hosts, [ownerRecord(main, path, null, nextTime(Date.now(), view, path))])
      }
    }
  }

  /** Forest opened: a socket to `connector`, every connection for it registered. */
  async open(connector: string): Promise<void> {
    const mine = (await this.connections()).filter((c) => c.connector === connector)
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

  /** This connection's rule on each profile, read from its hosts: undefined where it has none. */
  private async rulesFor(connector: string, connection: string): Promise<Map<string, Rule | undefined>> {
    const out = new Map<string, Rule | undefined>()
    for (const label of this.labels()) {
      const { main, rules } = await this.read(label)
      out.set(label, rules.get(await ruleId(main, { connector, connection })))
    }
    return out
  }

  /** Whether paying `amount` keeps `who` within the rule's limit on `label`: always, for a rule with none. */
  private withinLimit(rule: Rule, who: string, label: string, amount: string): boolean {
    const limit = rule.limit
    if (!limit) return true
    const since = Date.now() - PERIODS[limit.per as keyof typeof PERIODS]
    const spent = this.spent.filter((s) => s.who === who && s.label === label && s.time > since).reduce((sum, s) => sum + s.micros, 0n)
    return spent + micros(amount) <= micros(limit.amount)
  }

  /** What waits for the person's yes, and the link that shows it to them. */
  private wait(ask: Ask, why: string): Answer {
    this.waiting.push(ask)
    return { status: 'approval', link: `${this.appUrl}/approve/${this.waiting.length}`, why }
  }

  /** An ask from `connection` through `connector`: done within the person's rules, waiting for their yes outside them. */
  async handle(connector: string, connection: string, tool: string, args: Body): Promise<Answer> {
    this.asked.push({ tool, args })
    const rules = await this.rulesFor(connector, connection)
    if (![...rules.values()].some(Boolean)) return refused('this connection was removed')
    if (tool === 'profiles') {
      const covered = this.labels().filter((l) => {
        const rule = rules.get(l)
        return rule && knowsRule(rule)
      })
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
    const rule = rules.get(label)
    if (!rule || !permits(rule, action, path)) return this.wait(pending, `${tool} as ${label} is not in what this connection may do`)
    if (tool === 'pay' && !this.withinLimit(rule, `${connector} ${connection}`, label, ask.amount as string)) return this.wait(pending, `this payment goes beyond a limit the person set`)
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
    const evidence = await this.payWith({ from: await payKey(this.seed, label, 'solana'), to, amount: args.amount as string })
    this.spent.push({ who: `${connector} ${connection}`, label, micros: micros(args.amount as string), time: Date.now() })
    return done({ evidence })
  }
}
