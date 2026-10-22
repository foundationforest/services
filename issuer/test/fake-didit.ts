// A stand-in for Didit, for tests on this machine only: the issuer's own test of both checks, and the
// e2e loop's issuer (e2e/), since a script has no face. It answers the calls the issuer's Didit client
// makes (issuer/src/didit.ts), in Didit's API v3 shape, for two workflows: the face check's and the ID
// check's, the foundation's live ones unless FAKE_DIDIT_FACE_WORKFLOW_ID and FAKE_DIDIT_ID_WORKFLOW_ID
// name others.
//
//   POST /v3/session/                   opens a session on one of the two workflows: {session_id, url};
//                                       a session on any other is a 400
//   GET  /v3/sessions/?vendor_data=     the sessions it opened with that vendor_data on that workflow
//        &workflow_id=                  (workflow_id), newest first: {results: [{session_id, session_url}]}
//   GET  /v3/session/{id}/decision/     what the session came to, by the `sandbox_scenario` it was
//                                       opened with, as Didit's sandbox application does: `review_…` is
//                                       In Review, `decline_…` Declined, anything else (or none) Approved;
//                                       one liveness step of that status, with a selfie; on the ID
//                                       workflow, one document step and one face match of that status
//                                       too, the document read as a name made up for that session, a
//                                       fixed birth date and GBR. A session it never opened is a 404.
//   GET  /photo/{id}                    the selfie: a few bytes that are no photo. The issuer runs with
//                                       FACE_MODEL=stand-in beside it, one embedding for everyone, so
//                                       nothing reads them as a face.
//
// So every check passes unless a scenario says otherwise, each ID check for a person no one has seen.
// It listens on 127.0.0.1 only, and the issuer takes the stand-in embedding only with a Didit on
// loopback; nothing in the issuer's image starts it. It keeps in memory the sessions it opened, their
// workflows, vendor_data and scenarios and, for an ID session, the name it made up, nothing else, and
// forgets them when it stops. It logs nothing per request.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const faceWorkflow = process.env.FAKE_DIDIT_FACE_WORKFLOW_ID || '2faaca36-58b4-49d7-90d7-2b9cf002d173'
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID || 'bfbdb912-d2f5-41d8-827c-4304e8209d24'

/** Each session it opened, oldest first: its workflow, its vendor_data, its status, and for an ID session the name it makes up. */
const opened = new Map<string, { workflow: string; vendorData: string; status: string; lastName?: string }>()
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/
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
      const session = { workflow, vendorData: String(body.vendor_data ?? ''), status: statusOf(String(body.sandbox_scenario ?? '')) }
      opened.set(id, workflow === idWorkflow ? { ...session, lastName: `Standin ${randomBytes(6).toString('hex')}` } : session)
      return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/v3/sessions/') {
      const results = [...opened]
        .filter(([, s]) => s.vendorData === url.searchParams.get('vendor_data') && s.workflow === url.searchParams.get('workflow_id'))
        .reverse()
        .map(([id]) => ({ session_id: id, session_url: `https://fake-didit.invalid/session/${id}` }))
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
      return send(200, {
        session_id: match[1],
        status: session.status,
        workflow_id: session.workflow,
        id_verifications: session.lastName
          ? [{ ...step, first_name: 'Sam', last_name: session.lastName, full_name: `Sam ${session.lastName}`, date_of_birth: '1990-01-01', issuing_state: 'GBR' }]
          : null,
        liveness_checks: [{ ...step, method: 'PASSIVE', reference_image: `http://127.0.0.1:${port}/photo/${match[1]}`, matches: [] }],
        face_matches: session.lastName ? [step] : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; a session comes to what its sandbox_scenario says, else approved`))
