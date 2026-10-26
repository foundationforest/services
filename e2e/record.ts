// A run's record: what one run of the loop did, written to runs/<time>.json whether it passed or not.
// It holds addresses, signatures, amounts and counts, and the commits it ran: never a key, a credit,
// a login, the phrase, or the RPC's URL when RPC_URL gave it, which may hold a key. `checkRecord` is
// its shape; the run checks its record with it before writing it, and the tests check every record
// in runs/ with it.

/** The steps of a run, in order. A failed run's record holds the ones it finished. */
export const STEPS = ['keys', 'funding', 'stamps', 'credits', 'profiles', 'logins', 'mcp', 'deal', 'reviews', 'index', 'reputation', 'addresses', 'balances'] as const
export type Step = (typeof STEPS)[number]

/** Where each service was: `loopback`, the loop's own copy on this machine, or the deployed one's origin. */
export type Where = 'loopback' | string

export type RunRecord = {
  started: string
  ended: string
  passed: boolean
  /** Why it failed: only on a failed run. */
  error?: string
  /** This repo's commit, and the standard's and the markets' pins. */
  commits: { services: string; standard: string; markets: string }
  /** Where each service the run used was. The verifier, the index and the mcp are always the loop's own. */
  services: { verifier: Where; host: Where; feePayer: Where; index: Where; mcp: Where }
  /** The deployed verifier, index or mcp services.json names, which the run only checked to answer. */
  checked: string[]
  /** The chain: the RPC (`RPC_URL` when that setting gave it), the escrow program, the test dollar, and the market. */
  chain: { rpc: string; escrow: string; testDollar: string; market: string }
  /** The loop's own verifier (its name and two keys) and index (its address); a run that failed before they started has none. */
  loop?: { verifier: { name: string; face: string; id: string }; index: string }
  steps: { [step in Step]?: { [key: string]: unknown } }
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
const COMMIT = /^[0-9a-f]{40}$/
const HEX32 = /^[0-9a-f]{64}$/
const UNITS = /^(0|[1-9][0-9]*)$/
const EVM = /^0x[0-9a-fA-F]{40}$/
/** Evidence as the markets manual writes it: a CAIP-2 chain, then the id. */
const EVIDENCE = /^solana:[1-9A-HJ-NP-Za-km-z]{32}:[1-9A-HJ-NP-Za-km-z]{32,88}$/

type Check = (v: unknown) => boolean
const address: Check = (v) => typeof v === 'string' && ADDRESS.test(v)
const signature: Check = (v) => typeof v === 'string' && SIGNATURE.test(v)
const units: Check = (v) => typeof v === 'string' && UNITS.test(v)
const hex32: Check = (v) => typeof v === 'string' && HEX32.test(v)
const evm: Check = (v) => typeof v === 'string' && EVM.test(v)
const evidence: Check = (v) => typeof v === 'string' && EVIDENCE.test(v)
const count: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0
const text: Check = (v) => typeof v === 'string' && v.length > 0
const words: Check = (v) => Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === 'string' && w.length > 0)
const is =
  (value: unknown): Check =>
  (v) =>
    v === value
const paid: { [path: string]: Check } = { signature, charge: units, bytes: count }
const prefixed = (prefix: string, fields: { [path: string]: Check }) => Object.fromEntries(Object.entries(fields).map(([k, c]) => [`${prefix}.${k}`, c]))
const each = (who: string[], fields: { [path: string]: Check }) => Object.assign({}, ...who.map((w) => prefixed(w, fields)))
const BOTH = ['tutor', 'student']

/** What each step holds, at least: a dotted path and its check. */
const SHAPES: { [step in Step]: { [path: string]: Check } } = {
  keys: each(['tutor', 'student', 'coach'], { label: text, profile: address, 'pay.solana': address, 'pay.evm': evm }),
  funding: { accounts: signature, money: signature, 'wallets.tutor': address, 'wallets.student': address },
  stamps: each(BOTH, { verifier: address, model: text }),
  credits: each(BOTH, { signature, amount: text, credits: count, reference: address }),
  profiles: each(BOTH, { profile: address, tag: hex32, spent: count, stampProof: is('checks') }),
  logins: each(BOTH, { profiles: words, can: words, limit: text }),
  mcp: { offer: text, 'found.profile': address, 'message.number': count, reply: is('done'), 'approval.tool': is('inbox'), 'approval.why': text, 'approval.approved': is('done') },
  deal: { ...prefixed('payment', paid), 'payment.evidence': evidence, 'escrow.address': address, ...prefixed('escrow.open', paid), ...prefixed('escrow.pay', paid), 'escrow.outcome': is('pay'), 'escrow.sponsor': address, 'escrow.evidence': evidence },
  reviews: each(BOTH, { id: text, evidence }),
  index: { 'tutor.rating': is(10), 'tutor.withPayment': is(1), 'student.rating': is(9), 'student.withPayment': is(1), 'deal.outcome': is('pay'), 'deal.reviews': is(1) },
  reputation: { profile: address, tag: hex32, root: hex32, time: count, score: is(100), result: is('shown') },
  addresses: each(BOTH, { answers: count, addresses: count, held: is(0) }),
  balances: { tutor: (v) => typeof v === 'number', student: (v) => typeof v === 'number', coach: (v) => typeof v === 'number' },
}

const isObject = (v: unknown): v is { [key: string]: unknown } => v !== null && typeof v === 'object' && !Array.isArray(v)
const at = (v: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v)
const isOrigin = (v: unknown) => typeof v === 'string' && URL.canParse(v) && new URL(v).origin === v
const where: Check = (v) => v === 'loopback' || isOrigin(v)

/** Throws, naming what is wrong, unless `r` is a run's record. A passed run has every step; a failed one, the steps it finished, in order, and its error. */
export function checkRecord(r: unknown): asserts r is RunRecord {
  const fail = (what: string): never => {
    throw new Error(`not a run's record: ${what}`)
  }
  if (!isObject(r)) fail('an object')
  const rec = r as { [key: string]: unknown }
  for (const k of ['started', 'ended']) if (typeof rec[k] !== 'string' || new Date(rec[k] as string).toISOString() !== rec[k]) fail(`${k} is a time`)
  if ((rec.ended as string) < (rec.started as string)) fail('it ended before it started')
  if (typeof rec.passed !== 'boolean') fail('passed is true or false')
  if (rec.passed === (typeof rec.error === 'string')) fail('a failed run, and only a failed run, has its error')
  for (const k of ['services', 'standard', 'markets']) if (!COMMIT.test(String(at(rec, `commits.${k}`)))) fail(`commits.${k} is a commit`)
  for (const k of ['host', 'feePayer']) if (!where(at(rec, `services.${k}`))) fail(`services.${k} is loopback or an origin`)
  for (const k of ['verifier', 'index', 'mcp']) if (at(rec, `services.${k}`) !== 'loopback') fail(`services.${k} is the loop's own, on loopback`)
  if (!Array.isArray(rec.checked) || !rec.checked.every(isOrigin)) fail('checked is a list of origins')
  const rpc = at(rec, 'chain.rpc')
  if (rpc !== 'RPC_URL' && !(typeof rpc === 'string' && URL.canParse(rpc) && !new URL(rpc).search && !new URL(rpc).password)) fail('chain.rpc is RPC_URL, or a URL with nothing secret in it')
  for (const k of ['escrow', 'testDollar']) if (!address(at(rec, `chain.${k}`))) fail(`chain.${k} is an address`)
  if (!text(at(rec, 'chain.market'))) fail('chain.market is a name')
  if ((rec.passed || rec.loop !== undefined) && (!text(at(rec, 'loop.verifier.name')) || !address(at(rec, 'loop.verifier.face')) || !address(at(rec, 'loop.verifier.id')) || !address(at(rec, 'loop.index')))) {
    fail('loop names its verifier, its two keys, and its index')
  }
  if (!isObject(rec.steps)) fail('steps is an object')
  const done = Object.keys(rec.steps as object)
  if (done.join() !== STEPS.slice(0, done.length).join()) fail(`its steps are the first of ${STEPS.join(', ')}, in order`)
  if (rec.passed && done.length !== STEPS.length) fail('a passed run has every step')
  for (const step of done as Step[]) {
    for (const [path, check] of Object.entries(SHAPES[step])) if (!check(at(rec.steps, `${step}.${path}`))) fail(`steps.${step}.${path}`)
  }
}

/** Throws if the record's text holds any of `secrets`: the phrase, the RPC's URL, the keys, credits and logins the run made. */
export function holdsNone(text: string, secrets: string[]): void {
  for (const secret of secrets) if (secret && text.includes(secret)) throw new Error('the record would hold a secret')
}
