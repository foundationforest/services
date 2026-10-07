// The two checks: Didit's API, and the rules the issuer applies to what it says.
//
// Didit runs each check and holds the face, and for the document check the document. The issuer asks
// it three things: to open a session on a check's workflow, later what that session decided, and the
// selfie the session took, to compute the face's embedding (face.ts). From a decision it reads the
// session's workflow, its status, the status of each step (liveness; for the document check also the
// document and the face match), the selfie's address, the earlier sessions Didit's face search found
// the same face in, and, from the document step, the name, the birth date and the document's country.
// Everything else Didit returns is dropped the moment the answer is parsed. Nothing Didit says is
// stored as it is (store.ts keeps hashes only).
//
// Didit's API as read in October 2026 (docs.didit.me, "Retrieve Session", "Create Session",
// "Liveness report", "ID verification report"): version 3, `x-api-key` header, `POST /v3/session/`
// and `GET /v3/session/{id}/decision/`. A liveness step's `reference_image` is a signed URL to the
// selfie, valid for hours; its `matches` are the earlier sessions with the same face, each with its
// `session_id`. A document step reads `first_name`, `last_name`, `full_name`, `date_of_birth`
// (YYYY-MM-DD) and `issuing_state` (ISO 3166-1 alpha-3).
//
// Each session's `vendor_data` is its check's tag and a fresh random id, `face-<uuid>` or
// `id-<uuid>`: it names nobody, and Didit's face search compares a face against faces verified under
// another `vendor_data`.

import { randomUUID } from 'node:crypto'

/** The two checks: stage 1, by face; stage 2, by face and a government document. */
export type Tier = 'face' | 'id'

/** What a document step read, as Didit gives it. */
export type Document = { firstName: string; lastName: string; fullName: string; birth: string; country: string }

/** What the issuer reads from a session's decision. */
export type Decision = {
  workflowId: string
  /** The session's overall status: `Approved`, `Declined`, `In Review`, and so on. */
  status: string
  /** One per liveness step the workflow ran, with that step's own status. */
  liveness: { status: string }[]
  /** One per document step the workflow ran (`id_verifications`), with that step's own status. */
  documents: { status: string }[]
  /** One per face-match step (the selfie against the document's photo), with that step's own status. */
  faceMatches: { status: string }[]
  /** The first liveness step's selfie: a signed URL. Null when there is none. */
  faceImage: string | null
  /** The `session_id` of every earlier session Didit's face search found this face in. */
  matches: string[]
  /** What the first document step read. Null with no document step. */
  document: Document | null
}

export interface FaceCheck {
  /** Open a session on the check's workflow: the page the person does the check on. */
  createSession(): Promise<{ sessionId: string; url: string }>
  /** What the session decided, or null if Didit has no such session. Throws if Didit can't answer. */
  decision(sessionId: string): Promise<Decision | null>
  /** The bytes of a photo a decision named (`faceImage`). Throws if they can't be had. */
  photo(url: string): Promise<Uint8Array>
}

export type Refusal =
  | 'unknown_session'
  | 'wrong_workflow'
  | 'no_liveness'
  | 'liveness_not_passed'
  | 'no_document'
  | 'document_not_passed'
  | 'no_face_match'
  | 'face_match_not_passed'
  | 'not_approved'

/** A session's `vendor_data`: its check's tag, then a random id. */
export const vendorData = (tier: Tier) => `${tier}-${randomUUID()}`

// Didit's own documents write a status both as `Approved` and as `APPROVED`.
const approved = (status: string) => status.toLowerCase() === 'approved'

/** Each step of this kind ran, and each passed; else the refusal for none, or for one that did not pass. */
function steps(list: { status: string }[], none: Refusal, failed: Refusal): Refusal | null {
  if (list.length === 0) return none
  return list.every((step) => approved(step.status)) ? null : failed
}

/**
 * Didit's part of the issuer's rule: a session on the check's own workflow, every liveness step
 * passed; for the document check, every document step and every face match passed too; and the
 * session approved as a whole. Null means Didit passed it. Whether the face was seen before, and
 * with which note number, is the store's to say (store.ts).
 */
export function judge(decision: Decision | null, workflowId: string, tier: Tier = 'face'): Refusal | null {
  if (!decision) return 'unknown_session'
  if (decision.workflowId !== workflowId) return 'wrong_workflow'
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

/** A decision as Didit returns it, cut down to what the issuer reads. */
export function parseDecision(body: unknown): Decision {
  const json = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const liveness = reports(json.liveness_checks)
  const documents = reports(json.id_verifications)
  const status = (step: Record<string, unknown>) => ({ status: text(step.status) })
  const first = documents[0]
  return {
    workflowId: text(json.workflow_id),
    status: text(json.status),
    liveness: liveness.map(status),
    documents: documents.map(status),
    faceMatches: reports(json.face_matches).map(status),
    faceImage: text(liveness[0]?.reference_image) || null,
    matches: liveness.flatMap((step) => reports(step.matches).map((match) => text(match.session_id))).filter(Boolean),
    document: first
      ? {
          firstName: text(first.first_name),
          lastName: text(first.last_name),
          fullName: text(first.full_name),
          birth: text(first.date_of_birth),
          country: text(first.issuing_state),
        }
      : null,
  }
}

/** Didit could not be asked, or answered something other than a session. Its message names no session. */
export class DiditUnavailable extends Error {}

/** The largest photo the issuer takes from Didit. */
export const MAX_PHOTO_BYTES = 10_000_000

async function body(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new DiditUnavailable('Didit answered something that is not JSON')
  }
}

/** An https address, or http on this machine (the devnet stand-in). */
function photoAddress(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DiditUnavailable('Didit named a photo at no address')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new DiditUnavailable('Didit named a photo at an address that is not https')
  return parsed
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
   * Each session gets its own `vendor_data`: its check's tag and a fresh random id, which names
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

  /** The selfie, from its signed URL. The API key does not go with it: the URL carries its own signature. */
  async photo(url: string): Promise<Uint8Array> {
    const address = photoAddress(url)
    let res: Response
    try {
      res = await fetch(address, { signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new DiditUnavailable('the photo could not be reached')
    }
    if (!res.ok) throw new DiditUnavailable(`the photo's address answered ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_PHOTO_BYTES) throw new DiditUnavailable('the photo is larger than the issuer takes')
    return bytes
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
