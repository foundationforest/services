// A reference app: what a person's Forest app does around this copy, in plain code, with the
// standard's pieces only, for the tests and the loop to run. It holds the person's seed and the
// stamps it was given, and:
//
// - keeps the person's Profiles folder (folders/README.md, The Profiles folder), the empty label's:
//   its profile entry, which holds only its hosts; a `label/<id>` entry for each profile it makes
//   and a `stamp/<id>` entry for each stamp it keeps, each at a random id, locked to the folder's own
//   open key alone;
// - makes a profile: its profile entry with its market and role, its hosts, its main key's open key
//   (so it takes inbox entries), both pay addresses, a verification made on the device for each
//   stamp it keeps, and any more proofs;
// - at the connect page, on the person's yes: makes one access key for each profile they ticked
//   (keys/'s newAccessKey), lists it in that profile's entry with its switches (all four unless the
//   person chose fewer), writes its note at `key/<id>`, a random id, locked to the main key alone and
//   naming the key, and hands back the pack, locked to this copy's open key, which it reads at the
//   connector's /open-key;
// - removes an access key from a profile's entry, and its note, found by opening the folder's notes;
// - on a new device, finds the person's profiles and stamps from the seed alone, by opening every
//   entry its Profiles folder holds.
//
// It signs with each profile's main key and writes straight to its hosts. It keeps nothing but the
// stamps, in memory.

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CAN, type Body, type View, b64u, entry, hex, liveContent, nextTime, readFolder, write } from '@foundationforest/folders'
import { isLocked, lock, openLocked } from '@foundationforest/folders/locked'
import { mainKey, newAccessKey, openingHalf, payAddresses } from '@foundationforest/keys'
import { type SignedStamp, proofBytes, proveVerification, stampToJson } from '@foundationforest/proofs'

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
  /** The stamps this device holds, each naming its verifier. */
  private readonly stamps: SignedStamp[] = []

  constructor(options: { seed: Uint8Array; hosts: string[] }) {
    this.seed = options.seed
    this.hosts = options.hosts
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
   * chose. On a yes, for each profile ticked: a new access key, listed in its profile entry with
   * what the person lets it do, and its note; then the pack, locked to the connector's open key.
   * Gives back where the browser goes: the connector's /connected, with the request and the pack.
   */
  async connect(connector: string, request: string, choice: Choice): Promise<string> {
    const back = new URL('/connected', connector)
    back.searchParams.set('request', request)
    if (choice === 'no') {
      back.searchParams.set('error', 'access_denied')
      return back.href
    }
    const { openKey } = (await (await fetch(new URL('/open-key', connector))).json()) as { openKey: string }
    const name = (JSON.parse(Buffer.from(b64u.decode(request.split('.')[0]!)).toString('utf8')) as { name: string }).name
    const can = choice.can ?? [...CAN]
    const profiles: Body[] = []
    for (const label of choice.profiles) {
      const key = await newAccessKey()
      const { main } = await this.folder(label)
      await this.changeProfile(label, (body) => ({ ...body, keys: [...((body.keys as Body[] | undefined) ?? []), { key: key.address, ...(can.some((c) => c === 'read' || c === 'read-inbox') && { open: key.openKey }), can }] }))
      const { view } = await this.folder(label)
      const mine = (await openingHalf(main.secret)).openKey
      await wrote(view.hosts, [entry(main, `key/${randomId()}`, await lock({ key: key.address, name, connector, time: Date.now() }, [mine]), Date.now())])
      profiles.push({ label, address: main.address, hosts: view.hosts, key: b64u.encode(key.secret), can })
    }
    const request256 = createHash('sha256').update(request, 'utf8').digest('hex')
    back.searchParams.set('pack', (await lock({ request: request256, profiles }, [openKey])).private)
    return back.href
  }

  /** The access key at `address` taken out of `label`'s profile entry, and its note deleted. */
  async removeKey(label: string, address: string): Promise<void> {
    await this.changeProfile(label, (body) => ({ ...body, keys: ((body.keys as Body[] | undefined) ?? []).filter((k) => k.key !== address) }))
    const note = await this.note(label, address)
    if (!note) return
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
