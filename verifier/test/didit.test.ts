// The real Didit client against a local stand-in that answers the way Didit's documents say it does
// (November 2026, API v3). Nothing here reaches Didit itself.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { CODES } from '../src/codes.ts'
import { DiditClient, DiditUnavailable, FACE_RETENTION_DAYS, MINIMUM_AGE, REASONS, judge, parseDecision, reasonFor, reasonOf, stampHash, yearsOld } from '../src/didit.ts'

const KEY = 'test-api-key'
const WORKFLOW = '550e8400-e29b-41d4-a716-446655440000'
const SESSION = '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a'
/** A key for the hash of a stamp number, and that number's vendor_data under it. */
const HASH_KEY = new Uint8Array(32).fill(9)
const VENDOR_DATA = stampHash(HASH_KEY, 5n)

/** A decision in the shape of Didit's own example: an uppercase status, reports as arrays, extra fields. */
function decisionBody(over: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    session_kind: 'user',
    session_number: 1024,
    status: 'APPROVED',
    workflow_id: WORKFLOW,
    vendor_data: VENDOR_DATA,
    features: 'LIVENESS',
    id_verifications: null,
    liveness_checks: [
      {
        node_id: 'feature_liveness_1',
        status: 'Approved',
        method: 'PASSIVE',
        score: 0.98,
        reference_image: 'https://example.com/face.jpg',
        matches: [],
        warnings: [],
      },
    ],
    face_matches: null,
    reviews: [],
    ...over,
  }
}

type Seen = { method: string; url: string; key: string | undefined; body: string }
const seen: Seen[] = []
let reply: (req: IncomingMessage) => [number, unknown] = () => [500, {}]
let base = ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, key: req.headers['x-api-key'] as string | undefined, body })
    const [status, json] = reply(req)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof json === 'string' ? json : JSON.stringify(json))
  })
})

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const client = (scenario?: string) => new DiditClient({ apiKey: KEY, workflowId: WORKFLOW, baseUrl: base + '/', scenario })

test("a session is opened on the workflow under the vendor_data it is given: its stamp number's keyed hash, the same for every check", async () => {
  seen.length = 0
  reply = () => [201, { session_id: SESSION, session_number: 1, url: 'https://verify.didit.me/session/abc', status: 'Not Started', workflow_id: WORKFLOW }]
  const first = await client().createSession({ vendorData: VENDOR_DATA })
  await client().createSession({ vendorData: VENDOR_DATA })
  assert.deepEqual(first, { sessionId: SESSION, url: 'https://verify.didit.me/session/abc' })

  const [a, b] = seen
  assert.equal(a.method, 'POST')
  assert.equal(a.url, '/v3/session/')
  assert.equal(a.key, KEY)
  const bodyA = JSON.parse(a.body)
  assert.deepEqual(Object.keys(bodyA).sort(), ['vendor_data', 'workflow_id'], 'nothing about the person')
  assert.deepEqual(bodyA, { workflow_id: WORKFLOW, vendor_data: VENDOR_DATA })
  assert.equal(JSON.parse(b.body).vendor_data, VENDOR_DATA, 'one Didit user for the stamp number')
  // Anything but a stamp number's keyed hash, as every session carried before, is refused before Didit is asked.
  for (const vendorData of [`face-${VENDOR_DATA}-c0ffee00-0000-4000-8000-000000000000`, VENDOR_DATA.toUpperCase(), VENDOR_DATA.slice(1), 'c0ffee00-0000-4000-8000-000000000000', '']) {
    await assert.rejects(client().createSession({ vendorData }), /vendor_data/, vendorData)
  }
  assert.equal(seen.length, 2)

  // With a callback, Didit is told where to send the person back to, and nothing more.
  await client().createSession({ vendorData: VENDOR_DATA, callback: 'https://app.example/after?check=face' })
  const withCallback = JSON.parse(seen[2]!.body)
  assert.deepEqual(Object.keys(withCallback).sort(), ['callback', 'vendor_data', 'workflow_id'])
  assert.equal(withCallback.callback, 'https://app.example/after?check=face')

  // In the sandbox, a scenario says what the session comes to; nothing else ever sends one.
  await client('decline_duplicated_face').createSession({ vendorData: VENDOR_DATA })
  const sandboxed = JSON.parse(seen[3]!.body)
  assert.deepEqual(Object.keys(sandboxed).sort(), ['sandbox_scenario', 'vendor_data', 'workflow_id'])
  assert.equal(sandboxed.sandbox_scenario, 'decline_duplicated_face')
})

test('a decision is read from GET /v3/session/{id}/decision/ and cut down', async () => {
  seen.length = 0
  reply = () => [200, decisionBody()]
  const decision = await client().decision(SESSION)
  assert.deepEqual(seen[0], { method: 'GET', url: `/v3/session/${SESSION}/decision/`, key: KEY, body: '' })
  assert.deepEqual(decision, {
    workflowId: WORKFLOW,
    vendorData: VENDOR_DATA,
    status: 'APPROVED',
    liveness: [{ status: 'Approved' }],
    documents: [],
    faceMatches: [],
    risks: [],
    faceImage: 'https://example.com/face.jpg',
    knownFaces: [],
    document: null,
    mrz: null,
  })
  assert.equal(judge(decision, WORKFLOW), null, 'an uppercase APPROVED counts')
})

test("an ID check's decision: every text field read on the document, by Didit's names, and the face match; nothing else", () => {
  // A report shaped as Didit's Data models page gives one (docs.didit.me, ID verification).
  const report = {
    status: 'Approved',
    node_id: 'ocr',
    verification_method: 'document',
    assurance: 'documentary',
    wallet_provider: null,
    document_type: 'Passport',
    document_subtype: 'PASSPORT_GENERIC',
    document_number: 'AB1234567',
    personal_number: '99999999R',
    portrait_image: 'https://media.example/portrait.jpg?signature=1',
    front_image: 'https://media.example/front.jpg?signature=1',
    front_video: 'https://media.example/front.mp4?signature=1',
    back_image: null,
    back_video: null,
    full_front_image: 'https://media.example/full_front.jpg?signature=1',
    full_back_image: null,
    front_image_camera_front: 'https://media.example/camera.jpg?signature=1',
    back_image_camera_front: null,
    front_image_quality_score: { focus_score: 91, overall_score: 88.5 },
    document_liveness: { portrait_replace: { score: 96.46, bucket: 'approve' } },
    date_of_birth: '1990-05-12',
    age: 35,
    expiration_date: '2032-05-11',
    date_of_issue: '2022-05-11',
    issuing_state: 'ESP',
    issuing_state_name: 'Spain',
    first_name: 'María',
    last_name: 'García López',
    full_name: 'María García López',
    gender: 'F',
    address: 'Calle Mayor 1, 28001 Madrid',
    formatted_address: 'Calle Mayor 1, 28001 Madrid, Spain',
    parsed_address: { street_1: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001', country: 'ES' },
    place_of_birth: 'Madrid',
    marital_status: null,
    nationality: 'ESP',
    region: '',
    extra_fields: { profession: 'Ingeniera', 'DL Class': 'B', blood_group: 7, dl_categories: ['B'] },
    // As Didit reads a machine-readable zone: its given names as `name`.
    mrz: { document_number: 'AB1234567', surname: 'GARCIA LOPEZ', name: 'MARIA', country: 'ESP', birth_date: '900512', mrz_string: 'IDESPAB1234567' },
    barcodes: [{ type: 'PDF417', data: 'ANSI 636000' }],
    extracted_data: { first_name: 'MARIA' },
    extra_files: ['https://media.example/extra.jpg?signature=1'],
    matches: [{ session_id: '11111111-2222-3333-4444-555555555555', user_details: { name: 'Someone Else' } }],
    document_selfie_face_matches: null,
    warnings: [],
  }
  const decision = parseDecision(
    decisionBody({
      features: 'OCR + LIVENESS + FACE_MATCH',
      id_verifications: [report, { ...report, first_name: 'Otra' }],
      liveness_checks: [
        {
          node_id: 'liveness',
          status: 'Approved',
          reference_image: 'https://example.com/selfie.jpg',
          matches: [
            { session_id: '11111111-2222-3333-4444-555555555555', vendor_data: 'id-c0ffee00-0000-4000-8000-000000000001', similarity_percentage: 98.1, source: 'session', user_details: { full_name: 'Someone Else' } },
            { session_id: null, vendor_data: 'id-c0ffee00-0000-4000-8000-000000000002', similarity_percentage: 91, source: 'retained_template', user_details: null },
            { session_id: '66666666-2222-3333-4444-555555555555', vendor_data: 'id-c0ffee00-0000-4000-8000-000000000001', similarity_percentage: 90 },
            { session_id: null, vendor_data: null, source: 'list_entry', is_blocklisted: true },
            // Didit leaves the session's own user out; were it ever listed, it is no other person.
            { session_id: null, vendor_data: VENDOR_DATA, source: 'retained_template' },
          ],
          warnings: [{ feature: 'LIVENESS', risk: 'DUPLICATED_FACE', log_type: 'information', short_description: 'Duplicated face', node_id: 'liveness', additional_data: { duplicated_session_id: '11111111-2222-3333-4444-555555555555', duplicated_session_number: 7, api_service: null } }],
        },
        {
          node_id: 'liveness_2',
          status: 'Approved',
          matches: [{ vendor_data: 'id-c0ffee00-0000-4000-8000-000000000003', similarity_percentage: 88, source: 'session' }, { vendor_data: 7 }],
          warnings: [
            { feature: 'LIVENESS', risk: 'LOW_FACE_QUALITY' },
            { risk: 7 },
            { risk: 'POSSIBLE_DUPLICATED_FACE', additional_data: { duplicated_session_id: '77777777-2222-3333-4444-555555555555' } },
            { risk: 'POSSIBLE_DUPLICATED_FACE', additional_data: { duplicated_session_id: null } },
            { risk: 'DUPLICATED_FACE_NAME_MISMATCH', additional_data: { duplicated_session_id: '88888888-2222-3333-4444-555555555555' } },
          ],
        },
      ],
      face_matches: [{ node_id: 'face_match', status: 'Approved', score: 91, warnings: [] }],
    }),
  )
  assert.deepEqual(decision, {
    workflowId: WORKFLOW,
    vendorData: VENDOR_DATA,
    status: 'APPROVED',
    liveness: [{ status: 'Approved' }, { status: 'Approved' }],
    documents: [{ status: 'Approved' }, { status: 'Approved' }],
    faceMatches: [{ status: 'Approved' }],
    // Approved: no warning set its status, whatever the steps' own warnings say.
    risks: [],
    faceImage: 'https://example.com/selfie.jpg',
    // Whose faces Didit matched, by their users' vendor_data, once each, from every liveness step: nothing else of a match.
    knownFaces: ['id-c0ffee00-0000-4000-8000-000000000001', 'id-c0ffee00-0000-4000-8000-000000000002', 'id-c0ffee00-0000-4000-8000-000000000003'],
    // The first document step's text, as Didit read it; a field with no text (null, empty, a number, a list) is absent.
    document: {
      address: 'Calle Mayor 1, 28001 Madrid',
      date_of_birth: '1990-05-12',
      date_of_issue: '2022-05-11',
      document_number: 'AB1234567',
      document_subtype: 'PASSPORT_GENERIC',
      document_type: 'Passport',
      expiration_date: '2032-05-11',
      'extra_fields.DL Class': 'B',
      'extra_fields.profession': 'Ingeniera',
      first_name: 'María',
      full_name: 'María García López',
      gender: 'F',
      issuing_state: 'ESP',
      last_name: 'García López',
      nationality: 'ESP',
      personal_number: '99999999R',
      place_of_birth: 'Madrid',
    },
    // Of its machine-readable zone, only the names.
    mrz: { given: 'MARIA', family: 'GARCIA LOPEZ' },
  })
  const text = JSON.stringify(decision)
  for (const never of ['media.example', 'Spain', 'Madrid, Spain', '900512', 'IDESP', 'ANSI', '11111111', '66666666', '77777777', '88888888', 'Someone Else', 'ocr', 'documentary', 'retained_template', 'similarity', 'LOW_FACE_QUALITY', 'DUPLICATED_FACE']) {
    assert.equal(text.includes(never), false, `${never} is not read`)
  }
  assert.equal(judge(decision, WORKFLOW, 'id'), null)
})

test("a decision's risks are those of the warnings Didit says set its status, once each, and no other warning's", () => {
  const trace = (status_warnings: unknown) => parseDecision(decisionBody({ status: 'Declined', decision_trace: { status: 'Declined', decided_by: 'automatic', status_warnings } })).risks
  const warning = (risk: unknown) => ({ risk, feature: 'LIVENESS', node_id: 'liveness', log_type: 'error', check_status: 'Declined', source: 'liveness_checks', short_description: 'Duplicated face' })
  assert.deepEqual(trace([warning('DUPLICATED_FACE'), warning('LOW_LIVENESS_SCORE'), warning('DUPLICATED_FACE')]), ['DUPLICATED_FACE', 'LOW_LIVENESS_SCORE'])
  assert.deepEqual(trace([warning(7), warning(''), 'DUPLICATED_FACE', null]), [], 'nothing that is no risk')
  for (const none of [[], null, 'DUPLICATED_FACE', undefined]) assert.deepEqual(trace(none), [], JSON.stringify(none))
  // A status set by hand lists none, as Didit's sandbox shows: whatever the steps' own warnings say.
  const byHand = parseDecision(decisionBody({ status: 'Declined', decision_trace: { status: 'Declined', decided_by: 'manual', status_warnings: [] }, liveness_checks: [{ status: 'Declined', warnings: [warning('DUPLICATED_FACE')] }] }))
  assert.deepEqual(byHand.risks, [])
  assert.equal(judge(byHand, WORKFLOW), 'other')
})

test('a refusal is one code: the first of known_person, known_face, too_young, face_mismatch, id_unclear and face_unclear that a risk says, else other', () => {
  assert.deepEqual(REASONS.map(([reason]) => reason), ['known_person', 'known_face', 'too_young', 'face_mismatch', 'id_unclear', 'face_unclear'])
  const all = REASONS.flatMap(([, risks]) => [...risks])
  assert.equal(new Set(all).size, all.length, 'each risk says one code')
  for (const [reason, risks] of REASONS) {
    assert.ok(CODES.includes(reason), `${reason} is a code`)
    for (const risk of risks) assert.equal(reasonOf([risk]), reason, risk)
  }
  assert.ok(CODES.includes('other'))
  assert.equal(reasonOf(['POSSIBLE_DUPLICATED_USER']), 'known_person')
  assert.equal(reasonOf(['DUPLICATED_FACE']), 'known_face')
  assert.equal(reasonOf(['POSSIBLE_DUPLICATED_FACE']), 'known_face', 'the whole duplicated-face family')
  for (const risk of ['AGE_BELOW_MINIMUM', 'MINIMUM_AGE_NOT_MET']) assert.equal(reasonOf([risk]), 'too_young', risk)
  assert.equal(reasonOf(['AGE_NOT_DETECTED']), 'face_unclear', 'no age estimated: the face could not be read')
  assert.equal(reasonOf(['LOW_FACE_MATCH_SIMILARITY']), 'face_mismatch')
  for (const risk of ['IMAGE_TOO_BLURRY', 'DOCUMENT_EXPIRED', 'DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION', 'PORTRAIT_MANIPULATION_DETECTED']) assert.equal(reasonOf([risk]), 'id_unclear', risk)
  for (const risk of ['LIVENESS_FACE_ATTACK', 'LOW_LIVENESS_SCORE', 'NO_FACE_DETECTED', 'MULTIPLE_FACES_DETECTED']) assert.equal(reasonOf([risk]), 'face_unclear', risk)
  // Several: the first in that order, whatever order Didit lists them in.
  assert.equal(reasonOf(['LOW_LIVENESS_SCORE', 'DOCUMENT_EXPIRED', 'LOW_FACE_MATCH_SIMILARITY', 'DUPLICATED_FACE', 'POSSIBLE_DUPLICATED_USER']), 'known_person')
  assert.equal(reasonOf(['LOW_LIVENESS_SCORE', 'DOCUMENT_EXPIRED', 'LOW_FACE_MATCH_SIMILARITY', 'AGE_BELOW_MINIMUM', 'DUPLICATED_FACE']), 'known_face')
  assert.equal(reasonOf(['LOW_LIVENESS_SCORE', 'DOCUMENT_EXPIRED', 'LOW_FACE_MATCH_SIMILARITY', 'AGE_BELOW_MINIMUM']), 'too_young')
  assert.equal(reasonOf(['LOW_LIVENESS_SCORE', 'DOCUMENT_EXPIRED', 'LOW_FACE_MATCH_SIMILARITY']), 'face_mismatch')
  assert.equal(reasonOf(['LOW_LIVENESS_SCORE', 'DOCUMENT_EXPIRED']), 'id_unclear')
  assert.equal(reasonOf(['FACE_IN_BLOCKLIST', 'LOW_LIVENESS_SCORE']), 'face_unclear')
  // Any other risk, or none.
  for (const risks of [[], ['FACE_IN_BLOCKLIST'], ['MAXIMUM_AGE_EXCEEDED'], ['AML_HIT'], ['duplicated_face']]) assert.equal(reasonOf(risks), 'other', JSON.stringify(risks))
})

test('a photo is fetched from its signed address without the API key, and only from https or this machine', async () => {
  seen.length = 0
  reply = () => [200, 'face bytes']
  const bytes = await client().photo(`${base}/photo/abc?signature=x`)
  assert.equal(new TextDecoder().decode(bytes), 'face bytes')
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.key], ['GET', '/photo/abc?signature=x', undefined])

  reply = () => [403, {}]
  await assert.rejects(client().photo(`${base}/photo/abc`), DiditUnavailable)
  for (const url of ['http://example.com/face.jpg', 'ftp://example.com/face.jpg', 'not a url']) {
    await assert.rejects(client().photo(url), DiditUnavailable, url)
  }
})

test('a session is deleted with DELETE /v3/session/{id}/delete/, asking Didit to keep its face template for 1825 days, or to keep nothing', async () => {
  seen.length = 0
  reply = () => [200, { session_id: SESSION, session_number: 1024, face_retention_outcome: 'retained_with_user', biometric_template_uuid: '9d2f4b6e-1c3a-4e8f-b7d5-0a1c2e3f4a5b', biometric_template_expires_at: '2036-10-20T00:00:00Z', deleted_child_verifications: 0 }]
  assert.equal(await client().deleteSession(SESSION, true), 'retained_with_user')
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.key], ['DELETE', `/v3/session/${SESSION}/delete/`, KEY])
  assert.deepEqual(JSON.parse(seen[0]!.body), { retain_face_embeddings: true, face_retention_days: 1825 })
  assert.equal(FACE_RETENTION_DAYS, 1825, 'five years, as long as the foundation’s Didit plan keeps anything')

  reply = () => [200, { session_id: SESSION, face_retention_outcome: 'deleted' }]
  assert.equal(await client().deleteSession(SESSION, false), 'deleted', 'what Didit did, as it says it')
  assert.deepEqual(JSON.parse(seen[1]!.body), { retain_face_embeddings: false }, 'the face goes with the session, whatever the application’s own setting')
  reply = () => [404, { detail: 'Not found.' }]
  assert.equal(await client().deleteSession(SESSION, true), 'gone', 'a session already deleted')
  for (const answer of [[503, { detail: 'The session could not be deleted because a storage service is unavailable.' }], [403, {}]] as [number, unknown][]) {
    reply = () => answer
    await assert.rejects(client().deleteSession(SESSION, false), (error: Error) => error instanceof DiditUnavailable && error.status === answer[0] && error.codes.length === 0 && !error.message.includes(SESSION))
  }
})

test('a user is deleted with POST /v3/users/delete/, by its vendor_data alone, keeping no face template; one already gone is no error, a refusal throws', async () => {
  seen.length = 0
  reply = () => [200, { deleted: 1 }]
  await client().deleteUser(VENDOR_DATA)
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.key], ['POST', '/v3/users/delete/', KEY])
  assert.deepEqual(JSON.parse(seen[0]!.body), { vendor_data_list: [VENDOR_DATA] }, 'its sessions are not named, and no template is kept')
  reply = () => [200, { deleted: 0 }]
  await client().deleteUser(VENDOR_DATA)
  for (const answer of [[409, { code: 'subject_deletion_in_progress', detail: 'Another request is deleting this person.' }], [503, { detail: 'An external store is unavailable.' }], [429, {}]] as [number, unknown][]) {
    reply = () => answer
    await assert.rejects(client().deleteUser(VENDOR_DATA), (error: Error) => error instanceof DiditUnavailable && error.status === answer[0] && !error.message.includes(VENDOR_DATA) && !JSON.stringify(error).includes('person'))
  }
})

test("a face deleted: a user's sessions listed with GET /v3/sessions/ by its vendor_data, only its own, and each erased as a privacy erasure, keeping no template; one already gone is no error", async () => {
  seen.length = 0
  const other = 'c0ffee00'.repeat(8)
  reply = () => [200, { count: 3, next: null, previous: null, results: [
    { session_id: SESSION, vendor_data: VENDOR_DATA, status: 'Approved', full_name: 'Ada Lovelace' },
    { session_id: '11111111-2222-3333-4444-555555555555', vendor_data: other },
    { session_id: 7, vendor_data: VENDOR_DATA },
  ] }]
  assert.deepEqual(await client().sessionsOf(VENDOR_DATA), [SESSION], "its own sessions' ids, and nothing else of them")
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.key, seen[0]!.body], ['GET', `/v3/sessions/?vendor_data=${VENDOR_DATA}&page_size=100`, KEY, ''])
  reply = () => [200, { detail: 'no results' }]
  await assert.rejects(client().sessionsOf(VENDOR_DATA), (error: Error) => error instanceof DiditUnavailable && error.status === 200)
  reply = () => [503, { code: 'unavailable' }]
  await assert.rejects(client().sessionsOf(VENDOR_DATA), (error: Error) => error instanceof DiditUnavailable && error.status === 503 && !error.message.includes(VENDOR_DATA))

  seen.length = 0
  reply = () => [200, { session_id: SESSION, face_retention_outcome: 'deleted' }]
  await client().eraseSession(SESSION)
  assert.deepEqual([seen[0]!.method, seen[0]!.url], ['DELETE', `/v3/session/${SESSION}/delete/`])
  assert.deepEqual(JSON.parse(seen[0]!.body), { deletion_instruction: 'privacy_erasure' }, 'every template of its user goes, whatever the application’s setting')
  reply = () => [404, { detail: 'Not found.' }]
  await client().eraseSession(SESSION)
  reply = () => [400, { detail: 'retain_face_embeddings cannot be true with privacy_erasure' }]
  await assert.rejects(client().eraseSession(SESSION), (error: Error) => error instanceof DiditUnavailable && error.status === 400 && !error.message.includes(SESSION))
})

test('a session Didit does not know is no decision; anything else unexpected throws, naming no session', async () => {
  reply = () => [404, { detail: 'Not found.' }]
  assert.equal(await client().decision(SESSION), null)

  for (const answer of [[500, {}], [401, { detail: 'bad key' }], [200, 'not json']] as [number, unknown][]) {
    reply = () => answer
    await assert.rejects(client().decision(SESSION), (error: Error) => {
      assert.ok(error instanceof DiditUnavailable)
      assert.ok(!error.message.includes(SESSION), 'the message carries no session id')
      return true
    })
  }
  reply = () => [201, { url: 'https://verify.didit.me/x' }]
  await assert.rejects(client().createSession({ vendorData: VENDOR_DATA }), DiditUnavailable)

  // A refusal: its status, and the `code` Didit sends beside `detail`; never `detail`, Didit's own words.
  reply = () => [402, { detail: `Not enough credits to open a session on ${WORKFLOW}.`, code: 'insufficient_credits' }]
  await assert.rejects(client().createSession({ vendorData: VENDOR_DATA }), (error: Error) => {
    assert.ok(error instanceof DiditUnavailable)
    assert.deepEqual([error.message, error.status, error.codes], ['Didit answered 402 to a new session', 402, ['insufficient_credits']])
    assert.ok(!JSON.stringify(error).includes('credits to'), 'not its detail')
    return true
  })
  for (const [answer, codes] of [[{ detail: 'bad key' }, []], ['<html>oops</html>', []], [{ detail: 'Not found.', code: 'not_found' }, ['not_found']], [{ code: KEY }, []]] as [unknown, string[]][]) {
    reply = () => [401, answer]
    await assert.rejects(client().decision(SESSION), (error: Error) => error instanceof DiditUnavailable && error.message === 'Didit answered 401 to a decision' && error.status === 401 && JSON.stringify(error.codes) === JSON.stringify(codes))
  }

  const unreachable = new DiditClient({ apiKey: KEY, workflowId: WORKFLOW, baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(unreachable.decision(SESSION), (error: Error) => {
    assert.ok(error instanceof DiditUnavailable)
    assert.ok(!error.message.includes(SESSION))
    return true
  })
})

test('too young: a face Didit estimates under its minimum; an ID check only for a birth date Didit read that shows under 18, any other an ID it could not read', () => {
  const at = Date.UTC(2026, 10, 24)
  assert.equal(MINIMUM_AGE, 18)
  assert.deepEqual(['2008-11-24', '2008-11-25', '1990-02-28', '2026-11-24'].map((birth) => yearsOld(birth, at)), [18, 17, 36, 0])
  for (const birth of ['', '24/11/2008', '2008-02-30', '0099-01-01', '2027-01-01', '1890-01-01', ' 2008-11-24x']) assert.equal(yearsOld(birth, at), null, birth)
  const refused = (risks: string[], document: Record<string, string> | null) => ({ ...parseDecision(decisionBody({ status: 'Declined' })), risks, document })
  assert.equal(reasonFor(refused(['AGE_BELOW_MINIMUM'], null), 'face', at), 'too_young', 'the face check estimates, and reads no birth date')
  assert.equal(reasonFor(refused(['MINIMUM_AGE_NOT_MET'], { date_of_birth: '2008-11-25' }), 'id', at), 'too_young', 'a day short of 18')
  for (const document of [{ date_of_birth: '2008-11-24' }, {}, { date_of_birth: '24/11/2008' }, { date_of_birth: '1890-01-01' }, null] as (Record<string, string> | null)[]) {
    assert.equal(reasonFor(refused(['MINIMUM_AGE_NOT_MET'], document), 'id', at), 'id_unclear', JSON.stringify(document))
  }
  assert.equal(reasonFor(refused(['POSSIBLE_DUPLICATED_USER', 'MINIMUM_AGE_NOT_MET'], {}), 'id', at), 'known_person', 'the order first')
  assert.equal(judge({ ...refused(['MINIMUM_AGE_NOT_MET'], { date_of_birth: '2015-06-01' }), workflowId: WORKFLOW }, WORKFLOW, 'id', at), 'too_young')
  assert.equal(judge({ ...refused(['MINIMUM_AGE_NOT_MET'], {}), workflowId: WORKFLOW }, WORKFLOW, 'id', at), 'id_unclear')
})

test("what Didit's decision means to the verifier, in order", () => {
  const ok = parseDecision(decisionBody())
  assert.equal(judge(null, WORKFLOW), 'unknown_session')
  assert.equal(judge(ok, 'another'), 'wrong_workflow')
  assert.equal(judge(parseDecision({}), WORKFLOW), 'wrong_workflow', 'an empty answer counts for nothing')
  // Declined or In Review: Didit's refusal, by the risks that set it; none, other.
  for (const status of ['Declined', 'DECLINED', 'In Review', 'IN_REVIEW']) {
    assert.equal(judge({ ...ok, status }, WORKFLOW), 'other', status)
    assert.equal(judge({ ...ok, status, risks: ['DUPLICATED_FACE'] }, WORKFLOW), 'known_face', status)
    assert.equal(judge({ ...ok, status, risks: ['DOCUMENT_EXPIRED', 'POSSIBLE_DUPLICATED_USER'] }, WORKFLOW, 'id'), 'known_person', status)
  }
  assert.equal(judge({ ...ok, risks: ['DUPLICATED_FACE'] }, WORKFLOW), null, 'Approved is Didit passing it, whatever it says')
  for (const status of ['Expired', 'EXPIRED', 'Abandoned', 'ABANDONED']) assert.equal(judge({ ...ok, status }, WORKFLOW), 'expired', status)
  for (const status of ['Not Started', 'NOT_STARTED', 'In Progress', 'Resubmitted', 'Kyc Expired', '']) {
    assert.equal(judge({ ...ok, status }, WORKFLOW), 'not_approved', status)
  }
  // Approved, without a step its check needs: not a workflow that makes this check.
  assert.equal(judge({ ...ok, liveness: [] }, WORKFLOW), 'wrong_workflow')
  assert.equal(judge({ ...ok, liveness: [{ status: 'Not Finished' }] }, WORKFLOW), 'wrong_workflow')

  // The ID check: the same, with every document step and every face match.
  const id = { ...ok, documents: [{ status: 'Approved' }], faceMatches: [{ status: 'Approved' }], document: {} }
  assert.equal(judge(id, WORKFLOW, 'id'), null)
  assert.equal(judge(ok, WORKFLOW, 'id'), 'wrong_workflow', 'a face check is not an ID check')
  for (const over of [{ liveness: [] }, { documents: [{ status: 'Declined' }] }, { faceMatches: [] }, { faceMatches: [{ status: 'In Review' }] }, { document: null }]) {
    assert.equal(judge({ ...id, ...over }, WORKFLOW, 'id'), 'wrong_workflow', JSON.stringify(over))
  }
})
