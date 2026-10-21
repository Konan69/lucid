import * as NodeFSP from 'node:fs/promises'
import { command } from './process.mjs'
const [scratch] = process.argv.slice(2)
await command(['pnpm', 'build'], { cwd: process.cwd() })
await NodeFSP.rename(process.cwd() + '/dist', scratch + '/runtime')
