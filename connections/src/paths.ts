// Where this repo's copy of forest is: forest.sh fetches it at the commit in FOREST.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FOREST = resolve(dirname(fileURLToPath(import.meta.url)), '../../forest')
