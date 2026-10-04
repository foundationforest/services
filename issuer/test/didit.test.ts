// The real Didit client against a local stand-in that answers the way Didit's documents say it does
// (September 2026, API v3). Nothing here reaches Didit itself.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { DiditClient, DiditUnavailable, judge, parseDecision } from '../src/didit.ts'

const KEY = 'test-api-key'
const WORKFLOW = '550e8400-e29b-41d4-a716-446655440000'
const SESSION = '4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a'

/** A decision in the shape of Didit's own example: an uppercase status, reports as arrays, extra fields. */
function decisionBody(over: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    session_kind: 'user',
    session_number: 1024,
    status: 'APPROVED',
    workflow_id: WORKFLOW,
    vendor_data: 'c0ffee00-0000-4000-8000-000000000000',
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

const client = (tier: 'face' | 'id' = 'face') => new DiditClient({ apiKey: KEY, workflowId: WORKFLOW, tier, baseUrl: base + '/' })

test("a session is opened on the workflow, each with its own vendor_data: its list's tag and a random id", async () => {
  seen.length = 0
  reply = () => [201, { session_id: SESSION, session_number: 1, url: 'https://verify.didit.me/session/abc', status: 'Not Started', workflow_id: WORKFLOW }]
  const first = await client().createSession()
  await client().createSession()
  await client('id').createSession()
  assert.deepEqual(first, { sessionId: SESSION, url: 'https://verify.didit.me/session/abc' })

  const [a, b, c] = seen
  assert.equal(a.method, 'POST')
  assert.equal(a.url, '/v3/session/')
  assert.equal(a.key, KEY)
  const [bodyA, bodyB] = [JSON.parse(a.body), JSON.parse(b.body)]
  assert.deepEqual(Object.keys(bodyA).sort(), ['vendor_data', 'workflow_id'], 'nothing about the person')
  assert.equal(bodyA.workflow_id, WORKFLOW)
  assert.match(bodyA.vendor_data, /^face-[0-9a-f-]{36}$/)
  assert.notEqual(bodyA.vendor_data, bodyB.vendor_data)
  assert.match(JSON.parse(c.body).vendor_data, /^id-[0-9a-f-]{36}$/)
})

test('a decision is read from GET /v3/session/{id}/decision/ and cut down', async () => {
  seen.length = 0
  reply = () => [200, decisionBody()]
  const decision = await client().decision(SESSION)
  assert.deepEqual(seen[0], { method: 'GET', url: `/v3/session/${SESSION}/decision/`, key: KEY, body: '' })
  assert.deepEqual(decision, {
    workflowId: WORKFLOW,
    status: 'APPROVED',
    liveness: [{ status: 'Approved' }],
    risks: [],
    documents: [],
    faceMatches: [],
    matches: [],
  })
  assert.equal(judge(decision, WORKFLOW), null, 'an uppercase APPROVED counts')
})

test("an ID check's decision: the document, the face match, and the list each earlier session with the face was for", () => {
  const decision = parseDecision(
    decisionBody({
      features: 'OCR + LIVENESS + FACE_MATCH',
      id_verifications: [{ node_id: 'ocr', status: 'Approved', full_name: 'Someone', document_number: 'X123', warnings: [] }],
      liveness_checks: [
        {
          node_id: 'liveness',
          status: 'Approved',
          matches: [
            { session_id: '11111111-2222-3333-4444-555555555555', vendor_data: 'face-c0ffee00-0000-4000-8000-000000000001', status: 'Approved', similarity_percentage: 98.1 },
            { session_id: '66666666-7777-8888-9999-000000000000', vendor_data: 'id-c0ffee00-0000-4000-8000-000000000002', status: 'Approved', similarity_percentage: 97.4 },
          ],
          warnings: [{ feature: 'LIVENESS', risk: 'DUPLICATED_FACE' }],
        },
      ],
      face_matches: [{ node_id: 'face_match', status: 'Approved', score: 91, warnings: [] }],
    }),
  )
  assert.deepEqual(decision, {
    workflowId: WORKFLOW,
    status: 'APPROVED',
    liveness: [{ status: 'Approved' }],
    risks: ['DUPLICATED_FACE'],
    documents: [{ status: 'Approved' }],
    faceMatches: [{ status: 'Approved' }],
    matches: ['face-c0ffee00-0000-4000-8000-000000000001', 'id-c0ffee00-0000-4000-8000-000000000002'],
  })
  assert.equal(JSON.stringify(decision).includes('Someone'), false, 'nothing about the person is kept')
  assert.equal(judge(decision, WORKFLOW, 'id'), 'duplicate_face', 'an earlier ID session with this face')
  assert.equal(judge({ ...decision, matches: decision.matches.slice(0, 1) }, WORKFLOW, 'id'), null, 'an earlier face session only')
  assert.equal(judge({ ...decision, matches: decision.matches.slice(0, 1) }, WORKFLOW, 'face'), 'duplicate_face', 'the face check refuses either')
})

test('a duplicate is read from the liveness warnings and from the face-match warnings', async () => {
  const duplicate = (risk: string) => ({ feature: 'LIVENESS', risk, log_type: 'error', short_description: 'Duplicated face' })
  reply = () => [
    200,
    decisionBody({
      status: 'Declined',
      liveness_checks: [
        {
          node_id: 'feature_liveness_1',
          status: 'Declined',
          matches: [{ session_id: '11111111-2222-3333-4444-555555555555', similarity_percentage: 97.2, source: 'session' }],
          warnings: [duplicate('DUPLICATED_FACE')],
        },
      ],
    }),
  ]
  const decision = await client().decision(SESSION)
  assert.deepEqual(decision?.risks, ['DUPLICATED_FACE'])
  assert.equal(judge(decision, WORKFLOW), 'duplicate_face')

  const fromFaceMatch = parseDecision(
    decisionBody({ face_matches: [{ node_id: 'fm', status: 'In Review', warnings: [duplicate('POSSIBLE_DUPLICATED_FACE')] }] }),
  )
  assert.equal(judge(fromFaceMatch, WORKFLOW), 'duplicate_face')
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
  await assert.rejects(client().createSession(), DiditUnavailable)

  const unreachable = new DiditClient({ apiKey: KEY, workflowId: WORKFLOW, tier: 'face', baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(unreachable.decision(SESSION), (error: Error) => {
    assert.ok(error instanceof DiditUnavailable)
    assert.ok(!error.message.includes(SESSION))
    return true
  })
})

test('the rule, in order', () => {
  const ok = parseDecision(decisionBody())
  assert.equal(judge(null, WORKFLOW), 'unknown_session')
  assert.equal(judge(ok, 'another'), 'wrong_workflow')
  assert.equal(judge({ ...ok, risks: ['DUPLICATED_FACE'], status: 'Declined' }, WORKFLOW), 'duplicate_face')
  assert.equal(judge({ ...ok, risks: ['LOW_FACE_QUALITY'] }, WORKFLOW), null, 'other risk codes are Didit’s to weigh')
  assert.equal(judge({ ...ok, liveness: [] }, WORKFLOW), 'no_liveness')
  assert.equal(judge({ ...ok, liveness: [{ status: 'Not Finished' }] }, WORKFLOW), 'liveness_not_passed')
  assert.equal(judge({ ...ok, status: 'In Review' }, WORKFLOW), 'not_approved')
  assert.equal(judge(parseDecision({}), WORKFLOW), 'wrong_workflow', 'an empty answer counts for nothing')

  // The ID check: the same, then every document step and every face match.
  const id = { ...ok, documents: [{ status: 'Approved' }], faceMatches: [{ status: 'Approved' }] }
  assert.equal(judge(id, WORKFLOW, 'id'), null)
  assert.equal(judge(ok, WORKFLOW, 'id'), 'no_document', 'a face check is not an ID check')
  assert.equal(judge({ ...id, liveness: [] }, WORKFLOW, 'id'), 'no_liveness', 'liveness before the document')
  assert.equal(judge({ ...id, documents: [{ status: 'Declined' }] }, WORKFLOW, 'id'), 'document_not_passed')
  assert.equal(judge({ ...id, faceMatches: [] }, WORKFLOW, 'id'), 'no_face_match')
  assert.equal(judge({ ...id, faceMatches: [{ status: 'In Review' }] }, WORKFLOW, 'id'), 'face_match_not_passed')
  assert.equal(judge({ ...id, status: 'In Review' }, WORKFLOW, 'id'), 'not_approved')
  assert.equal(judge({ ...id, risks: ['DUPLICATED_FACE'], matches: ['face-x'] }, WORKFLOW, 'id'), null)
  assert.equal(judge({ ...id, risks: ['POSSIBLE_DUPLICATED_FACE'] }, WORKFLOW, 'id'), 'duplicate_face', 'flagged, and no match says where')
  assert.equal(judge({ ...id, matches: ['id-x'], status: 'Declined' }, WORKFLOW, 'id'), 'duplicate_face', 'the real reason first')
})
