// Reads one picture address through the app's own ingress (`wire.ts` `screenshotPng`), for
// `wire.test.ts`. The ingress takes a path only in Windows' form (`C:\...`), and off Windows such
// a path is a file name read against the working directory. So the test starts this in a process
// of its own whose working directory is a directory the test owns: the file is real, the read is
// the app's, and nothing is written into the checkout or changed in the test runner's process.
// Prints `some:<base64>` or `none`.
import * as NodeProcess from 'node:process'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { screenshotPng } from './wire.ts'

const address = NodeProcess.argv[2]
if (address === undefined) throw new Error('An address to read is required')
// oxlint-disable-next-line vivid/no-runpromise-in-library -- Entry of a standalone Node test stand-in: this process is the one read and nothing else.
const read = Effect.runSync(screenshotPng(address))
NodeProcess.stdout.write(
  Option.match(read, { onNone: () => 'none', onSome: (picture) => `some:${picture}` }),
)
