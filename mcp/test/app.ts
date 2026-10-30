// A reference app: what a person's Forest app does around this copy, in plain code, with the
// standard's pieces only, for the tests and the loop to run. It holds the person's seed and the
// stamps it was given, and:
//
// - keeps the person's Profiles folder (folders/README.md, The Profiles folder), the empty label's:
//   its profile entry, which holds only its hosts; a `label/<id>` entry for each profile it makes
//   and a `stamp/<id>` entry for each stamp it keeps, each at a random id, locked to the folder's own
//   open key alone;
// - keeps the wallet, the Profiles folder's balance at each host, where gifts and buys land, and
//   funds a folder from it (`fund`): a buy paid from the wallet with the Profiles folder's main key,
//   its credits spent into that folder. The credits say nothing about who paid for them;
// - makes a profile: its profile entry with its market and role, its hosts, its main key's open key
//   (so it takes inbox entries), both pay addresses, a verification made on the device for each
//   stamp it keeps, and any more proofs;
// - at the connect page, on the person's yes: makes the AI app's connection folder, named by a key
//   made at random, its first write paid as the device chooses (`pay`): its profile entry, which
//   holds only its hosts, and its `connection` entry, the AI app's name and a random secret. Then,
//   for each profile ticked, one access key (keys/'s newAccessKey), listed in that profile's entry
//   with its switches (all four unless the person chose fewer); its note at `key/<id>`, a random id,
//   locked to the main key alone, naming the key and holding the connection folder's key; and its
//   `access/<id>` entry in the connection folder. The connection folder's entries are locked to its
//   own key and the connector's open key, which it reads at the connector's /open-key. Then it hands
//   back the pointer to the folder, locked to that open key alone;
// - adds a profile to a connection, and ends one, each found from the seed alone, by opening the
//   notes of every profile its Profiles folder lists;
// - removes an access key from a profile's entry, its entry in the connection its note names, and
//   its note, each found by opening them;
// - on a new device, finds the person's profiles and stamps from the seed alone, by opening every
//   entry its Profiles folder holds.
//
// It signs with each profile's main key, the Profiles folder's, and the connection folder's own, and
// writes straight to their hosts. It keeps nothing but the stamps, in memory.

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CAN, type Body, type SignedEntry, type View, b64u, entry, hex, liveContent, nextTime, readFolder, write } from '@foundationforest/folders'
import { isLocked, lock, openLocked } from '@foundationforest/folders/locked'
import { type AccessKey, accessKey, mainKey, newAccessKey, openingHalf, payAddresses } from '@foundationforest/keys'
import { type SignedStamp, proofBytes, proveVerification, stampToJson } from '@foundationforest/proofs'
import { balancePayment, bought, serviceAt, spendInto } from '../../host/client/client.ts'

/** What the person chose at the connect page: the profiles they ticked, and what the AI app may do there; or no. */
export type Choice = { profiles: string[]; can?: string[] } | 'no'

/** The verification circuit's committed proving files, in the standard at STANDARD. */
const VERIFICATION_FILES = {
  wasm: fileURLToPath(new URL('../../standard/proofs/verification/setup/verification.wasm', import.meta.url)),
  zkey: fileURLToPath(new URL('../../standard/proofs/verification/setup/verification.zkey', import.meta.url)),
}

/** A random id, which names nothing: 16 random bytes, in lowercase hex. */
const randomId = () => hex.encode(crypto.getRandomValues(new Uint8Array(16)))

/** Each locked entry of a folder under `kind/`, opened with `identity`: its path, its locked body, and what it holds. */
async function opened(view: View, kind: string, identity: string): Promise<Array<{ path: string; locked: { private: string }; body: Body }>> {
  const out = []
  for (const [path, { entry: e }] of liveContent(view)) {
    if (!path.startsWith(`${kind}/`) || !isLocked(e.body)) continue
    out.push({ path, locked: e.body as { private: string }, body: await openLocked(e.body, identity) })
  }
  return out
}

/** A connection the person's notes name: its folder's address and key, the connector it is for, the AI app's name, and its folder with each access entry, opened. */
export type Found = { address: string; key: AccessKey; connector: string; name: string; view: View; access: Array<{ path: string; body: Body }> }

/** The open key a connector publishes at /open-key. */
const openKeyOf = async (connector: string) => ((await (await fetch(new URL('/open-key', connector))).json()) as { openKey: string }).openKey

/** A written batch, checked: every host took every entry, or why not. */
async function wrote(hosts: string[], entries: Parameters<typeof write>[1]): Promise<void> {
  for (const o of await write(hosts, entries)) {
    const refused = o.results.filter((r) => !r.ok)
    if (o.error || o.status !== 200 || refused.length || o.results.length !== entries.length) throw new Error(`${o.host} did not take it: ${o.error ?? JSON.stringify(refused)}`)
  }
}

export class App {
  private readonly seed: Uint8Array
  private readonly hosts: string[]
  /** What pays for a connection folder's first write, at its hosts, before it, where a host charges: the device's choice; the main way is `fund` from the wallet. */
  private readonly pay: ((folder: string) => Promise<unknown>) | undefined
  /** The stamps this device holds, each naming its verifier. */
  private readonly stamps: SignedStamp[] = []

  constructor(options: { seed: Uint8Array; hosts: string[]; pay?: (folder: string) => Promise<unknown> }) {
    this.seed = options.seed
    this.hosts = options.hosts
    this.pay = options.pay
  }

  /**
   * `n` credits, up to 100, from the wallet into `folder`'s balance, at each of the hosts that sell
   * credits: a buy paid from the Profiles folder's balance, signed by its main key, and its credits
   * spent into the folder. A host that will not sell them throws.
   */
  async fund(folder: string, n: number): Promise<void> {
    const wallet = await mainKey(this.seed, '')
    for (const host of this.hosts) {
      const service = await serviceAt(host)
      if (service) await spendInto(host, folder, await bought(service, n, (reference, count) => balancePayment(host, wallet, reference, count)))
    }
  }

  /** The Profiles folder's main key, the empty label's, and its folder as its hosts serve it. */
  private async profilesFolder() {
    const key = await mainKey(this.seed, '')
    return { key, view: await readFolder(this.hosts, key.address, Date.now()) }
  }

  /** An entry in the Profiles folder at `<kind>/<id>`, a random id, locked to its own open key alone; its profile entry first, when it has none. */
  private async inProfiles(kind: string, body: Body): Promise<void> {
    const { key, view } = await this.profilesFolder()
    const now = Date.now()
    const first = view.current.has('profile') ? [] : [entry(key, 'profile', { hosts: this.hosts }, now)]
    await wrote(this.hosts, [...first, entry(key, `${kind}/${randomId()}`, await lock(body, [(await openingHalf(key.secret)).openKey]), now)])
  }

  /** A stamp this device keeps: in the Profiles folder, so a new device has it too; a profile it makes after carries a verification of it. */
  async keep(stamp: SignedStamp): Promise<void> {
    this.stamps.push(stamp)
    await this.inProfiles('stamp', { stamp: JSON.stringify(stampToJson(stamp)) })
  }

  /** A profile's main key, and its folder as its hosts serve it. */
  private async folder(label: string) {
    const main = await mainKey(this.seed, label)
    return { main, view: await readFolder(this.hosts, main.address, Date.now()) }
  }

  /**
   * A new profile, `<market>/<role>`, listed in the Profiles folder: its profile entry with its
   * market, role and hosts, its open key, both pay addresses, a verification for each stamp this
   * device keeps, then `proofs`. Gives back its address.
   */
  async addProfile(label: string, more: { proofs?: Body[] } = {}): Promise<string> {
    const [market, role] = label.split('/')
    const main = await mainKey(this.seed, label)
    const verifications: Body[] = []
    for (const stamp of this.stamps) {
      const r = await proveVerification({ seed: this.seed, stamp, label, artifacts: VERIFICATION_FILES })
      verifications.push({ circuit: 'verification', verifier: r.verifier, verifierName: r.verifierName, label, proof: b64u.encode(proofBytes(r.proof)) })
    }
    const proofs = [...verifications, ...(more.proofs ?? [])]
    const body: Body = {
      market: market!,
      role: role!,
      hosts: this.hosts,
      openKey: (await openingHalf(main.secret)).openKey,
      pay: { ...(await payAddresses(this.seed, label)) },
      ...(proofs.length > 0 && { proofs }),
    }
    await wrote(this.hosts, [entry(main, 'profile', body, Date.now())])
    await this.inProfiles('label', { label, time: Date.now() })
    return main.address
  }

  /** The access keys `label`'s profile entry lists now. */
  async keys(label: string): Promise<Array<{ key: string; open?: string; can: string[] }>> {
    return (await this.folder(label)).view.keys
  }

  /** The note about the access key at `address` in `label`'s folder, found by opening each note there with the main key: its path, its locked body, and what it holds. */
  async note(label: string, address: string): Promise<{ path: string; locked: { private: string }; body: Body } | undefined> {
    const { main, view } = await this.folder(label)
    return (await opened(view, 'key', (await openingHalf(main.secret)).identity)).find((n) => n.body.key === address)
  }

  /** `label`'s profile entry, changed by `change`, written by its main key. */
  private async changeProfile(label: string, change: (body: Body) => Body): Promise<void> {
    const { main, view } = await this.folder(label)
    const body = view.current.get('profile')?.entry.body
    if (!body) throw new Error(`${label} has no profile entry`)
    await wrote(view.hosts, [entry(main, 'profile', change(body), nextTime(Date.now(), view, 'profile'))])
  }

  /**
   * The connect page: the person saw the AI app's name, from the request, and the connector, and
   * chose. On a yes: the connection folder, its key made at random, and for each profile ticked a
   * new access key, listed in its profile entry with what the person lets it do, its note, and its
   * access entry; then the pointer, locked to the connector's open key. Gives back where the browser
   * goes: the connector's /connected, with the request and the pointer.
   */
  async connect(connector: string, request: string, choice: Choice): Promise<string> {
    const back = new URL('/connected', connector)
    back.searchParams.set('request', request)
    if (choice === 'no') {
      back.searchParams.set('error', 'access_denied')
      return back.href
    }
    const openKey = await openKeyOf(connector)
    const name = (JSON.parse(Buffer.from(b64u.decode(request.split('.')[0]!)).toString('utf8')) as { name: string }).name
    const can = choice.can ?? [...CAN]
    // The connection folder's own key: made at random as an access key is (keys/'s newAccessKey),
    // both halves from 64 random bytes, though it is listed nowhere and handed to no one.
    const folder = await newAccessKey()
    const secret = b64u.encode(crypto.getRandomValues(new Uint8Array(32)))
    const now = Date.now()
    const entries = [entry(folder, 'profile', { hosts: this.hosts }, now), entry(folder, 'connection', await lock({ name, secret }, [folder.openKey, openKey]), now)]
    for (const label of choice.profiles) entries.push(await this.grant({ key: folder, connector, name }, label, can, openKey))
    await this.pay?.(folder.address)
    await wrote(this.hosts, entries)
    const request256 = createHash('sha256').update(request, 'utf8').digest('hex')
    back.searchParams.set('pointer', (await lock({ request: request256, folder: folder.address, hosts: this.hosts, secret }, [openKey])).private)
    return back.href
  }

  /**
   * A new access key for `label`, for a connection: listed in its profile entry with `can`, and its
   * note, holding the connection folder's key. Gives back its access entry, for the connection
   * folder, locked to the folder's key and the connector's `openKey`.
   */
  private async grant(conn: { key: AccessKey; connector: string; name: string }, label: string, can: string[], openKey: string): Promise<SignedEntry> {
    const key = await newAccessKey()
    const { main } = await this.folder(label)
    await this.changeProfile(label, (body) => ({ ...body, keys: [...((body.keys as Body[] | undefined) ?? []), { key: key.address, ...(can.some((c) => c === 'read' || c === 'read-inbox') && { open: key.openKey }), can }] }))
    const { view } = await this.folder(label)
    const mine = (await openingHalf(main.secret)).openKey
    await wrote(view.hosts, [entry(main, `key/${randomId()}`, await lock({ key: key.address, name: conn.name, connector: conn.connector, time: Date.now(), connection: b64u.encode(conn.key.secret) }, [mine]), Date.now())])
    return entry(conn.key, `access/${randomId()}`, await lock({ label, address: main.address, hosts: view.hosts, key: b64u.encode(key.secret) }, [conn.key.openKey, openKey]), Date.now())
  }

  /**
   * Every connection the person's notes name, found from the seed alone: the labels in the Profiles
   * folder, each profile's notes opened with its main key, and each connection folder they name,
   * its entries opened with its own key. An ended one, whose connection entry is gone, is left out.
   */
  async connections(): Promise<Found[]> {
    const named = new Map<string, { key: AccessKey; connector: string }>()
    for (const label of (await App.find(this.seed, this.hosts)).labels) {
      const { main, view } = await this.folder(label)
      for (const n of await opened(view, 'key', (await openingHalf(main.secret)).identity)) {
        if (typeof n.body.connection !== 'string') continue
        const key = await accessKey(b64u.decode(n.body.connection))
        named.set(key.address, { key, connector: n.body.connector as string })
      }
    }
    const found: Found[] = []
    for (const [address, { key, connector }] of named) {
      const view = await readFolder(this.hosts, address, Date.now())
      const head = view.current.get('connection')?.entry.body
      if (!isLocked(head)) continue
      const { name } = await openLocked(head, key.identity)
      found.push({ address, key, connector, name: name as string, view, access: await opened(view, 'access', key.identity) })
    }
    return found
  }

  /** The connection whose folder is at `address`, found from the seed. */
  private async connection(address: string): Promise<Found> {
    const c = (await this.connections()).find((x) => x.address === address)
    if (!c) throw new Error(`no connection of the person's is at ${address}`)
    return c
  }

  /** `label` added to the connection at `address`, with no new login: a new access key, listed with `can`, its note, and one more access entry. */
  async addToConnection(address: string, label: string, can: string[] = [...CAN]): Promise<void> {
    const c = await this.connection(address)
    await wrote(c.view.hosts, [await this.grant(c, label, can, await openKeyOf(c.connector))])
  }

  /** The connection at `address` ended: its connection entry deleted first, then each access key it holds removed (removeKey). */
  async endConnection(address: string): Promise<void> {
    const c = await this.connection(address)
    await wrote(c.view.hosts, [entry(c.key, 'connection', null, nextTime(Date.now(), c.view, 'connection'))])
    for (const a of c.access) await this.removeKey(a.body.label as string, (await accessKey(b64u.decode(a.body.key as string))).address)
  }

  /** The access key at `address` taken out of `label`'s profile entry; its entry in the connection its note names, and its note, deleted. */
  async removeKey(label: string, address: string): Promise<void> {
    await this.changeProfile(label, (body) => ({ ...body, keys: ((body.keys as Body[] | undefined) ?? []).filter((k) => k.key !== address) }))
    const note = await this.note(label, address)
    if (!note) return
    if (typeof note.body.connection === 'string') {
      const key = await accessKey(b64u.decode(note.body.connection))
      const view = await readFolder(this.hosts, key.address, Date.now())
      for (const a of await opened(view, 'access', key.identity)) {
        if ((await accessKey(b64u.decode(a.body.key as string))).address === address) await wrote(view.hosts, [entry(key, a.path, null, nextTime(Date.now(), view, a.path))])
      }
    }
    const { main, view } = await this.folder(label)
    await wrote(view.hosts, [entry(main, note.path, null, nextTime(Date.now(), view, note.path))])
  }

  /** A new device: from the seed alone, the labels of the person's profiles and the stamps they hold, from the Profiles folder on `hosts`. */
  static async find(seed: Uint8Array, hosts: string[]): Promise<{ labels: string[]; stamps: string[] }> {
    const key = await mainKey(seed, '')
    const view = await readFolder(hosts, key.address, Date.now())
    const { identity } = await openingHalf(key.secret)
    const labels = (await opened(view, 'label', identity)).map((e) => e.body.label).filter((l): l is string => typeof l === 'string')
    const stamps = (await opened(view, 'stamp', identity)).map((e) => e.body.stamp).filter((s): s is string => typeof s === 'string')
    return { labels: labels.sort(), stamps }
  }
}
