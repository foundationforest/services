// `npm run migrate`: apply migrations/*.sql to DATABASE_URL and stop. The index also does this
// itself at start.

import { createPool, migrate } from './db.ts'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const db = createPool(process.env.DATABASE_URL)
const applied = await migrate(db)
console.log(applied.length ? `applied ${applied.join(', ')}` : 'nothing to apply')
await db.end()
