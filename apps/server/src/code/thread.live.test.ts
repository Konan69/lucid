import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { CodeCall } from '@vivid/contracts'
import { Config, Effect, Option, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { bindings } from '../computers/boat/bindings.ts'
import { ReadFile } from '../computers/boat/protocol.ts'
import { computerMachineKey } from '../computers/store.ts'
import { machineBindings } from '../computers/tables.ts'
import { Database } from '../database/client.ts'
import { chainFixture, chainLayer, completeRun, toolParts } from '../runtime/chains.ts'

/** What `run_code` hands the model when a program ran to its end. */
const Ran = Schema.Struct({ ok: Schema.Literal(true), calls: Schema.Array(CodeCall) })
const decodeRan = Schema.decodeUnknownEffect(Ran)
const decodeFile = HttpClientResponse.schemaBodyJson(ReadFile)

/**
 * This proof never makes a machine and never deletes one. It runs only on an installation that
 * names the machine it already has (`VIVID_BOAT_MACHINE`); the new Person takes that machine, and
 * the only thing removed afterwards is that Person's binding row in the disposable database, so
 * the next run's Person can take it again. Registered before the first message is sent.
 */
const releaseComputer = Effect.fn('ProgramProof.releaseComputer')(function* (
  person: Parameters<typeof computerMachineKey>[0],
) {
  const database = yield* Database
  const key = computerMachineKey(person)
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
      .pipe(
        Effect.catch(() =>
          Effect.sync(() => expect.fail('The proof Person still holds the Computer; release it')),
        ),
      ),
  )
})

/**
 * Reads the file the program wrote and then removes it, both through the machine's provider and
 * not through Vivid: what the program wrote is then evidence from outside the thing being proved,
 * and the Computer is left as it was. The path is relative to where commands start, which is
 * where a program runs. The name is this test's own, so nothing else can be removed by it.
 */
const takeFromComputer = Effect.fn('ProgramProof.takeFromComputer')(function* (
  person: Parameters<typeof computerMachineKey>[0],
  name: string,
) {
  const binding = yield* (yield* bindings()).load(computerMachineKey(person))
  if (Option.isNone(binding) || binding.value.providerId === null)
    return yield* Effect.sync(() => expect.fail('The program must have run on a bound Computer'))
  const http = yield* HttpClient.HttpClient
  const key = yield* Config.Redacted('VIVID_BOAT_API_KEY')
  const machine = `https://boat.dev/api/v1/sandboxes/${binding.value.providerId}`
  const response = yield* http.execute(
    HttpClientRequest.get(`${machine}/files?path=${encodeURIComponent(name)}&encoding=base64`).pipe(
      HttpClientRequest.bearerToken(key),
    ),
  )
  expect(response.status, 'The file the program wrote must be on the Computer').toBe(200)
  const text = Buffer.from((yield* decodeFile(response)).content, 'base64').toString('utf8')
  const removed = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${machine}/commands`).pipe(HttpClientRequest.bearerToken(key)),
    { command: `rm -f -- '${name}'`, timeoutSeconds: 30 },
  ).pipe(Effect.flatMap((request) => http.execute(request)))
  expect(removed.status, 'The proof file must not stay on the Computer').toBe(200)
  return text
})

/**
 * One real request, one real model turn: Vivid writes a program, the program runs on the Person's
 * Boat machine, makes two calls that the server checks and answers, and leaves a file there that
 * holds what those calls returned. Public pages only: no account and nothing changed outside.
 */
describe.skipIf(process.env['VIVID_LIVE_THREAD_PROGRAM'] !== '1')(
  'Thread program live chain',
  () => {
    it.live(
      'a program Vivid writes runs on the Computer, has its calls answered and writes there what it read',
      () =>
        Effect.gen(function* () {
          expect(
            yield* Config.NonEmptyString('VIVID_BOAT_MACHINE'),
            'This proof takes the installation’s existing machine; it never creates one',
          ).toMatch(/^bx_/)
          const fixture = yield* chainFixture('Program chain proof')
          yield* releaseComputer(fixture.personId)
          const name = `vivid-program-proof-${NodeCrypto.randomUUID()}.txt`
          const runId = yield* fixture.send(
            `Do this with one run_code program and nothing else. In the program: read https://example.com/ and https://www.iana.org/help/example-domains with tools.read_page, both at the same time. Then use node:fs/promises to write a file named ${name} in the current directory, holding the two page titles, one per line. Return the two titles. Afterwards tell me the titles.`,
          )
          const state = yield* completeRun(fixture, runId)
          const programs = toolParts(state).filter((part) => part.toolName === 'run_code')
          const finished = programs.filter((part) => part.state === 'output-available')
          expect(finished.length, 'The model must have run a program').toBeGreaterThan(0)
          const outputs = yield* Effect.forEach(finished, (part) =>
            part.state === 'output-available'
              ? decodeRan(part.output).pipe(Effect.option)
              : Effect.succeed(Option.none()),
          )
          const ran = outputs.flatMap(Option.toArray)
          expect(ran.length, 'A program must have run to its end').toBeGreaterThan(0)
          const pages = ran.flatMap((program) =>
            program.calls.filter((call) => call.kind === 'read_page' && call.end === 'completed'),
          )
          expect(pages.length, 'The program’s two page reads must both be answered').toBe(2)
          const written = yield* takeFromComputer(fixture.personId, name)
          // The title of the first page, as the server's own reader returned it to the program.
          expect(written).toContain('Example Domain')
          expect(written.trim().split('\n').length).toBe(2)
        }).pipe(Effect.scoped, Effect.provide(chainLayer)),
      { timeout: 300_000 },
    )
  },
)
