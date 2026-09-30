// The face check: Didit's API, and the one rule the issuer applies to what it says.
//
// Didit runs the check and holds the face. The issuer asks it two things: to open a session on the
// foundation's workflow, and later what that session decided. It reads a session's workflow, its
// status, its liveness results and its risk codes, and drops everything else Didit returns (names,
// images, addresses) the moment the answer is parsed. Nothing Didit says is stored.
//
// Didit's API as read in September 2026 (docs.didit.me, "Retrieve Session", "Create Session",
// "Face Search"): version 3, `x-api-key` header, `POST /v3/session/` and
// `GET /v3/session/{id}/decision/`. A duplicate face is not a status: Didit's face search, which runs
// inside every liveness step unless the workflow turns it off, reports it as a warning whose risk is
// `DUPLICATED_FACE` or `POSSIBLE_DUPLICATED_FACE`, meaning the face was already verified under a
// different `vendor_data`.

import { randomUUID } from 'node:crypto'

/** What the issuer reads from a session's decision. */
export type Decision = {
  workflowId: string
  /** The session's overall status: `Approved`, `Declined`, `In Review`, and so on. */
  status: string
  /** One per liveness step the workflow ran, with that step's own status. */
  liveness: { status: string }[]
  /** Every warning's risk code in the session's liveness and face-match reports. */
  risks: string[]
}

export interface FaceCheck {
  /** Open a session on the foundation's workflow: the page the person does the check on. */
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
  | 'not_approved'

// Didit's own documents write a status both as `Approved` and as `APPROVED`.
const approved = (status: string) => status.toLowerCase() === 'approved'

/**
 * The issuer's one rule: a session on the foundation's workflow, not a duplicate face, every liveness
 * step passed, and the session approved as a whole. Null means accepted. A duplicate is checked
 * before the statuses, because Didit declines a duplicate's liveness step too and the reason given
 * should be the real one.
 */
export function judge(decision: Decision | null, workflowId: string): Refusal | null {
  if (!decision) return 'unknown_session'
  if (decision.workflowId !== workflowId) return 'wrong_workflow'
  if (decision.risks.some((risk) => DUPLICATE_RISKS.includes(risk))) return 'duplicate_face'
  if (decision.liveness.length === 0) return 'no_liveness'
  if (!decision.liveness.every((step) => approved(step.status))) return 'liveness_not_passed'
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
  const risks = [...liveness, ...reports(json.face_matches)].flatMap((report) =>
    reports(report.warnings).map((warning) => text(warning.risk)),
  )
  return {
    workflowId: text(json.workflow_id),
    status: text(json.status),
    liveness: liveness.map((step) => ({ status: text(step.status) })),
    risks,
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
  readonly #baseUrl: string

  constructor(options: { apiKey: string; workflowId: string; baseUrl?: string }) {
    this.#apiKey = options.apiKey
    this.#workflowId = options.workflowId
    this.#baseUrl = (options.baseUrl ?? 'https://verification.didit.me').replace(/\/+$/, '')
  }

  /**
   * Each session gets a fresh random `vendor_data`, which names nobody. Didit's duplicate check
   * compares a face against faces verified under a different `vendor_data`; its documents don't say
   * what it does when there is none, so every session carries one that no other session shares.
   */
  async createSession(): Promise<{ sessionId: string; url: string }> {
    const res = await this.#fetch('/v3/session/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: this.#workflowId, vendor_data: randomUUID() }),
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
