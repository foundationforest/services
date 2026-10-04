// The two checks: Didit's API, and the rules the issuer applies to what it says.
//
// Didit runs each check and holds the face, and for the ID check the document. The issuer asks it two
// things: to open a session on a check's workflow, and later what that session decided. It reads a
// session's workflow, its status, the status of each step (liveness; for the ID check also the
// document and the face match), its risk codes, and the list each face-search match came from, and
// drops everything else Didit returns (names, images, document data) the moment the answer is parsed.
// Nothing Didit says is stored.
//
// Didit's API as read in September 2026 (docs.didit.me, "Retrieve Session", "Create Session",
// "Face Search"): version 3, `x-api-key` header, `POST /v3/session/` and
// `GET /v3/session/{id}/decision/`. A duplicate face is not a status: Didit's face search, which runs
// inside every liveness step unless the workflow turns it off, reports it as a warning whose risk is
// `DUPLICATED_FACE` or `POSSIBLE_DUPLICATED_FACE`, meaning the face was already verified under a
// different `vendor_data`, and lists each earlier session it found in `matches`, with that session's
// `vendor_data`. Face search covers every workflow of the Didit application, so both checks share it.
//
// Each session's `vendor_data` is its list's tag and a fresh random id: `face-<uuid>` or `id-<uuid>`.
// It names nobody, and it tells a later ID check which list an earlier session with the same face was
// for: a face seen in a face check is the same person moving up; a face seen in an ID check is a
// second try at the ID list.

import { randomUUID } from 'node:crypto'

/** The two checks, each with its own list: by face; by face and a government ID. */
export type Tier = 'face' | 'id'

/** What the issuer reads from a session's decision. */
export type Decision = {
  workflowId: string
  /** The session's overall status: `Approved`, `Declined`, `In Review`, and so on. */
  status: string
  /** One per liveness step the workflow ran, with that step's own status. */
  liveness: { status: string }[]
  /** Every warning's risk code in the session's liveness and face-match reports. */
  risks: string[]
  /** One per document step the workflow ran (`id_verifications`), with that step's own status. */
  documents: { status: string }[]
  /** One per face-match step (the selfie against the document's photo), with that step's own status. */
  faceMatches: { status: string }[]
  /** The `vendor_data` of every earlier session the face search found this face in. */
  matches: string[]
}

export interface FaceCheck {
  /** Open a session on the check's workflow: the page the person does the check on. */
  createSession(): Promise<{ sessionId: string; url: string }>
  /** What the session decided, or null if Didit has no such session. Throws if Didit can't answer. */
  decision(sessionId: string): Promise<Decision | null>
}

/** Didit's two risk codes for a face it has already verified. Both refuse. */
export const DUPLICATE_RISKS: readonly string[] = ['DUPLICATED_FACE', 'POSSIBLE_DUPLICATED_FACE']

export type Refusal =
  | 'unknown_session'
  | 'wrong_workflow'
  | 'duplicate_face'
  | 'no_liveness'
  | 'liveness_not_passed'
  | 'no_document'
  | 'document_not_passed'
  | 'no_face_match'
  | 'face_match_not_passed'
  | 'not_approved'

/** A session's `vendor_data`: its list's tag, then a random id. */
export const vendorData = (tier: Tier) => `${tier}-${randomUUID()}`

// Didit's own documents write a status both as `Approved` and as `APPROVED`.
const approved = (status: string) => status.toLowerCase() === 'approved'

/** Each step of this kind ran, and each passed; else the refusal for none, or for one that did not pass. */
function steps(list: { status: string }[], none: Refusal, failed: Refusal): Refusal | null {
  if (list.length === 0) return none
  return list.every((step) => approved(step.status)) ? null : failed
}

/**
 * Whether the face was seen before, by each check's rule. The face check: any duplicate risk code,
 * whichever check saw it. The ID check: an earlier ID session in the matches, so one face gets one ID
 * stamp, whatever documents it brings; a face seen only in face checks is the same person moving up.
 * A duplicate risk code with no match listed refuses too: then nothing says which check saw it.
 */
function seenBefore(decision: Decision, tier: Tier): boolean {
  const flagged = decision.risks.some((risk) => DUPLICATE_RISKS.includes(risk))
  if (tier === 'face') return flagged
  return decision.matches.some((data) => data.startsWith('id-')) || (flagged && decision.matches.length === 0)
}

/**
 * The issuer's rule: a session on the check's own workflow, not a face seen before (`seenBefore`),
 * every liveness step passed; for the ID check, every document step and every face match passed too;
 * and the session approved as a whole. Null means accepted. A duplicate is checked before the
 * statuses, because Didit declines a duplicate's liveness step too and the reason given should be the
 * real one.
 */
export function judge(decision: Decision | null, workflowId: string, tier: Tier = 'face'): Refusal | null {
  if (!decision) return 'unknown_session'
  if (decision.workflowId !== workflowId) return 'wrong_workflow'
  if (seenBefore(decision, tier)) return 'duplicate_face'
  const refusal =
    steps(decision.liveness, 'no_liveness', 'liveness_not_passed') ??
    (tier === 'id'
      ? (steps(decision.documents, 'no_document', 'document_not_passed') ??
        steps(decision.faceMatches, 'no_face_match', 'face_match_not_passed'))
      : null)
  if (refusal) return refusal
  if (!approved(decision.status)) return 'not_approved'
  return null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const reports = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((r) => typeof r === 'object' && r !== null) : []

/** A decision as Didit returns it, cut down to what `judge` reads. */
export function parseDecision(body: unknown): Decision {
  const json = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const liveness = reports(json.liveness_checks)
  const faceMatches = reports(json.face_matches)
  const risks = [...liveness, ...faceMatches].flatMap((report) => reports(report.warnings).map((warning) => text(warning.risk)))
  const status = (step: Record<string, unknown>) => ({ status: text(step.status) })
  return {
    workflowId: text(json.workflow_id),
    status: text(json.status),
    liveness: liveness.map(status),
    risks,
    documents: reports(json.id_verifications).map(status),
    faceMatches: faceMatches.map(status),
    matches: liveness.flatMap((step) => reports(step.matches).map((match) => text(match.vendor_data))),
  }
}

/** Didit could not be asked, or answered something other than a session. Its message names no session. */
export class DiditUnavailable extends Error {}

async function body(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new DiditUnavailable('Didit answered something that is not JSON')
  }
}

export class DiditClient implements FaceCheck {
  readonly #apiKey: string
  readonly #workflowId: string
  readonly #tier: Tier
  readonly #baseUrl: string

  constructor(options: { apiKey: string; workflowId: string; tier: Tier; baseUrl?: string }) {
    this.#apiKey = options.apiKey
    this.#workflowId = options.workflowId
    this.#tier = options.tier
    this.#baseUrl = (options.baseUrl ?? 'https://verification.didit.me').replace(/\/+$/, '')
  }

  /**
   * Each session gets its own `vendor_data`: its list's tag and a fresh random id, which names
   * nobody. Didit's duplicate check compares a face against faces verified under a different
   * `vendor_data`; its documents don't say what it does when there is none, so every session carries
   * one that no other session shares.
   */
  async createSession(): Promise<{ sessionId: string; url: string }> {
    const res = await this.#fetch('/v3/session/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: this.#workflowId, vendor_data: vendorData(this.#tier) }),
    })
    if (!res.ok) throw new DiditUnavailable(`Didit answered ${res.status} to a new session`)
    const json = (await body(res)) as Record<string, unknown> | null
    if (typeof json?.session_id !== 'string' || typeof json.url !== 'string') {
      throw new DiditUnavailable('Didit answered a new session without an id or a page')
    }
    return { sessionId: json.session_id, url: json.url }
  }

  async decision(sessionId: string): Promise<Decision | null> {
    const res = await this.#fetch(`/v3/session/${encodeURIComponent(sessionId)}/decision/`, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw new DiditUnavailable(`Didit answered ${res.status} to a decision`)
    return parseDecision(await body(res))
  }

  async #fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.#baseUrl + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'x-api-key': this.#apiKey },
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      // The network error may carry the URL, which may carry a session id: it is not passed on.
      throw new DiditUnavailable('Didit could not be reached')
    }
  }
}
