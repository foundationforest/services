// A stand-in for Didit, for the devnet issuer only: the issuer runs on devnet without a real face
// check or ID check. It answers the two calls the issuer's Didit client makes (issuer/src/didit.ts),
// in Didit's API v3 shape:
//
//   POST /v3/session/                   opens a session on the workflow the body names: {session_id, url}
//   GET  /v3/session/{id}/decision/     every session it opened passed: approved, one liveness step
//                                       approved; on the ID workflow, one document step and one face
//                                       match approved too. A session it never opened is a 404.
//
// It sees no faces, so for face first it treats the newest face session it opened (its `vendor_data`
// tagged `face-`) as the face an ID session's face search finds: an ID session opened after one
// lists it as a match, flagged `DUPLICATED_FACE` as Didit flags it; an ID session opened before any
// lists none, and the issuer refuses it as it would with Didit. So every face check "passes", and so
// does every ID check after one: anyone who asks the devnet issuer can put a stamp on either of
// devnet's lists (the issuer's own limit on sessions an hour per address still holds).
// deploy/start.sh starts it only when DIDIT_API_KEY is unset, on 127.0.0.1 inside the issuer's
// container, where nothing else reaches it. It keeps in memory the sessions it opened, their
// workflows and the newest face session's `vendor_data`, nothing else, and forgets them on restart.
// It logs nothing per request.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const idWorkflow = process.env.FAKE_DIDIT_ID_WORKFLOW_ID
if (!idWorkflow) throw new Error('FAKE_DIDIT_ID_WORKFLOW_ID is not set')

/** Each session it opened: its workflow, and for an ID session the face session its face search "finds". */
const opened = new Map<string, { workflow: string; faceSeen?: string }>()
/** The `vendor_data` of the newest face session it opened. */
let newestFace: string | undefined
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
      let body: { workflow_id?: unknown; vendor_data?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const workflow = String(body.workflow_id ?? '')
      const vendorData = String(body.vendor_data ?? '')
      const id = randomUUID()
      opened.set(id, workflow === idWorkflow ? { workflow, faceSeen: newestFace } : { workflow })
      if (vendorData.startsWith('face-')) newestFace = vendorData
      return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
    }
    const match = req.method === 'GET' ? decision.exec(req.url ?? '') : null
    const session = match ? opened.get(match[1]) : undefined
    if (match && session) {
      const passed = [{ status: 'Approved', warnings: [] }]
      const isId = session.workflow === idWorkflow
      const seen = session.faceSeen
      return send(200, {
        session_id: match[1],
        status: 'Approved',
        workflow_id: session.workflow,
        id_verifications: isId ? passed : null,
        liveness_checks: [
          {
            status: 'Approved',
            method: 'PASSIVE',
            warnings: seen ? [{ feature: 'LIVENESS', risk: 'DUPLICATED_FACE' }] : [],
            matches: seen ? [{ session_id: randomUUID(), vendor_data: seen, status: 'Approved', similarity_percentage: 99 }] : [],
          },
        ],
        face_matches: isId ? passed : null,
      })
    }
    send(404, { detail: 'Not found.' })
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; every session it opens is approved`))
