import * as Effect from 'effect/Effect'
import { program } from './worker.js'

// Trusted modules are compiled by the supervisor and mounted read-only. The fresh process owns
// only its VM and pipe; it inherits no TypeScript loader or application runtime authority.
// oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone isolated process executable entry.
await Effect.runPromise(program)
