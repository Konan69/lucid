import { Effect } from 'effect'
import { ensureTemplate } from './database.ts'

/** Cold migration is invocation setup, so a test measures its scenario rather than dependency startup. */
export default function setup() {
  const url = process.env.VIVID_TEST_DATABASE_URL
  if (url === undefined) return Promise.resolve()
  if (new URL(url).port === '55433') throw new Error('Runtime tests refuse the developer database')
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Vitest globalSetup is the runner entry point for this scoped administration connection.
  return Effect.runPromise(Effect.scoped(ensureTemplate(url)).pipe(Effect.asVoid))
}
