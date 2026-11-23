// A stand-in for Didit, for tests on this machine only: the verifier's own test of both checks, and the
// end-to-end test's verifier (e2e/), since a script has no face. It answers the calls the
// verifier's Didit client makes (verifier/src/didit.ts), in Didit's API v3 shape, for one
// application with two workflows: the face check's and the ID check's, the foundation's live ones
// unless FAKE_DIDIT_FACE_WORKFLOW_ID and FAKE_DIDIT_ID_WORKFLOW_ID name others.
//
//   POST /v3/session/                   opens a session on one of the two workflows, under the
//                                       `vendor_data` it is sent: {session_id, url}; a session on any
//                                       other workflow is a 400
//   GET  /v3/session/{id}/decision/     what the session came to, by the `sandbox_scenario` it was
//                                       opened with, as Didit's sandbox application does: `review_…` is
//                                       In Review, `decline_…` Declined, anything else (or none) Approved;
//                                       its `vendor_data`; one liveness step of that status, with a
//                                       selfie, matching the person's own earlier faces: each approved
//                                       session opened before it, and each face template kept, under
//                                       the same stamp number's hash in its `vendor_data`, five at most;
//                                       and for a scenario that names `duplicated_face`, first one face
//                                       under another stamp number's, and its risk DUPLICATED_FACE
//                                       naming that session;
//                                       on the ID workflow, one document step and one face match of that
//                                       status too, the document read as a name made up for that
//                                       session, a fixed birth date and GBR. A session it never opened is
//                                       a 404.
//   DELETE /v3/session/{id}/delete/     deletes the session: its decision and its photo are gone; 200
//                                       {session_id, face_retention_outcome}, `retained_with_user`, its
//                                       face template kept under its `vendor_data`, when the body asks
//                                       to retain the face (`retain_face_embeddings`), else `deleted`;
//                                       404 for a session it does not have
//   GET  /photo/{id}                    the selfie: a few bytes that are no photo. The verifier runs with
//                                       FACE_MODEL=stand-in beside it, one embedding for everyone, so
//                                       nothing reads them as a face.
//   GET  /v3/users/{vendor_data}/       a 404: a face it matches is no user it has.
//
// It cannot see a face, so it matches none of another stamp number's but by a scenario: every check
// passes unless a scenario says otherwise, each ID check for a person no one has seen.
// It listens on 127.0.0.1 only, and the verifier takes the stand-in embedding only with a Didit on
// loopback; nothing in the verifier's image starts it. It keeps in memory the sessions it opened, their
// workflows, `vendor_data` and scenarios and, for an ID session, the name it made up, and the
// `vendor_data` of each face template kept, nothing else, and forgets them when it stops. It logs
// nothing per request.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const faceWorkflow = process.env.FAKE_DIDIT_FACE_WORKFLOW_ID || 'e2622cbf-0b3a-484e-bb94-3bad22d20833'
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID || '4ddd9ce6-5d8c-4984-9833-5e2b612f30b2'

/** Each session it opened, oldest first: its workflow, its `vendor_data`, its status, and for an ID session the name it makes up. */
const opened = new Map<string, { workflow: string; vendorData: string; status: string; seen: boolean; lastName?: string }>()
/** The `vendor_data` of each session deleted with its face template kept. */
const templates: string[] = []
/** The stamp number's hash a `vendor_data` carries, as the verifier writes it (verifier/src/didit.ts), or null. */
const hashOf = (vendorData: string) => /^(?:face|id)-([0-9a-f]{64})-/.exec(vendorData)?.[1] ?? null
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/
const deletion = /^\/v3\/session\/([0-9a-f-]{36})\/delete\/$/
const photo = /^\/photo\/([0-9a-f-]{36})$/

/** The status a sandbox scenario comes to. */
const statusOf = (scenario: string) => (scenario.startsWith('review') ? 'In Review' : scenario.startsWith('decline') ? 'Declined' : 'Approved')

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/v3/session/') {
      let body: { workflow_id?: unknown; vendor_data?: unknown; sandbox_scenario?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const workflow = String(body.workflow_id ?? '')
      if (workflow !== faceWorkflow && workflow !== idWorkflow) return send(400, { workflow_id: ['Workflow not found.'] })
      const id = randomUUID()
      const scenario = String(body.sandbox_scenario ?? '')
      const session = { workflow, vendorData: String(body.vendor_data ?? ''), status: statusOf(scenario), seen: scenario.includes('duplicated_face') }
      opened.set(id, workflow === idWorkflow ? { ...session, lastName: `Standin ${randomBytes(6).toString('hex')}` } : session)
      return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
    }
    const deleted = req.method === 'DELETE' ? deletion.exec(req.url ?? '') : null
    if (deleted) {
      const gone = opened.get(deleted[1]!)
      if (!gone || !opened.delete(deleted[1]!)) return send(404, { detail: 'Not found.' })
      let body: { retain_face_embeddings?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const outcome = body.retain_face_embeddings === true ? 'retained_with_user' : 'deleted'
      if (outcome === 'retained_with_user') templates.push(gone.vendorData)
      return send(200, { session_id: deleted[1], session_number: 0, face_retention_outcome: outcome, deleted_child_verifications: 0 })
    }
    const asked = req.method === 'GET' ? photo.exec(req.url ?? '') : null
    if (asked && opened.has(asked[1]!)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return void res.end('stand-in selfie: no face')
    }
    const match = req.method === 'GET' ? decision.exec(req.url ?? '') : null
    const session = match ? opened.get(match[1]!) : undefined
    if (match && session) {
      const step = { status: session.status, warnings: [] }
      // A face seen before: one under another stamp number, which only a verifier with another secret could have written.
      const other = { session_id: randomUUID(), vendor_data: `face-${randomBytes(32).toString('hex')}-${randomUUID()}`, similarity_percentage: 91.5, source: 'session', status: 'Approved' }
      // The person's own earlier faces: the approved sessions opened before this one, and the templates kept, under its stamp number's hash.
      const hash = hashOf(session.vendorData)
      const earlier = [...opened].slice(0, [...opened.keys()].indexOf(match[1]!))
      const own = hash === null ? [] : [
        ...earlier.filter(([, s]) => s.status === 'Approved' && hashOf(s.vendorData) === hash).map(([id, s]) => ({ session_id: id, vendor_data: s.vendorData, similarity_percentage: 97, source: 'session', status: 'Approved' })),
        ...templates.filter((v) => hashOf(v) === hash).map((v) => ({ session_id: null, vendor_data: v, similarity_percentage: 96, source: 'session', status: 'Approved' })),
      ]
      const matches = [...(session.seen ? [other] : []), ...own].slice(0, 5)
      return send(200, {
        session_id: match[1],
        status: session.status,
        workflow_id: session.workflow,
        vendor_data: session.vendorData,
        id_verifications: session.lastName
          ? [{ ...step, first_name: 'Sam', last_name: session.lastName, full_name: `Sam ${session.lastName}`, date_of_birth: '1990-01-01', issuing_state: 'GBR' }]
          : null,
        liveness_checks: [
          {
            ...step,
            ...(session.seen && { warnings: [{ feature: 'LIVENESS', risk: 'DUPLICATED_FACE', log_type: 'information', additional_data: { duplicated_session_id: other.session_id } }] }),
            method: 'PASSIVE',
            reference_image: `http://127.0.0.1:${port}/photo/${match[1]}`,
            matches,
          },
        ],
        face_matches: session.lastName ? [step] : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; a session comes to what its sandbox_scenario says, else approved`))
