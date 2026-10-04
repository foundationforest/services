// A stand-in for Didit, for the devnet issuer only: the issuer runs on devnet without a real face
// check or ID check. It answers the two calls the issuer's Didit client makes (issuer/src/didit.ts),
// in Didit's API v3 shape:
//
//   POST /v3/session/                   opens a session on the workflow the body names: {session_id, url}
//   GET  /v3/session/{id}/decision/     every session it opened passed: approved, one liveness step
//                                       approved, no warning, no face-search match; on the ID
//                                       workflow, one document step and one face match approved too.
//                                       A session it never opened is a 404.
//
// So every check "passes", and anyone who asks the devnet issuer for a session can put a stamp on
// either of devnet's lists (the issuer's own limit on sessions an hour per address still holds).
// deploy/start.sh starts it only when DIDIT_API_KEY is unset, on 127.0.0.1 inside the issuer's
// container, where nothing else reaches it. It keeps the ids it opened and their workflows in
// memory, and nothing else, and logs nothing per request.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID
if (!idWorkflow) throw new Error('FAKE_DIDIT_ID_WORKFLOW_ID is not set')

/** Each session it opened, and the workflow it was opened on. */
const opened = new Map<string, string>()
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/v3/session/') {
      let workflow = ''
      try {
        workflow = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).workflow_id ?? '')
      } catch {}
      const id = randomUUID()
      opened.set(id, workflow)
      return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
    }
    const match = req.method === 'GET' ? decision.exec(req.url ?? '') : null
    const workflow = match ? opened.get(match[1]) : undefined
    if (match && workflow !== undefined) {
      const passed = [{ status: 'Approved', warnings: [] }]
      return send(200, {
        session_id: match[1],
        status: 'Approved',
        workflow_id: workflow,
        id_verifications: workflow === idWorkflow ? passed : null,
        liveness_checks: [{ status: 'Approved', method: 'PASSIVE', warnings: [], matches: [] }],
        face_matches: workflow === idWorkflow ? passed : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; every session it opens is approved`))
