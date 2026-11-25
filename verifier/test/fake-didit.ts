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
//                                       In Review, `decline_…` Declined, anything else (or none)
//                                       Approved; a scenario that names `duplicated_face` is a face
//                                       Didit has seen under another user, Declined, its
//                                       `decision_trace.status_warnings` naming DUPLICATED_FACE; its
//                                       `vendor_data`; one liveness step of that status, with a selfie;
//                                       on the ID workflow, one document step and one face match of that
//                                       status too, the document read as a name made up for that
//                                       session, a fixed birth date and GBR. A session it never opened is
//                                       a 404.
//   DELETE /v3/session/{id}/delete/     deletes the session: its decision and its photo are gone; 200
//                                       {session_id, face_retention_outcome}, `retained_with_user` when
//                                       the body asks to retain the face (`retain_face_embeddings`), else
//                                       `deleted`; a privacy erasure (`deletion_instruction`) that asks to
//                                       retain it is a 400, as at Didit; 404 for a session it does not
//                                       have
//   GET  /v3/sessions/?vendor_data=     the sessions it holds under that `vendor_data`: {count, next,
//                                       previous, results}, each result its session_id, vendor_data and
//                                       status
//   POST /v3/users/delete/              deletes the users of `vendor_data_list`: 200 {deleted}, how many
//                                       of its sessions carry one; their sessions stay, as at Didit
//   GET  /photo/{id}                    the selfie: a few bytes that are no photo. The verifier runs with
//                                       FACE_MODEL=stand-in beside it, one embedding for everyone, so
//                                       nothing reads them as a face.
//
// It cannot see a face, so it has seen no one but by a scenario: every check passes unless a scenario
// says otherwise, each ID check for a person no one has seen.
// It listens on 127.0.0.1 only, and the verifier takes the stand-in embedding only with a Didit on
// loopback; nothing in the verifier's image starts it. It keeps in memory the sessions it opened, their
// workflows, `vendor_data` and scenarios and, for an ID session, the name it made up, nothing else,
// and forgets them when it stops. It logs nothing per request.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const faceWorkflow = process.env.FAKE_DIDIT_FACE_WORKFLOW_ID || 'e2622cbf-0b3a-484e-bb94-3bad22d20833'
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID || '4ddd9ce6-5d8c-4984-9833-5e2b612f30b2'

/** Each session it opened: its workflow, its `vendor_data`, its status, whether it saw the face before, and for an ID session the name it makes up. */
const opened = new Map<string, { workflow: string; vendorData: string; status: string; seen: boolean; lastName?: string }>()
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/
const deletion = /^\/v3\/session\/([0-9a-f-]{36})\/delete\/$/
const photo = /^\/photo\/([0-9a-f-]{36})$/
const list = /^\/v3\/sessions\/\?(.*)$/

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
      const seen = scenario.includes('duplicated_face')
      const session = { workflow, vendorData: String(body.vendor_data ?? ''), status: seen ? 'Declined' : statusOf(scenario), seen }
      opened.set(id, workflow === idWorkflow ? { ...session, lastName: `Standin ${randomBytes(6).toString('hex')}` } : session)
      return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
    }
    if (req.method === 'POST' && req.url === '/v3/users/delete/') {
      let body: { vendor_data_list?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const list = Array.isArray(body.vendor_data_list) ? body.vendor_data_list : []
      if (list.length === 0) return send(400, { vendor_data_list: ['This field is required unless delete_all is true.'] })
      return send(200, { deleted: new Set([...opened.values()].map((session) => session.vendorData).filter((v) => list.includes(v))).size })
    }
    const deleted = req.method === 'DELETE' ? deletion.exec(req.url ?? '') : null
    if (deleted) {
      const gone = opened.get(deleted[1]!)
      if (!opened.delete(deleted[1]!)) return send(404, { detail: 'Not found.' })
      let body: { retain_face_embeddings?: unknown; deletion_instruction?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      if (body.deletion_instruction === 'privacy_erasure' && body.retain_face_embeddings === true) {
        opened.set(deleted[1]!, gone!)
        return send(400, { detail: 'A privacy erasure keeps no template.' })
      }
      const outcome = body.retain_face_embeddings === true ? 'retained_with_user' : 'deleted'
      return send(200, { session_id: deleted[1], session_number: 0, face_retention_outcome: outcome, deleted_child_verifications: 0 })
    }
    const listed = req.method === 'GET' ? list.exec(req.url ?? '') : null
    if (listed) {
      const vendorData = new URLSearchParams(listed[1]).get('vendor_data') ?? ''
      const results = [...opened].filter(([, session]) => session.vendorData === vendorData).map(([id, session]) => ({ session_id: id, vendor_data: session.vendorData, status: session.status }))
      return send(200, { count: results.length, next: null, previous: null, results })
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
      // A face seen before, under another user: Didit's own refusal, the warning that set it.
      const seen = { feature: 'LIVENESS', risk: 'DUPLICATED_FACE', log_type: 'error', source: 'liveness_checks' }
      return send(200, {
        session_id: match[1],
        status: session.status,
        workflow_id: session.workflow,
        vendor_data: session.vendorData,
        decision_trace: { status: session.status, decided_by: 'automatic', status_warnings: session.seen ? [seen] : [] },
        id_verifications: session.lastName
          ? [{ ...step, first_name: 'Sam', last_name: session.lastName, full_name: `Sam ${session.lastName}`, date_of_birth: '1990-01-01', issuing_state: 'GBR' }]
          : null,
        liveness_checks: [
          {
            ...step,
            ...(session.seen && { warnings: [seen] }),
            method: 'PASSIVE',
            reference_image: `http://127.0.0.1:${port}/photo/${match[1]}`,
          },
        ],
        face_matches: session.lastName ? [step] : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; a session comes to what its sandbox_scenario says, else approved`))
