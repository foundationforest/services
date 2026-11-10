// The two checks: Didit's API, and what the verifier requires of what it says.
//
// Didit runs each check on its own page and holds the face, and for the ID check the document. The
// verifier asks it four things: to open a session on a check's workflow, later what that session
// decided, the selfie the session took, to compute the face's embedding (face.ts), and, an hour
// after the session's stamp is signed, to delete it. From a
// decision it reads the session's workflow, its status, the status of each step (liveness; for the ID
// check also the document and the face match), the selfie's address, and, from the document step,
// the text it read on the document (`fieldsOf`), which the ID stamp's facts are made from
// (facts.ts). Everything else Didit returns is dropped the moment the answer is parsed. Nothing
// Didit says is stored as it is (store.ts keeps hashes only).
//
// Whether a face was seen before is Didit's to say: the face workflow searches every face it has
// seen and sends a known one to review, where a person at the foundation decides in Didit's console.
// While a session is In Review the verifier answers that it is waiting, and the app asks again.
//
// An hour after a session's stamp is first signed, the verifier's sweep deletes it (`deleteSession`,
// server.ts's `sweep`), so Didit no longer holds its selfie, its liveness video, its document's
// images or its decision. Its console's list of users still shows, for a deleted ID session, the
// full name, birth date and country. Each deletion asks Didit to keep one image-free face
// template, anchored to the session's own `vendor_data`, for FACE_RETENTION_DAYS: its face search
// goes on seeing the face, so a face that comes back still goes to review. Didit drops the template
// with the session unless asked, and gives every kept template an end. Only a session whose stamp is
// signed is deleted, so never one In Review.
//
// Didit's API as read in October 2026 (docs.didit.me: creating and retrieving a session, the
// liveness and document reports, and the ID verification report as its Data models page lists it):
// version 3, `x-api-key` header, `POST /v3/session/`
// (with `callback`, the page Didit sends the person to when the check is done),
// `GET /v3/session/{id}/decision/` and `DELETE /v3/session/{id}/delete/` (200 with
// `face_retention_outcome`, 404 for a session already gone). A liveness step's `reference_image` is a signed URL to the
// selfie, valid for hours. A document step's report (`id_verifications[]`) holds the text read on the
// document (DOCUMENT_FIELDS, and `extra_fields`, its document-specific ones), dates as YYYY-MM-DD
// and countries as ISO 3166-1 alpha-3, beside the step's own status, signed URLs to its images and
// video, scores, Didit's own derivations and other sessions' matches. A refusal's body varies by
// endpoint; a stable `code` sits beside `detail`, Didit's own words, when it sends one. The thrown
// error keeps the status and that code, for the log line (server.ts), and never `detail`.
//
// Each session's `vendor_data` is its check's name and a fresh random id, `face-<uuid>` or
// `id-<uuid>`: it names nobody, and Didit's face search compares a face against faces checked under
// another `vendor_data`.

import { randomUUID } from 'node:crypto'

/** The two checks: by face, and by a government document with a live face. */
export type Check = 'face' | 'id'

/**
 * What a document step read on the document: each text field, by Didit's name, its value as Didit
 * gives it; each of `extra_fields` as `extra_fields.<its key>`, the name Didit's own workflow rules
 * give it. A field Didit did not read is absent.
 */
export type Document = Record<string, string>

/**
 * The text a document step's report reads on the document, by Didit's names. Not these: the step's
 * own status, node, method and assurance; every image and video (signed URLs); its scores; what
 * Didit works out itself (`age`, `issuing_state_name`, `formatted_address`, `parsed_address`); the
 * same text again in machine form (`mrz`, `barcodes`, `extracted_data`); and other sessions'
 * matches.
 */
export const DOCUMENT_FIELDS = [
  'address',
  'date_of_birth',
  'date_of_issue',
  'document_number',
  'document_subtype',
  'document_type',
  'expiration_date',
  'first_name',
  'full_name',
  'gender',
  'issuing_state',
  'last_name',
  'marital_status',
  'nationality',
  'personal_number',
  'place_of_birth',
  'region',
] as const

/** Text a field can hold: a string, not empty, with no lone surrogate, so it has one UTF-8 spelling to hash. */
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.isWellFormed()

/** What a document step's report read on the document (`Document`): its text fields, and those of its `extra_fields`. */
export function fieldsOf(step: Record<string, unknown>): Document {
  const fields: Document = {}
  for (const name of DOCUMENT_FIELDS) if (isText(step[name])) fields[name] = step[name]
  const extra = step.extra_fields
  if (typeof extra === 'object' && extra !== null && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) if (isText(value)) fields[`extra_fields.${key}`] = value
  }
  return fields
}

/** What the verifier reads from a session's decision. */
export type Decision = {
  workflowId: string
  /** The session's overall status: `Approved`, `Declined`, `In Review`, `Expired`, `Abandoned`, and so on. */
  status: string
  /** One per liveness step the workflow ran, with that step's own status. */
  liveness: { status: string }[]
  /** One per document step the workflow ran (`id_verifications`), with that step's own status. */
  documents: { status: string }[]
  /** One per face-match step (the selfie against the document's photo), with that step's own status. */
  faceMatches: { status: string }[]
  /** The first liveness step's selfie: a signed URL. Null when there is none. */
  faceImage: string | null
  /** What the first document step read. Null with no document step. */
  document: Document | null
}

export interface FaceCheck {
  /**
   * Open a session on the check's workflow: the page the person does the check on. With a callback,
   * Didit sends the person there when the check is done.
   */
  createSession(options?: { callback?: string }): Promise<{ sessionId: string; url: string }>
  /** What the session decided, or null if Didit has no such session. Throws if Didit can't answer. */
  decision(sessionId: string): Promise<Decision | null>
  /** The bytes of a photo a decision named (`faceImage`). Throws if they can't be had. */
  photo(url: string): Promise<Uint8Array>
  /**
   * Delete the session, keeping its face template: what Didit did with the face
   * (`retained_with_user` when it kept the template), or `gone` for a session Didit no longer has.
   * Throws if Didit can't answer, and the session is then still there.
   */
  deleteSession(sessionId: string): Promise<string>
}

/** How many days Didit keeps a deleted session's face template: 3650, the longest it allows. */
export const FACE_RETENTION_DAYS = 3650

export type Refusal =
  | 'unknown_session'
  | 'wrong_workflow'
  | 'declined'
  | 'expired'
  | 'not_approved'
  | 'no_liveness'
  | 'liveness_not_passed'
  | 'no_document'
  | 'document_not_passed'
  | 'no_face_match'
  | 'face_match_not_passed'

/** A session's `vendor_data`: its check's name, then a random id. */
export const vendorData = (check: Check) => `${check}-${randomUUID()}`

// Didit's own documents write a status both as `Approved` and as `APPROVED`, and `In Review` as `IN_REVIEW`.
const is = (status: string, want: string) => status.toLowerCase().replace(/[\s_]+/g, ' ') === want

/** Each step of this kind ran, and each passed; else the refusal for none, or for one that did not pass. */
function steps(list: { status: string }[], none: Refusal, failed: Refusal): Refusal | null {
  if (list.length === 0) return none
  return list.every((step) => is(step.status, 'approved')) ? null : failed
}

/**
 * What Didit's decision means to the verifier: a session on the check's own workflow; In Review, a
 * person at the foundation still to decide; Declined, `declined`, and Expired or Abandoned (the person
 * did not finish in time), `expired`: a session that will never pass, so the app starts a new one;
 * anything else but approved, unfinished, `not_approved`; and approved, every liveness step passed
 * and, for the ID check, every document step and every face match too. Null means Didit passed it.
 */
export function judge(decision: Decision | null, workflowId: string, check: Check = 'face'): Refusal | 'in_review' | null {
  if (!decision) return 'unknown_session'
  if (decision.workflowId !== workflowId) return 'wrong_workflow'
  if (is(decision.status, 'in review')) return 'in_review'
  if (is(decision.status, 'declined')) return 'declined'
  if (is(decision.status, 'expired') || is(decision.status, 'abandoned')) return 'expired'
  if (!is(decision.status, 'approved')) return 'not_approved'
  return (
    steps(decision.liveness, 'no_liveness', 'liveness_not_passed') ??
    (check === 'id' ? (steps(decision.documents, 'no_document', 'document_not_passed') ?? steps(decision.faceMatches, 'no_face_match', 'face_match_not_passed')) : null)
  )
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const reports = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((r) => typeof r === 'object' && r !== null) : []

/** A decision as Didit returns it, cut down to what the verifier reads. */
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
    document: first ? fieldsOf(first) : null,
  }
}

/**
 * Didit could not be asked, refused, or answered something other than a session. Its message names
 * no session. With an answer, its HTTP status; with a refusal, its `code`, as Didit sent it.
 */
export class DiditUnavailable extends Error {
  readonly status: number | undefined
  readonly codes: unknown[]
  constructor(message: string, answer?: { status: number; codes?: unknown[] }) {
    super(message)
    this.status = answer?.status
    this.codes = answer?.codes ?? []
  }
}

/** Didit refused `what`: its status, and its `code` when it sent one, unless it is the key. `detail` is dropped. */
async function refused(res: Response, what: string, key: string): Promise<DiditUnavailable> {
  let code: unknown
  try {
    code = ((await res.json()) as { code?: unknown } | null)?.code
  } catch {
    // No JSON: the status alone says why.
  }
  return new DiditUnavailable(`Didit answered ${res.status} to ${what}`, { status: res.status, codes: code === undefined || code === key ? [] : [code] })
}

/** The largest photo the verifier takes from Didit. */
export const MAX_PHOTO_BYTES = 10_000_000

async function body(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new DiditUnavailable('Didit answered something that is not JSON', { status: res.status })
  }
}

/** An https address, or http on this machine (the stand-in Didit, for tests). */
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
  readonly #check: Check
  readonly #baseUrl: string
  readonly #scenario: string | undefined

  /**
   * `scenario` is Didit's `sandbox_scenario`, the outcome a sandbox application's session comes to
   * (`approve`, `review_…`, `decline_…`). Only `npm run sandbox` sets it; a live application ignores it.
   */
  constructor(options: { apiKey: string; workflowId: string; check: Check; baseUrl?: string; scenario?: string }) {
    this.#apiKey = options.apiKey
    this.#workflowId = options.workflowId
    this.#check = options.check
    this.#baseUrl = (options.baseUrl ?? 'https://verification.didit.me').replace(/\/+$/, '')
    this.#scenario = options.scenario
  }

  /**
   * Each session gets its own `vendor_data`: its check's name and a fresh random id, which names
   * nobody. Didit's duplicate check compares a face against faces checked under a different
   * `vendor_data`; its documents don't say what it does when there is none, so every session carries
   * one that no other session shares.
   */
  async createSession({ callback }: { callback?: string } = {}): Promise<{ sessionId: string; url: string }> {
    const res = await this.#fetch('/v3/session/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow_id: this.#workflowId,
        vendor_data: vendorData(this.#check),
        ...(callback && { callback }),
        ...(this.#scenario && { sandbox_scenario: this.#scenario }),
      }),
    })
    if (!res.ok) throw await refused(res, 'a new session', this.#apiKey)
    const json = (await body(res)) as Record<string, unknown> | null
    if (typeof json?.session_id !== 'string' || typeof json.url !== 'string') {
      throw new DiditUnavailable('Didit answered a new session without an id or a page', { status: res.status })
    }
    return { sessionId: json.session_id, url: json.url }
  }

  /** Keeps the face template on every deletion, whatever the application's own setting says. */
  async deleteSession(sessionId: string): Promise<string> {
    const res = await this.#fetch(`/v3/session/${encodeURIComponent(sessionId)}/delete/`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retain_face_embeddings: true, face_retention_days: FACE_RETENTION_DAYS }),
    })
    if (res.status === 404) return 'gone'
    if (!res.ok) throw await refused(res, 'a deletion', this.#apiKey)
    const outcome = ((await body(res)) as { face_retention_outcome?: unknown } | null)?.face_retention_outcome
    return typeof outcome === 'string' ? outcome : ''
  }

  async decision(sessionId: string): Promise<Decision | null> {
    const res = await this.#fetch(`/v3/session/${encodeURIComponent(sessionId)}/decision/`, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw await refused(res, 'a decision', this.#apiKey)
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
    if (!res.ok) throw new DiditUnavailable(`the photo's address answered ${res.status}`, { status: res.status })
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_PHOTO_BYTES) throw new DiditUnavailable('the photo is larger than the verifier takes')
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
