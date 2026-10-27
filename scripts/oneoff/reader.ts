import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  RuntimeHistoryBody,
  RuntimeHistoryAnswer,
  RuntimeHistoryMap,
  RuntimeHistoryResult,
} from '../../packages/contracts/src/index.ts'
import { sweep } from './sweep.ts'
import { readNotes } from './notes.ts'

/** Operator errors identify the operation, never a database URL, token, message or notes body. */
export class ReaderFailed extends Schema.TaggedError<ReaderFailed>()(
  'ReaderFailed',
  { operation: Schema.String },
  { title: 'History reader failed' },
) {}
export interface Inputs {
  readonly notes: string
  readonly cells: ReadonlyArray<URL>
  readonly token: string
  readonly map: string
}
const encodeMap = Schema.encodeEffect(Schema.fromJsonString(RuntimeHistoryMap))
const failed = (operation: string) => () => new ReaderFailed({ operation })

/** Only connection failure advances to another cell ingress. Refusals and bad responses remain failures. */
const post = Effect.fn('HistoryReader.post')(function* (input: {
  readonly cells: ReadonlyArray<URL>
  readonly person: string
  readonly token: string
  readonly body: RuntimeHistoryBody
}) {
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.schemaBodyJson(RuntimeHistoryBody)(
    HttpClientRequest.post(`/persons/${input.person}/history`),
    input.body,
  )
  const [first, ...rest] = input.cells
  if (first === undefined) return yield* new ReaderFailed({ operation: 'cells list empty' })
  const send = (node: URL) =>
    client.execute(
      HttpClientRequest.setUrl(
        HttpClientRequest.bearerToken(request, input.token),
        new URL(request.url, node),
      ),
    )
  let response = send(first)
  for (const node of rest)
    response = response.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'TransportError',
        () => send(node),
      ),
    )
  const received = yield* response.pipe(Effect.mapError(failed('cell transport')))
  if (received.status !== 200) return yield* new ReaderFailed({ operation: 'cell refused history' })
  return yield* HttpClientResponse.schemaBodyJson(RuntimeHistoryAnswer)(received).pipe(
    Effect.mapError(failed('cell response')),
  )
})

/** Adoption follows the durable map write, including partial maps from refused Threads. */
const adopt = (map: string) =>
  Effect.callback<void, ReaderFailed>((resume) => {
    const child = NodeChildProcess.spawn(
      'pnpm',
      ['--filter', '@vivid/server', 'runs:adopt', NodePath.resolve(map)],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    child.once('error', () => resume(Effect.fail(new ReaderFailed({ operation: 'runs:adopt' }))))
    child.once('close', (code) =>
      resume(code === 0 ? Effect.void : Effect.fail(new ReaderFailed({ operation: 'runs:adopt' }))),
    )
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
    })
  })

/** Read sources first, retain successful maps and adopt them before reporting refused Threads. */
export const readHistory = Effect.fn('HistoryReader.run')(function* (input: Inputs) {
  const people = yield* sweep()
  const notes = yield* readNotes(input.notes)
  for (const person of notes.keys()) if (!people.has(person)) people.set(person, [])
  const token = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(input.token, 'utf8'),
    catch: failed('token file'),
  })
  const map: Array<RuntimeHistoryMap[number]> = []
  const refused: string[] = []
  for (const [person, threads] of people) {
    const memory = notes.get(person)
    const answer = yield* post({
      cells: input.cells,
      person,
      token: token.trim(),
      body: RuntimeHistoryBody.make({ threads, notes: memory === undefined ? [] : memory }),
    })
    if (answer.threads.length !== threads.length)
      return yield* new ReaderFailed({ operation: 'cell omitted Thread results' })
    for (const result of answer.threads) {
      if (RuntimeHistoryResult.guards.Refused(result)) {
        refused.push(result.threadId)
        yield* Effect.logError('History refused', {
          personId: person,
          threadId: result.threadId,
          reason: result.reason,
        })
      } else map.push({ personId: person, ...result })
    }
  }
  const json = yield* encodeMap(map)
  const temporary = `${input.map}.tmp`
  yield* Effect.tryPromise({
    try: () =>
      NodeFSP.writeFile(temporary, json, { mode: 0o600 }).then(() =>
        NodeFSP.rename(temporary, input.map),
      ),
    catch: failed('map file'),
  })
  yield* adopt(input.map)
  if (refused.length > 0)
    return yield* new ReaderFailed({
      operation: `Threads refused after partial receipt adoption: ${refused.join(', ')}`,
    })
  return {
    people: people.size,
    threads: map.length,
    deliveries: map.reduce((count, thread) => count + thread.deliveries.length, 0),
  }
})
