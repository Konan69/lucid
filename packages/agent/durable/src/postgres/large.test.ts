import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { Option, Schema } from 'effect'
import { describe, expect, it, onTestFinished } from 'vitest'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      megabytes: Schema.Finite,
      equal: Schema.Boolean,
      commitMs: Schema.Finite,
      readMs: Schema.Finite,
      commitMsPerMB: Schema.Finite,
      readMsPerMB: Schema.Finite,
      peakRssMB: Schema.Finite,
      longestCallbackMs: Schema.Finite,
    }),
  ),
)

/** Review11c large-entry regression: 64 MB exhausted the old per-character rope
 * allocation at a 1 GB heap. Real PostgreSQL and a child heap cap make an abort
 * observable without killing Vitest. Assert correctness/exit only, never timing. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL bounded-heap entries', () => {
  it.each([16, 64])('round-trips a %i MB entry at a 1024 MB heap bound', async (megabytes) => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        '--max-old-space-size=1024',
        NodeURL.fileURLToPath(new URL('./bench/entry/main.ts', import.meta.url)),
        String(megabytes),
        fixture.schema,
      ],
      {
        stdio: 'pipe',
        env: { ...process.env, VIVID_TEST_DATABASE_URL: Option.getOrThrow(testUrl) },
      },
    )
    onTestFinished(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = NodeEvents.once(child, 'close')
      child.kill('SIGKILL')
      await closed
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text
    })
    const [exitCode, signal] = await NodeEvents.once(child, 'close')
    expect({ exitCode, signal, stderr }).toMatchObject({ exitCode: 0, signal: null })
    const result = decodeResult(stdout.trim())
    expect(result.equal).toBe(true)
    expect(result.megabytes).toBe(megabytes)
    console.log(JSON.stringify(result))
  })
})
