// A reference signer: what Forest on a person's device does with what the mcp carries, in plain
// code, for the app to read and for the tests and the loop to run. It holds the person's seed and
// the stamps it was given, keeps each profile's permissions in the standard's format, makes
// connections on the connect page, keeps the live link to each connector its permissions name, and
// answers each ask by those permissions, as the standard's signers/ says (README.md):
//
// - a permission is for one who, on one profile: here a connection, { connector, connection }, with
//   the connection's key and the AI app's name, so any of the person's signers serves it;
// - the connect page makes one permission with `can` empty on each profile the person picked: the
//   AI app sees those profiles, and every ask needs the person's yes until they allow more (allow);
// - before any ask it reads every profile's permissions from its hosts (readPermissions), so one
//   removed on another device is gone at the next ask; it acts only on a permission it knows whole
//   that has not ended, and one that covers the ask (allows), counting what this who paid as that
//   profile over the limit's period; with no permission left anywhere, the connection has ended;
// - a write of the profile record always asks the person; a write of the hosts record or a
//   permission is refused, since the person does those in Forest; a read of a permission is
//   refused, since its body holds another connection's key;
// - anything no permission covers waits for the person's yes, here a link to open and approve();
//   so does an ask under a label the person has no profile under, which a yes then refuses, so
//   asking never maps the person's profiles;
// - every answer leaves out each of the person's own addresses (leaveOut), and a message from
//   another of their profiles shows its label.
//
// And what is the app's to choose: a write is checked against its market first (market.ts), and
// refused naming the field; a profile is made on the person's yes to a write of `profile` under a
// new label, and a profile that exists takes only the market's own fields from such a write; a `pay`
// asked again for the same `to` and amount within an hour answers done and pays nothing; any other
// payment for what it paid already waits for the person's yes; a review naming a post the profile
// paid gets that payment as its evidence, which an ask may not name. It pays in USD only.
//
// Whatever it does, it signs with the profile's main key and publishes straight to the profile's
// hosts. What it keeps is in memory, on this device: the labels of the person's profiles, the stamps
// it holds, what each who spent, and each payment by profile and `to`; and a payment is made by the
// function the signer is given.

import { fileURLToPath } from 'node:url'
import { type PayKey, inboxKey, mainKey, payAddresses, payKey, seedScalar, signPay } from '@foundationforest/keys'
import { type Body, RecordError, type View, b64u, checkPay, deliver, hex, hostsRecord, nextTime, ownerRecord, publicKeyFromAddress, publish, pull, pullRequest, readProfile } from '@foundationforest/records'
import { message, openMessage, openPrivate } from '@foundationforest/records/private'
import {
  type Answer,
  type Ask,
  type Permission,
  type Seen,
  PERIODS,
  PERMISSION_PREFIX,
  allows,
  answerFrame,
  leaveOut,
  linkUrl,
  newConnection,
  permissionId,
  permissionRecord,
  postAddressOf,
  readFrame,
  readPermissions,
  readRequest,
  signLogin,
  signRegister,
} from '@foundationforest/signers'
import { type SignedStamp, proofBytes, proveStamp, toBytes32 } from '@foundationforest/stamp'
import { Refusal } from '../src/forest.ts'
import { marketFile } from '../src/markets.ts'
import { checkProfileFields, checkWrite } from './market.ts'

/** A payment: from a pay key, to a Solana address, so many dollars. Gives back its evidence, `<chain>:<id>`. */
export type PayWith = (payment: { from: PayKey; to: string; amount: string }) => Promise<string>
/** What the person chose on the connect page: the profiles this AI app sees; or no. */
export type Choice = { profiles: string[] } | 'no'
/** What the person lets a connection do on one profile without asking them. */
export type Allowed = { can: string[]; limit?: Permission['limit']; until?: number }

type Connection = { connector: string; connection: string; key: string }
type Pending = { connector: string; connection: string; ask: Ask }
type Payment = { micros: bigint; evidence: string; time: number }

/** How long a `pay` asked again, for the same `to` and amount, answers the payment made instead of paying again. */
export const REPEAT_MS = 3_600_000
/** The currencies this signer pays in. */
export const CURRENCIES = ['USD']
/** The fields of a profile record this signer manages itself, which no ask writes. */
const MANAGED = ['market', 'role', 'inboxKey', 'inbox', 'pay', 'paySig', 'proofs']
/** The stamp circuit's committed proving files, in the standard at STANDARD. They keep the names the circuit was set up with. */
const STAMP_FILES = {
  wasm: fileURLToPath(new URL('../../standard/proofs/stamp/circuit/setup/note.wasm', import.meta.url)),
  zkey: fileURLToPath(new URL('../../standard/proofs/stamp/circuit/setup/note.zkey', import.meta.url)),
}

const done = (more: Omit<Extract<Answer, { status: 'done' }>, 'status'> = {}): Answer => ({ status: 'done', ...more })
const refused = (why: string): Answer => ({ status: 'refused', why })

/** Decimal text, up to six places, as whole millionths. */
function micros(amount: string): bigint {
  const [whole, part = ''] = amount.split('.')
  return BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, '0'))
}
/** Whole millionths as decimal text. */
function decimal(m: bigint): string {
  const part = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${m / 1_000_000n}${part ? `.${part}` : ''}`
}

/** A profile record's fields that are the market's: every one but those this signer manages. */
const marketFields = (body: Body): Body => Object.fromEntries(Object.entries(body).filter(([k]) => !MANAGED.includes(k)))

/** Whether this signer acts on a permission at all: one it knows whole, not ended. Any read, which a permission it knows covers by its `can`, stands for the question. */
export function live(permission: Permission, now = Date.now()): boolean {
  return allows(permission, { ask: 'read' }, { now, currencies: CURRENCIES })
}

export class Signer {
  private readonly seed: Uint8Array
  private readonly hosts: string[]
  private readonly appUrl: string
  private readonly payWith: PayWith | undefined
  /** The labels of the person's profiles. */
  private readonly profiles: string[] = []
  /** The stamps this device holds, each with its verifier's name, for the stamp proofs of a profile it makes. */
  private readonly stamps: Array<{ stamp: SignedStamp; verifierName: string }> = []
  /** One socket per connector, and its challenge. */
  private readonly sockets = new Map<string, { ws: WebSocket; challenge?: string }>()
  /** What each who spent, as which profile, in which currency, and when. */
  private readonly spent: Array<{ who: string; label: string; currency: string; micros: bigint; time: number }> = []
  /** Each payment it made, by profile and `to`: `<label> <to>`. */
  private readonly payments = new Map<string, Payment[]>()
  /** What waits for the person's yes, by number. */
  private readonly waiting: Pending[] = []
  /** Every ask it answered, for the tests to count. */
  readonly asked: Ask[] = []

  /** `labels`: the person's profiles another of their devices made, for this one to serve too. */
  constructor(options: { seed: Uint8Array; hosts: string[]; appUrl: string; payWith?: PayWith; labels?: string[] }) {
    this.seed = options.seed
    this.hosts = options.hosts
    this.appUrl = options.appUrl
    this.payWith = options.payWith
    this.profiles.push(...(options.labels ?? []))
  }

  // -------------------------------------------------------------------------------------------
  // Profiles and their permissions

  /** The labels of the person's profiles. */
  labels(): string[] {
    return [...this.profiles]
  }

  /** Every address of the person's: each profile's, and its pay addresses. What no answer holds. */
  async addresses(): Promise<string[]> {
    const out: string[] = []
    for (const label of this.labels()) out.push((await mainKey(this.seed, label)).address, ...Object.values(await payAddresses(this.seed, label)))
    return out
  }

  /** A stamp this device keeps, from the verifier named: a profile it makes after carries a stamp proof of it. */
  keep(stamp: SignedStamp, verifierName: string): void {
    this.stamps.push({ stamp, verifierName })
  }

  /**
   * A new profile, `<market>/<role>`: its hosts record, and its profile record with its market and
   * role, its inbox key and an inbox anyone may write to, both pay addresses each signed by its pay
   * key, a stamp proof made on the device for each stamp it holds, then `proofs`; and `fields`, the
   * market's own. Gives back its address.
   */
  async addProfile(label: string, more: { fields?: Body; proofs?: Body[] } = {}): Promise<string> {
    const [market, role] = label.split('/')
    const main = await mainKey(this.seed, label)
    const scalar = await seedScalar(this.seed)
    const stamps: Body[] = []
    for (const { stamp, verifierName } of this.stamps) {
      const r = await proveStamp({ seedScalar: scalar, verifierName, stamp, label, artifacts: STAMP_FILES })
      stamps.push({ circuit: 'stamp', verifier: r.verifier, verifierName, label, tag: hex.encode(toBytes32(r.tag)), proof: b64u.encode(proofBytes(r.proof)) })
    }
    const proofs = [...stamps, ...(more.proofs ?? [])]
    const paySig = { solana: signPay(await payKey(this.seed, label, 'solana'), main.address), evm: signPay(await payKey(this.seed, label, 'evm'), main.address) }
    const body: Body = { ...more.fields, market: market!, role: role!, inboxKey: (await inboxKey(main.secret)).encryptTo, inbox: {}, pay: { ...(await payAddresses(this.seed, label)) }, paySig, ...(proofs.length > 0 && { proofs }) }
    const now = Date.now()
    await publish(this.hosts, [hostsRecord(main, this.hosts, now), ownerRecord(main, 'profile', body, now)])
    if (!this.profiles.includes(label)) this.profiles.push(label)
    return main.address
  }

  /** A profile's main key, its view as its hosts serve it, and its permissions by id, read before acting. */
  private async read(label: string) {
    const main = await mainKey(this.seed, label)
    const view = await readProfile(this.hosts, main.address, Date.now(), { post: true })
    return { main, view, permissions: await readPermissions(view, main) }
  }

  /** A profile's permissions, as its hosts serve them. */
  async permissions(label: string): Promise<Permission[]> {
    return [...(await this.read(label)).permissions.values()]
  }

  /** `permission` written to `label`'s folder, at its path: a null body there removes it. */
  private async writePermission(label: string, permission: Permission | null, who: Permission['who']): Promise<void> {
    const { main, view } = await this.read(label)
    const path = PERMISSION_PREFIX + (await permissionId(main, who))
    const time = nextTime(Date.now(), view, path)
    await publish(view.hosts, [permission ? await permissionRecord(main, permission, time) : ownerRecord(main, path, null, time)])
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  /** Every connection a permission on any profile names, with its key. */
  private async connections(): Promise<Connection[]> {
    const out = new Map<string, Connection>()
    for (const label of this.labels()) {
      for (const { who } of await this.permissions(label)) {
        if ('connector' in who && typeof who.key === 'string') out.set(`${who.connector} ${who.connection}`, { connector: who.connector, connection: who.connection, key: who.key })
      }
    }
    return [...out.values()]
  }

  /**
   * The connect page: the person saw the AI app's name, the host it sends them back to and the
   * connector, and picked which of their profiles it sees. On a yes: a new connection, a permission
   * with `can` empty on each profile picked, the login request signed with the connection's key,
   * and, if the live link to that connector is open, the connection registered there. Gives back
   * where to send the person's browser.
   */
  async connect(connector: string, request: string, choice: Choice): Promise<string> {
    const back = new URL('/connected', connector)
    back.searchParams.set('request', request)
    if (choice === 'no') {
      back.searchParams.set('error', 'access_denied')
      return back.href
    }
    const { name } = readRequest(request)
    const c = newConnection()
    const who = { connector, connection: c.connection, key: c.key, name }
    for (const label of choice.profiles) await this.writePermission(label, { who, can: [] }, who)
    const open = this.sockets.get(connector)
    if (open?.challenge) open.ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: signRegister(c.key, connector, open.challenge) }))
    back.searchParams.set('connection', c.connection)
    back.searchParams.set('sig', signLogin(c.key, request))
    return back.href
  }

  /** The person, in their app, lets a connection do more, or less, as `label`: its permission there written again, its who kept. */
  async allow(label: string, connection: string, allowed: Allowed): Promise<void> {
    const found = (await this.permissions(label)).find((p) => 'connection' in p.who && p.who.connection === connection)
    if (!found) throw new Error(`no permission for that connection on ${label}`)
    await this.writePermission(label, { who: found.who, ...allowed }, found.who)
  }

  /** A connection's permission on one profile removed: a null body at its path. Every signer of the person's stops acting on it at its next ask. */
  async removePermission(label: string, connection: string): Promise<void> {
    for (const { who } of await this.permissions(label)) if ('connection' in who && who.connection === connection) await this.writePermission(label, null, who)
  }

  /** A connection removed: its permission on every profile, and with it its key, so no signer serves it any more. */
  async disconnect(connection: string): Promise<void> {
    for (const label of this.labels()) await this.removePermission(label, connection)
  }

  /** Forest opened: the live link to `connector`, every connection for it registered. */
  async open(connector: string): Promise<void> {
    const mine = (await this.connections()).filter((c) => c.connector === connector)
    const ws = new WebSocket(linkUrl(connector))
    const socket: { ws: WebSocket; challenge?: string } = { ws }
    this.sockets.set(connector, socket)
    await new Promise<void>((resolve, reject) => {
      const left = new Set(mine.map((c) => c.connection))
      ws.addEventListener('error', () => reject(new Error(`no live link to ${connector}`)))
      ws.addEventListener('close', () => this.sockets.get(connector) === socket && this.sockets.delete(connector))
      ws.addEventListener('message', (event) => {
        let frame: ReturnType<typeof readFrame>
        try {
          frame = readFrame(String(event.data))
        } catch {
          return ws.close(1008, 'a frame that is not one')
        }
        if (frame.type === 'challenge') {
          socket.challenge = frame.challenge
          for (const c of mine) ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: signRegister(c.key, connector, frame.challenge) }))
          if (!left.size) resolve()
        } else if (frame.type === 'registered' || frame.type === 'refused') {
          left.delete(frame.connection)
          if (!left.size) resolve()
        } else if (frame.type === 'ask') {
          const { type: _type, id, connection, ...ask } = frame
          void this.handle(connector, connection, ask as Ask)
            .catch((err: Error) => refused(err.message))
            .then((answer) => ws.send(answerFrame(id, answer)))
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

  /** This connection's permission on each profile, read from its hosts: undefined where it has none. */
  private async permissionsFor(connector: string, connection: string): Promise<Map<string, Permission | undefined>> {
    const out = new Map<string, Permission | undefined>()
    for (const label of this.labels()) {
      const { main, permissions } = await this.read(label)
      out.set(label, permissions.get(await permissionId(main, { connector, connection })))
    }
    return out
  }

  /** What `who` paid as `label` in `currency` over the limit's period, as decimal text. */
  private spentBy(who: string, label: string, permission: Permission, currency: string): string {
    const per = PERIODS[permission.limit?.per as keyof typeof PERIODS] ?? 0
    const since = Date.now() - per
    return decimal(this.spent.filter((s) => s.who === who && s.label === label && s.currency === currency && s.time > since).reduce((sum, s) => sum + s.micros, 0n))
  }

  /** A payment made as `label` to `to`, of `amount`, within the last hour: what a `pay` asked again answers. */
  private repeated(label: string, to: string, amount: string): Payment | undefined {
    return this.payments.get(`${label} ${to}`)?.find((p) => p.micros === micros(amount) && Date.now() - p.time < REPEAT_MS)
  }

  /** What waits for the person's yes, and the link that shows it to them. */
  private wait(pending: Pending, why: string): Answer {
    this.waiting.push(pending)
    return { status: 'waiting', link: `${this.appUrl}/approve/${this.waiting.length}`, why }
  }

  /** The role of the profile at `address`, as its profile record on the hosts this signer reads says. */
  private async roleOf(address: string): Promise<string | undefined> {
    const role = (await readProfile(this.hosts, address, Date.now())).current.get('profile')?.record.body?.role
    return typeof role === 'string' ? role : undefined
  }

  /** What the app refuses before it asks the person anything: none of it depends on which profiles the person holds. */
  private async refusal(ask: Ask): Promise<string | null> {
    try {
      if (ask.ask === 'read') return ask.path?.startsWith(PERMISSION_PREFIX) ? "a permission is the person's to read, in Forest" : null
      if (ask.ask === 'pay') return CURRENCIES.includes(ask.currency) ? null : `this app pays in ${CURRENCIES.join(', ')}`
      if ('to' in ask) return null
      const [market, role] = ask.label.split('/') as [string, string]
      if (ask.path === 'hosts') return "the hosts record is the person's to write, in Forest"
      if (ask.path.startsWith(PERMISSION_PREFIX)) return "a permission is the person's to write, in Forest"
      if (ask.path === 'profile') {
        if (ask.body === null) return "a profile is the person's to remove, in Forest"
        await checkProfileFields(marketFile(market), role, marketFields(ask.body))
        return null
      }
      await checkWrite(marketFile(market), role, ask.path, ask.body, (address) => this.roleOf(address))
      return null
    } catch (err) {
      if (err instanceof Refusal) return err.message
      throw err
    }
  }

  /** An ask from `connection` through `connector`: done within the person's permissions, waiting for their yes outside them. */
  async handle(connector: string, connection: string, ask: Ask): Promise<Answer> {
    this.asked.push(ask)
    const permissions = await this.permissionsFor(connector, connection)
    if (![...permissions.values()].some(Boolean)) return refused('this connection was removed')
    if (ask.ask === 'read' && ask.label === undefined) {
      const seen: Seen[] = []
      for (const label of this.labels()) {
        const p = permissions.get(label)
        if (p && live(p)) seen.push({ label, can: p.can, ...(p.limit && { limit: p.limit }), ...(p.until !== undefined && { until: p.until }) })
      }
      return this.answer(done({ profiles: seen }))
    }
    const no = await this.refusal(ask)
    if (no) return refused(no)
    const label = ask.label!
    const pending = { connector, connection, ask }
    const permission = permissions.get(label)
    const asking = `${ask.ask} as ${label}`
    // An ask as a profile the person does not hold waits like one no permission covers.
    if (!permission) return this.wait(pending, `${asking} is not in what this connection may do`)
    if (ask.ask === 'write' && 'path' in ask && ask.path === 'profile') return this.wait(pending, `${asking} at profile always asks the person`)
    const options = { now: Date.now(), currencies: CURRENCIES }
    if (ask.ask !== 'pay') return allows(permission, ask, options) ? this.act(pending) : this.wait(pending, `${asking} is not in what this connection may do`)
    if (!allows(permission, { ...ask, amount: '0' }, options)) return this.wait(pending, `${asking} is not in what this connection may do`)
    if (this.repeated(label, ask.to, ask.amount)) return this.answer(done())
    if (this.payments.has(`${label} ${ask.to}`)) return this.wait(pending, 'this was paid already: another payment needs the person’s yes')
    if (!allows(permission, ask, { ...options, spent: this.spentBy(`${connector} ${connection}`, label, permission, ask.currency) })) return this.wait(pending, 'this payment goes beyond a limit the person set')
    return this.act(pending)
  }

  /** The person said yes to what waits at `link`: it is done. */
  async approve(link: string): Promise<Answer> {
    const pending = this.waiting[Number(link.split('/').at(-1)) - 1] ?? null
    if (!pending) return refused('nothing waits at that link')
    return this.act(pending)
  }

  /** An answer as it leaves the device: with none of the person's own addresses in it. */
  private async answer(answer: Answer): Promise<Answer> {
    return leaveOut(answer as unknown as Body, await this.addresses()) as unknown as Answer
  }

  /** The ask done, as its profile, signed with its main key and published straight to its hosts. */
  private async act({ connector, connection, ask }: Pending): Promise<Answer> {
    const label = ask.label!
    const isWrite = ask.ask === 'write' && 'path' in ask
    if (!this.labels().includes(label)) {
      if (isWrite && ask.path === 'profile' && ask.body) {
        await this.addProfile(label, { fields: marketFields(ask.body) })
        return this.answer(done())
      }
      return refused(`the person has no profile as ${label}`)
    }
    const { main, view } = await this.read(label)
    if (ask.ask === 'write' && 'path' in ask) {
      const current = view.current.get(ask.path)?.record.body ?? null
      let body = ask.body
      if (ask.path === 'profile' && body) {
        // A profile whose record is gone is made again; otherwise the fields this signer manages stay
        // as they are, and the market's own come from the ask.
        if (!current) {
          await this.addProfile(label, { fields: marketFields(body) })
          return this.answer(done())
        }
        body = { ...marketFields(body), ...Object.fromEntries(Object.entries(current).filter(([k]) => MANAGED.includes(k))) }
      } else if (body === null && !current) return refused(`nothing at ${ask.path}`)
      else if (body && ask.path.split('/')[0] === 'review') {
        // A review's evidence is this signer's: the latest payment the profile made for the post it
        // names, or none.
        const paid = typeof body.offer === 'string' ? this.payments.get(`${label} ${body.offer}`)?.at(-1) : undefined
        if (paid) body = { ...body, evidence: paid.evidence }
      }
      const outcomes = await publish(view.hosts, [ownerRecord(main, ask.path, body, nextTime(Date.now(), view, ask.path))])
      if (!outcomes.some((o) => o.results[0]?.ok)) return refused(`no host took it: ${outcomes.map((o) => o.error ?? o.results[0]?.message ?? o.status).join('; ')}`)
      return this.answer(done())
    }
    if (ask.ask === 'write') {
      const theirs = await readProfile(this.hosts, ask.to, Date.now())
      const profile = theirs.current.get('profile')?.record.body
      if (!profile) return refused('no profile at that address on the hosts this app reads')
      try {
        const sent = await message({ from: main, host: view.hosts[0]! }, ask.to, ask.body, Date.now(), profile)
        const outcomes = await deliver(theirs.hosts, [sent])
        if (!outcomes.some((o) => o.results[0]?.ok)) return refused(`no host took it: ${outcomes.map((o) => o.results[0]?.message ?? o.status).join('; ')}`)
      } catch (err) {
        if (err instanceof RecordError && err.code === 'no_inbox') return refused('that profile has no inbox')
        throw err
      }
      return this.answer(done())
    }
    if (ask.ask === 'read' && ask.path !== undefined) {
      const at = view.current.get(ask.path)?.record
      if (!at) return this.answer(done({ body: null }))
      let body = at.body
      if (body && 'private' in body) body = await openPrivate(body, (await inboxKey(main.secret)).identity).catch(() => null)
      if (at.body && !body) return refused(`this app cannot open the record at ${ask.path}`)
      return this.answer(done({ body, time: at.time }))
    }
    if (ask.ask === 'read') {
      const own = new Map<string, string>()
      for (const l of this.labels()) own.set((await mainKey(this.seed, l)).address, l)
      const { identity } = await inboxKey(main.secret)
      const messages: Array<({ from: string } | { fromLabel: string }) & { time: number; body: Body }> = []
      const seen = new Set<string>()
      for (const host of view.hosts) {
        for (let cursor = 0; ; ) {
          const page = await pull(host, pullRequest(main, cursor, Date.now()))
          for (const { message: m, id } of page.messages) {
            if (seen.has(id)) continue
            seen.add(id)
            const opened = await openMessage(m, identity).catch(() => null)
            if (!opened) continue
            const fromLabel = own.get(m.from)
            messages.push({ ...(fromLabel ? { fromLabel } : { from: m.from }), time: m.time, body: opened.body })
          }
          if (page.cursor === cursor) break
          cursor = page.cursor
        }
      }
      return this.answer(done({ messages: messages.sort((a, b) => a.time - b.time) }))
    }
    // pay: once, even when the person said yes to the same payment asked twice.
    if (!this.payWith) return refused('this app has no way to pay')
    if (this.repeated(label, ask.to, ask.amount)) return this.answer(done())
    const post = postAddressOf(ask.to)
    const address = post?.profile ?? ask.to
    if (!publicKeyFromAddress(address)) return refused('that is not a profile’s address')
    const theirs: View = await readProfile(this.hosts, address, Date.now())
    if (post && !theirs.current.get(post.path)?.record.body) return refused(`there is no post at ${ask.to}`)
    const profile = theirs.current.get('profile')?.record.body
    const to = profile && checkPay(profile, address).includes('solana') ? (profile.pay as { solana: string }).solana : null
    if (!to) return refused('that profile gives no Solana pay address this app can check')
    const evidence = await this.payWith({ from: await payKey(this.seed, label, 'solana'), to, amount: ask.amount })
    const time = Date.now()
    this.spent.push({ who: `${connector} ${connection}`, label, currency: ask.currency, micros: micros(ask.amount), time })
    this.payments.set(`${label} ${ask.to}`, [...(this.payments.get(`${label} ${ask.to}`) ?? []), { micros: micros(ask.amount), evidence, time }])
    return this.answer(done())
  }
}
