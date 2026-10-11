// A stand-in for Didit, for the devnet issuer only: the issuer runs on devnet without a real face
// check or document check. It answers the calls the issuer's Didit client makes (issuer/src/didit.ts),
// in Didit's API v3 shape:
//
//   POST /v3/session/                   opens a session on the workflow the body names: {session_id, url}
//   GET  /v3/sessions/?vendor_data=     the sessions it opened with that vendor_data on that workflow
//        &workflow_id=                  (workflow_id), newest first: {results: [{session_id, session_url}]}
//   GET  /v3/session/{id}/decision/     every session it opened passed: approved, one liveness step
//                                       approved, with a selfie and no face seen before; on the document
//                                       workflow, one document step and one face match approved too,
//                                       the document read as a name made up for that session, a fixed
//                                       birth date and GBR. A session it never opened is a 404.
//   GET  /photo/{id}                    the selfie: a few bytes that are no photo. The issuer runs with
//                                       FACE_MODEL=stand-in beside it, one embedding for everyone, so
//                                       nothing reads them as a face.
//
// So every face check passes, and so does every document check, each for a person no one has seen:
// anyone who asks the devnet issuer gets a note, at either tier (the issuer's own limit on sessions an
// hour per address still holds). deploy/start.sh starts it only when DIDIT_API_KEY is unset, on
// 127.0.0.1 inside the issuer's container, where nothing else reaches it. It keeps in memory the
// sessions it opened, their workflows and vendor_data and, for a document session, the name it made
// up, nothing else, and forgets them on restart. It logs nothing per request.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID
if (!idWorkflow) throw new Error('FAKE_DIDIT_ID_WORKFLOW_ID is not set')

/** Each session it opened, oldest first: its workflow, its vendor_data, and for a document session the name it makes up. */
const opened = new Map<string, { workflow: string; vendorData: string; lastName?: string }>()
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/
const photo = /^\/photo\/([0-9a-f-]{36})$/

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/v3/session/') {
      let body: { workflow_id?: unknown; vendor_data?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const workflow = String(body.workflow_id ?? '')
      const vendorData = String(body.vendor_data ?? '')
      const id = randomUUID()
      opened.set(id, workflow === idWorkflow ? { workflow, vendorData, lastName: `Standin ${randomBytes(6).toString('hex')}` } : { workflow, vendorData })
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
      const passed = { status: 'Approved', warnings: [] }
      return send(200, {
        session_id: match[1],
        status: 'Approved',
        workflow_id: session.workflow,
        id_verifications: session.lastName
          ? [{ ...passed, first_name: 'Devnet', last_name: session.lastName, full_name: `Devnet ${session.lastName}`, date_of_birth: '1990-01-01', issuing_state: 'GBR' }]
          : null,
        liveness_checks: [{ ...passed, method: 'PASSIVE', reference_image: `http://127.0.0.1:${port}/photo/${match[1]}`, matches: [] }],
        face_matches: session.lastName ? [passed] : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; every session it opens is approved`))
