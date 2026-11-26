// The two checks: Didit's API, and what the verifier requires of what it says.
//
// Didit runs each check on its own page and holds the face, and for the ID check the document. Both
// checks are workflows in one Didit application, with one key. Didit decides who is the same person:
// each workflow compares its check with every other user's in the application, faces and documents,
// and declines a person it has seen, as its settings say. The verifier asks Didit seven things: to
// open a session on a check's workflow, later what that session decided, the selfie the session took,
// to compute the face's embedding (face.ts), to delete the session, to list a user's sessions and
// erase them, and to delete a user, with what Didit keeps of them (server.ts's `sweep`). From a
// decision it reads the session's workflow and `vendor_data`, its status, the status of each step
// (liveness; for the ID check also the document and the face match), the risk of each warning that
// set a Declined or In Review status (`decision_trace.status_warnings`), the selfie's address, the
// `vendor_data` of each other user whose face Didit matched to the selfie, and, from the document
// step, the text it read on the document (`fieldsOf`), which the ID stamp's facts are made from
// (facts.ts), and the names its machine-readable zone holds, which the scrambled copy is made from
// (fingerprint.ts). Everything else Didit returns is dropped the moment the answer is parsed. Nothing
// Didit says is stored as it is.
//
// One Didit user a person: every session the verifier opens for a stamp number, face or ID, carries
// the same `vendor_data`, the keyed hash of that stamp number (`stampHash`), and nothing else. Didit
// leaves a user's own sessions out of its search for a person seen before, so a person's earlier
// checks never refuse their next one, and every other user's count. It names nobody: without the
// verifier's secret, no stamp number gives its hash.
//
// The verifier signs only for an Approved session; Declined and In Review are a refusal, answered as
// one code (`reasonOf`), from the risks that set the status, the first that applies in REASONS's
// order. When the sweep deletes each session is server.ts's `sweep`.
//
// Didit's API as read in November 2026 (docs.didit.me: creating, retrieving and deleting a session,
// the decision's `decision_trace`, the liveness, face match and ID verification warnings, the ID
// verification report as its Data models page lists it, and vendor_data's uniqueness and scope):
// version 3, `x-api-key` header, `POST /v3/session/` (with `vendor_data`, and `callback`, the page
// Didit sends the person to when the check is done), `GET /v3/session/{id}/decision/` and `DELETE
// /v3/session/{id}/delete/` (`retain_face_embeddings` true or false, overriding the application's
// own setting; 200 with `face_retention_outcome`, 404 for a session already gone; with
// `deletion_instruction: "privacy_erasure"` instead, every face template kept for the session's
// user goes with it, and no setting keeps one), `GET /v3/sessions/` (`vendor_data`, `page_size`;
// every session of that user, whatever its status, as `results[]`, each with its `session_id` and
// `vendor_data`), and `POST /v3/users/delete/` (`vendor_data_list`; the user, its name and birth
// date among what it holds, and every face template kept for it go, its sessions do not; 200
// `{deleted}`, 0 for one already gone; a 409 or a 503 deletes nothing, and may be sent again). A
// liveness step's `reference_image` is a signed URL to the selfie, valid for hours, and its
// `matches[]` the faces Didit holds that are like the selfie, at most five, closest first, each
// with its user's `vendor_data`, a face kept as a template among them, the session's own user's
// never. A decision's `decision_trace.status_warnings[]` lists the warnings that set a Declined or
// In Review status, each with its `risk`; a status set by hand lists none. A document step's report
// (`id_verifications[]`) holds the text read on the document (DOCUMENT_FIELDS, and `extra_fields`,
// its document-specific ones), dates as YYYY-MM-DD and countries as ISO 3166-1 alpha-3, and `mrz`,
// its machine-readable zone as Didit read it (its `name`, the given names, and `surname`, among
// others), beside the step's own status, signed URLs to its images and video, scores, Didit's own
// derivations and other sessions' matches. A refusal's body varies by endpoint; a stable `code`
// sits beside `detail`, Didit's own words, when it sends one. The thrown error keeps the status and
// that code, for the log line (server.ts), and never `detail`.

import { createHmac } from 'node:crypto'

import { toBytes32 } from '@foundationforest/proofs'

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
  /** The session's own `vendor_data`, as the verifier opened it: its stamp number's keyed hash (`stampHash`). */
  vendorData: string
  /** The session's overall status: `Approved`, `Declined`, `In Review`, `Expired`, `Abandoned`, and so on. */
  status: string
  /** One per liveness step the workflow ran, with that step's own status. */
  liveness: { status: string }[]
  /** One per document step the workflow ran (`id_verifications`), with that step's own status. */
  documents: { status: string }[]
  /** One per face-match step (the selfie against the document's photo), with that step's own status. */
  faceMatches: { status: string }[]
  /** The risk of each warning that set a Declined or In Review status (`decision_trace.status_warnings`), once each. */
  risks: string[]
  /** The first liveness step's selfie: a signed URL. Null when there is none. */
  faceImage: string | null
  /**
   * The `vendor_data` of each other user whose face Didit matched to a liveness step's selfie
   * (`matches[]`), once each: at most five a step, the closest.
   */
  knownFaces: string[]
  /** What the first document step read. Null with no document step. */
  document: Document | null
  /** The names in the first document step's machine-readable zone, given and family. Null for a document without one. */
  mrz: { given: string; family: string } | null
}

export interface FaceCheck {
  /**
   * Open a session on the check's workflow, under `vendorData`, the stamp number's keyed hash
   * (`stampHash`): the page the person does the check on. With a callback, Didit sends the person
   * there when the check is done.
   */
  createSession(options: { vendorData: string; callback?: string }): Promise<{ sessionId: string; url: string }>
  /** What the session decided, or null if Didit has no such session. Throws if Didit can't answer. */
  decision(sessionId: string): Promise<Decision | null>
  /** The bytes of a photo a decision named (`faceImage`). Throws if they can't be had. */
  photo(url: string): Promise<Uint8Array>
  /**
   * Delete the session, keeping its face template or not: what Didit did with the face
   * (`retained_with_user` when it kept the template, `deleted` when it did not), or `gone` for a
   * session Didit no longer has. Throws if Didit can't answer, and the session is then still there.
   */
  deleteSession(sessionId: string, keepFace: boolean): Promise<string>
  /**
   * Delete the Didit user under `vendorData`: its record, and every face template kept for it, but
   * none of its sessions. Throws if Didit can't answer or refuses, and the user is then still there.
   */
  deleteUser(vendorData: string): Promise<void>
  /** The ids of the sessions Didit holds under `vendorData`, whatever came of them: a page of them. Throws if Didit can't answer. */
  sessionsOf(vendorData: string): Promise<string[]>
  /**
   * Erase the session, as a person's request to delete their face: it goes, and with it every face
   * template Didit keeps for its user. Throws if Didit can't answer, and the session is then still there.
   */
  eraseSession(sessionId: string): Promise<void>
}

/** How many days Didit keeps a deleted session's face template: 1825, five years, as long as Forest's Didit plan keeps anything. */
export const FACE_RETENTION_DAYS = 1825

/** Forest is for people this old and older: an ID check whose birth date shows less is too young. */
export const MINIMUM_AGE = 18

/**
 * Why Didit refused a check, as the app is told, each with the risks that say it, in order: the first
 * that applies wins. Any other risk, or none, as for a status set by hand, is `other`.
 *
 * There is no `known_person` here. Didit's own name check, `POSSIBLE_DUPLICATED_USER`, compares a
 * document only with ID checks Didit still holds, and the verifier deletes each an hour after its
 * stamp, so it catches almost nothing, and it refuses without comparing faces. The ID workflow takes
 * no action on it, it never becomes `known_person`, and nothing matches on it: `known_person` is the
 * verifier's own refusal (server.ts, fingerprint.ts), which compares faces.
 */
export const REASONS = [
  [
    'known_face',
    [
      'DUPLICATED_FACE',
      'POSSIBLE_DUPLICATED_FACE',
      'DUPLICATED_FACE_NAME_MISMATCH',
      'DUPLICATED_FACE_DOCUMENT_MISMATCH',
      'FRONT_CAMERA_DUPLICATED_FACE',
      'POSSIBLE_FRONT_CAMERA_DUPLICATED_FACE',
      'FRONT_CAMERA_DUPLICATED_FACE_NAME_MISMATCH',
      'FRONT_CAMERA_DUPLICATED_FACE_DOCUMENT_MISMATCH',
    ],
  ],
  // Didit's age estimate, on the face check, and the birth date on the ID check (`reasonFor`).
  ['too_young', ['AGE_BELOW_MINIMUM', 'MINIMUM_AGE_NOT_MET']],
  ['face_mismatch', ['LOW_FACE_MATCH_SIMILARITY', 'FACE_MATCH_MAX_ATTEMPTS_EXCEEDED', 'LOW_FRONT_CAMERA_FACE_MATCH_SIMILARITY']],
  [
    'id_unclear',
    [
      // It can't be read.
      'COULD_NOT_RECOGNIZE_DOCUMENT',
      'COULD_NOT_DETECT_DOCUMENT_TYPE',
      'IMAGE_TOO_BLURRY',
      'IMAGE_TOO_DARK',
      'IMAGE_TOO_BRIGHT',
      'NAME_NOT_DETECTED',
      'DATE_OF_BIRTH_NOT_DETECTED',
      'DOCUMENT_NUMBER_NOT_DETECTED',
      'EXPIRATION_DATE_NOT_DETECTED',
      'INVALID_DATE',
      'MRZ_NOT_DETECTED',
      'QR_NOT_DETECTED',
      'BARCODE_NOT_DETECTED',
      'PORTRAIT_IMAGE_NOT_DETECTED',
      'DOCUMENT_HAS_NO_PORTRAIT',
      'CRITICAL_FIELD_OCCLUSION_DETECTED',
      'FACE_MATCH_NOT_COMPUTED',
      'NO_REFERENCE_IMAGE',
      // It is expired, or not accepted.
      'DOCUMENT_EXPIRED',
      'DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION',
      // It looks altered.
      'SCREEN_CAPTURE_DETECTED',
      'PRINTED_COPY_DETECTED',
      'PORTRAIT_MANIPULATION_DETECTED',
      'SPECIMEN_DOCUMENT_DETECTED',
      'PUBLIC_DOCUMENT_IMAGE_DETECTED',
      'MRZ_VALIDATION_FAILED',
      'MRZ_AND_DATA_EXTRACTED_FROM_OCR_NOT_SAME',
      'DATA_INCONSISTENT',
      'DOCUMENT_SIDES_MISMATCH',
      'QR_VALIDATION_FAILED',
      'BARCODE_VALIDATION_FAILED',
      'BARCODE_SIGNATURE_INVALID',
      'DOCUMENT_NUMBER_FORMAT_MISMATCH',
      'PERSONAL_NUMBER_FORMAT_MISMATCH',
    ],
  ],
  [
    'face_unclear',
    [
      // Not a live face.
      'LIVENESS_FACE_ATTACK',
      'LOW_LIVENESS_SCORE',
      'VIRTUAL_CAMERA_DETECTED',
      'INJECTION_ATTACK_DETECTED',
      'FRAME_INJECTION_SUSPECTED',
      'SCREEN_CAPTURE_DURING_CAPTURE',
      'EXTERNAL_CAPTURE_DEVICE_DETECTED',
      'LIVENESS_VIDEO_ANOMALY',
      // The face can't be seen well, its age not even estimated.
      'NO_FACE_DETECTED',
      'AGE_NOT_DETECTED',
      'NO_FACE_IN_SELFIE',
      'MULTIPLE_FACES_DETECTED',
      'LOW_FACE_QUALITY',
      'LOW_FACE_LUMINANCE',
      'HIGH_FACE_LUMINANCE',
    ],
  ],
] as const

/** Why Didit refused a check: one of REASONS, or `other`. */
export type Reason = (typeof REASONS)[number][0] | 'other'

/** The first of REASONS that one of these risks says, else `other`. */
export function reasonOf(risks: string[]): Reason {
  for (const [reason, says] of REASONS) if (risks.some((risk) => (says as readonly string[]).includes(risk))) return reason
  return 'other'
}

/** Whole years from a YYYY-MM-DD birth date to `at` (milliseconds), or null for no real date, one to come, or one past any life. */
export function yearsOld(birth: string, at: number): number | null {
  const read = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth.trim())
  if (!read) return null
  const [y, m, d] = [Number(read[1]), Number(read[2]), Number(read[3])]
  // Date.UTC rolls 1990-02-30 over to March, and reads a year below 100 as 1900 and up: neither comes back the same.
  const born = new Date(Date.UTC(y, m - 1, d))
  if (born.toISOString().slice(0, 10) !== birth.trim()) return null
  const now = new Date(at)
  const years = now.getUTCFullYear() - y - (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d) ? 1 : 0)
  return years >= 0 && years <= 130 ? years : null
}

/**
 * Why Didit refused this check (`reasonOf`), at `at`. An ID check is `too_young` only for a birth
 * date Didit read that shows under MINIMUM_AGE: Didit's MINIMUM_AGE_NOT_MET also says a date it did
 * not read, or one past any life, and that is an ID it could not read, `id_unclear`.
 */
export function reasonFor(decision: Decision, check: Check, at: number): Reason {
  const reason = reasonOf(decision.risks)
  if (reason !== 'too_young' || check === 'face') return reason
  const years = yearsOld(decision.document?.date_of_birth ?? '', at)
  return years !== null && years < MINIMUM_AGE ? 'too_young' : 'id_unclear'
}

/** What a decision means when it gives no stamp: a session not the verifier's to judge, one unfinished, or Didit's refusal. */
export type Refusal = 'unknown_session' | 'wrong_workflow' | 'expired' | 'not_approved' | Reason

/** The keyed hash of a stamp number, every session's `vendor_data`: HMAC-SHA256 under `key` of its 32 bytes, big-endian, in hex. */
export function stampHash(key: Uint8Array, stampNumber: bigint): string {
  return createHmac('sha256', key).update(toBytes32(stampNumber)).digest('hex')
}

/** A `vendor_data` as the verifier writes one: a stamp number's keyed hash. */
const VENDOR_DATA = /^[0-9a-f]{64}$/

// Didit's own documents write a status both as `Approved` and as `APPROVED`, and `Not Started` as `NOT_STARTED`.
const is = (status: string, want: string) => status.toLowerCase().replace(/[\s_]+/g, ' ') === want

/** Each step of this kind ran, and each passed. */
const ran = (list: { status: string }[]) => list.length > 0 && list.every((step) => is(step.status, 'approved'))

/**
 * What Didit's decision means to the verifier, at `at`: a session on the check's own workflow;
 * Declined or In Review, Didit's refusal, by its risks (`reasonFor`); Expired or Abandoned (the person did not finish
 * in time), `expired`; anything else but Approved, unfinished, `not_approved`. Approved, it passes,
 * with every liveness step run and passed and, for the ID check, every document step and face match
 * too, and the document read: an approved session without them was not run on a workflow that makes
 * this check, which is `wrong_workflow`. Null means Didit passed it.
 */
export function judge(decision: Decision | null, workflowId: string, check: Check = 'face', at: number = Date.now()): Refusal | null {
  if (!decision) return 'unknown_session'
  if (decision.workflowId !== workflowId) return 'wrong_workflow'
  if (is(decision.status, 'declined') || is(decision.status, 'in review')) return reasonFor(decision, check, at)
  if (is(decision.status, 'expired') || is(decision.status, 'abandoned')) return 'expired'
  if (!is(decision.status, 'approved')) return 'not_approved'
  if (check === 'face') return ran(decision.liveness) ? null : 'wrong_workflow'
  return ran(decision.liveness) && ran(decision.documents) && ran(decision.faceMatches) && decision.document !== null ? null : 'wrong_workflow'
}

/** Whether Didit refuses the session, Declined or In Review: the sweep deletes such a session at once. */
export const refuses = (decision: Decision) => is(decision.status, 'declined') || is(decision.status, 'in review')

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
  const trace = typeof json.decision_trace === 'object' && json.decision_trace !== null ? (json.decision_trace as Record<string, unknown>) : {}
  const own = text(json.vendor_data)
  const matched = liveness.flatMap((step) => reports(step.matches).map((match) => text(match.vendor_data)))
  const mrz = typeof first?.mrz === 'object' && first.mrz !== null ? (first.mrz as Record<string, unknown>) : {}
  const given = isText(mrz.name) ? mrz.name : ''
  const family = isText(mrz.surname) ? mrz.surname : ''
  return {
    workflowId: text(json.workflow_id),
    vendorData: text(json.vendor_data),
    status: text(json.status),
    liveness: liveness.map(status),
    documents: documents.map(status),
    faceMatches: reports(json.face_matches).map(status),
    risks: [...new Set(reports(trace.status_warnings).map((warning) => text(warning.risk)).filter(Boolean))],
    faceImage: text(liveness[0]?.reference_image) || null,
    knownFaces: [...new Set(matched.filter((v) => v !== '' && v !== own))],
    document: first ? fieldsOf(first) : null,
    mrz: given || family ? { given, family } : null,
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
  readonly #baseUrl: string
  readonly #scenario: string | undefined

  /**
   * `scenario` is Didit's `sandbox_scenario`, the outcome a sandbox application's session comes to
   * (`approve`, `decline_…`, and others). Only `npm run sandbox` sets it; a live application ignores it.
   */
  constructor(options: { apiKey: string; workflowId: string; baseUrl?: string; scenario?: string }) {
    this.#apiKey = options.apiKey
    this.#workflowId = options.workflowId
    this.#baseUrl = (options.baseUrl ?? 'https://verification.didit.me').replace(/\/+$/, '')
    this.#scenario = options.scenario
  }

  /**
   * Every session of a stamp number, face or ID, gets that number's `vendor_data` (`stampHash`), so
   * Didit holds them as one user and leaves them out of its search for a person seen before.
   */
  async createSession({ vendorData, callback }: { vendorData: string; callback?: string }): Promise<{ sessionId: string; url: string }> {
    if (!VENDOR_DATA.test(vendorData)) throw new Error("a session's vendor_data is its stamp number's keyed hash, stampHash(…)")
    const res = await this.#fetch('/v3/session/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow_id: this.#workflowId,
        vendor_data: vendorData,
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

  /** Keeps the face template, or not, as asked, whatever the application's own setting says. */
  async deleteSession(sessionId: string, keepFace: boolean): Promise<string> {
    const res = await this.#fetch(`/v3/session/${encodeURIComponent(sessionId)}/delete/`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(keepFace ? { retain_face_embeddings: true, face_retention_days: FACE_RETENTION_DAYS } : { retain_face_embeddings: false }),
    })
    if (res.status === 404) return 'gone'
    if (!res.ok) throw await refused(res, 'a deletion', this.#apiKey)
    const outcome = ((await body(res)) as { face_retention_outcome?: unknown } | null)?.face_retention_outcome
    return typeof outcome === 'string' ? outcome : ''
  }

  /** The user, its name and birth date, and every face template kept for it: one who holds no stamp, one whose face is deleted, or one whose template's years are over. */
  async deleteUser(vendorData: string): Promise<void> {
    const res = await this.#fetch('/v3/users/delete/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendor_data_list: [vendorData] }) })
    if (!res.ok) throw await refused(res, 'a user deletion', this.#apiKey)
  }

  /** The first page, of up to 100: the sweep erases them and asks again until Didit lists none. */
  async sessionsOf(vendorData: string): Promise<string[]> {
    const query = new URLSearchParams({ vendor_data: vendorData, page_size: '100' })
    const res = await this.#fetch(`/v3/sessions/?${query}`, { method: 'GET' })
    if (!res.ok) throw await refused(res, 'a list of sessions', this.#apiKey)
    const json = (await body(res)) as { results?: unknown } | null
    if (!Array.isArray(json?.results)) throw new DiditUnavailable('Didit answered a list of sessions without its results', { status: res.status })
    // Only the user's own: Didit's filter is the only thing that says so, and a session is never another's to erase.
    return reports(json.results)
      .filter((session) => session.vendor_data === vendorData && typeof session.session_id === 'string')
      .map((session) => session.session_id as string)
  }

  async eraseSession(sessionId: string): Promise<void> {
    const res = await this.#fetch(`/v3/session/${encodeURIComponent(sessionId)}/delete/`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deletion_instruction: 'privacy_erasure' }),
    })
    if (res.status === 404) return
    if (!res.ok) throw await refused(res, 'an erasure', this.#apiKey)
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
