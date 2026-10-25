import { Duration } from 'effect'
import * as NodeFS from 'node:fs'
import * as NodeInspectorPromises from 'node:inspector/promises'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from '@effect/vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import {
  ConversationFrame,
  type ConversationState,
  PersonId,
  RuntimeSettlement,
} from '@vivid/contracts'
import { Deferred, Effect, Option, Schema } from 'effect'
import { databaseConfigured } from '../../tests/database.ts'
import { start, world } from '../../tests/process.ts'
import { admit, delivery, IDLE, settled, threadPath } from '../../tests/requests.ts'
import { query } from '../../tests/stores.ts'
import { make as makeNotes, NotesSettings } from '../notes.ts'
import { POOL } from './stores.ts'

/** How many Persons stream a reply at once, and for about how long each reply streams. */
const PERSONS = 50
const TOKENS_PER_SECOND = 200
/** 1,000 tokens at 200 a second (the scripted provider counts four characters a token): ~5 s. */
const REPLY = 'word '.repeat(800)

/** Every commit every store has made: each store's next sequence is one past its last commit. */
const commits = (database: string) =>
  query(
    database,
    'SELECT coalesce(sum(next_seq - 1), 0)::text AS total FROM runtime.metadata',
  ).pipe(Effect.map((rows) => Number(rows[0] === undefined ? 0 : rows[0]['total'])))

const DATA = 'data: '
const decodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(ConversationFrame)),
)

/** A state link as the fixture hands it over (`tests/process.ts`, `link`). */
type Link = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof start>>['link']>>

/** The next frame of a link, past the keep-alive comments; a link that ends fails the case. */
const nextFrame = Effect.fn('Throughput.nextFrame')(function* (link: Link) {
  for (;;) {
    const event = yield* link.event
    if (Option.isNone(event)) return yield* Effect.die(new Error('A state link ended early'))
    if (event.value.startsWith(DATA)) return yield* decodeFrame(event.value.slice(DATA.length))
  }
})

/** A frame applied to the state a screen holds, with the library that made the changes. */
const applied = (state: ConversationState, frame: ConversationFrame): ConversationState =>
  ConversationFrame.match(frame, {
    Whole: (whole) => whole.state,
    Changes: ({ ops }) =>
      applyImmutable(
        state,
        ops.filter((op): op is Op => Array.isArray(op)),
      ),
  })

/** The reader has the whole reply: no run is answering and an assistant message says `REPLY`. */
const complete = (state: ConversationState) =>
  !state.working &&
  state.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') === REPLY,
  )

/**
 * A measurement, reported and asserted only for being whole: 50 Persons, each with a store of
 * their own, stream a reply at once through the real runtime (admission, Harness, the shared
 * store) with Pi's default partial interval of 100 ms, while a reader follows each Thread's state
 * link (`state/link.ts`) as a screen would.
 *
 * Phases: first every Person is opened (cold open: store, Harness, notes) and every reader has
 * taken its opening frame; then the clock starts, every delivery is admitted and waited for, every
 * Person's follow-up writes finish (`quiet`), and the clock and the commit count stop once every
 * reader holds the whole reply. Every reply must be Done with the whole text, and every reader's
 * final state must show it; one that failed or stopped fails the measurement. Reported: commits
 * a second, state frames a second per reader, and the share of one core this process used. It
 * includes the
 * scripted provider and the HTTP fixture running in the same process; it says the process was
 * busy, not where. It runs only when asked (`VIVID_MEASURE_STORES=1`), on the gate's disposable
 * database, and writes `.cache/port/throughput.json` in the repository.
 */
describe.skipIf(!databaseConfigured || NodeProcess.env.VIVID_MEASURE_STORES !== '1')(
  'commits and state frames a second with many stores streaming',
  () => {
    it.live(
      'measures 50 stores streaming partial replies at once, each with a reader',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const given = yield* world({ tokensPerSecond: TOKENS_PER_SECOND })
            given.faux.setResponses(
              Array.from({ length: PERSONS }, () => fauxAssistantMessage(REPLY)),
            )
            const runtime = yield* start(given, { idleMillis: IDLE })
            const persons = Array.from({ length: PERSONS }, (_, index) =>
              PersonId.make(`person-${String(index).padStart(3, '0')}`),
            )
            const opening = performance.now()
            yield* Effect.forEach(
              persons,
              (person) => runtime.persons.use(person, () => Effect.void),
              {
                concurrency: 'unbounded',
                discard: true,
              },
            )

            // Each Person's notes are opened too, as the first response would otherwise do inside the
            // timed phase (`context.ts` reads the note index before admission).
            const notes = yield* makeNotes(
              NotesSettings.make({
                directory: given.notes,
                capacity: 64,
                idle: Duration.minutes(1),
              }),
            )
            yield* Effect.forEach(persons, (person) => notes.index(person), {
              concurrency: 'unbounded',
              discard: true,
            })
            const coldOpenSeconds = (performance.now() - opening) / 1000

            // One reader per Thread. Its opening frame (the whole, empty state) is taken before
            // anything is counted; then it applies every frame as a screen does, counts it, and
            // finishes when its state holds the whole reply and is no longer working. Forked into
            // the case's scope: a child of the per-Person effect would end with it.
            const readers = yield* Effect.forEach(
              persons,
              (person) =>
                Effect.gen(function* () {
                  const link = yield* runtime.link(`${threadPath(person, 'thread-1')}/state`)
                  const opened = yield* nextFrame(link)
                  if (!ConversationFrame.guards.Whole(opened))
                    return yield* Effect.die(new Error('A state link opens with the whole state'))
                  const count = { frames: 0 }
                  const finished = yield* Deferred.make<ConversationState>()
                  yield* Effect.forkScoped(
                    Effect.gen(function* () {
                      let state = opened.state
                      while (!complete(state)) {
                        state = applied(state, yield* nextFrame(link))
                        count.frames += 1
                      }
                      yield* Deferred.succeed(finished, state)
                    }),
                  )
                  return { link, count, finished }
                }),
              { concurrency: 'unbounded' },
            )
            expect(readers).toHaveLength(PERSONS)

            // `VIVID_MEASURE_PROFILE=1` also records a CPU profile of this worker for the timed
            // phase (`.cache/port/throughput.cpuprofile`), to say where the time goes.
            const profiling = NodeProcess.env.VIVID_MEASURE_PROFILE === '1'
            const inspector = new NodeInspectorPromises.Session()
            if (profiling) {
              inspector.connect()
              yield* Effect.promise(() => inspector.post('Profiler.enable'))
              yield* Effect.promise(() => inspector.post('Profiler.start'))
            }
            const before = yield* commits(given.database)
            const began = performance.now()
            const cpu = NodeProcess.cpuUsage()
            const results = yield* Effect.forEach(
              persons,
              (person) =>
                Effect.gen(function* () {
                  const receipt = yield* admit(
                    runtime,
                    person,
                    delivery('thread-1', 'key-1', { creator: person }),
                  )
                  return yield* settled(runtime, person, 'thread-1', receipt.submissionId)
                }),
              { concurrency: 'unbounded' },
            )
            yield* Effect.forEach(
              persons,
              (person) => runtime.persons.use(person, (open) => open.quiet),
              {
                concurrency: 'unbounded',
                discard: true,
              },
            )
            // Every reader has the whole reply before the clock stops.
            const finals = yield* Effect.forEach(readers, (reader) =>
              Deferred.await(reader.finished),
            )
            const seconds = (performance.now() - began) / 1000
            const used = NodeProcess.cpuUsage(cpu)
            const profile = profiling
              ? Option.some(yield* Effect.promise(() => inspector.post('Profiler.stop')))
              : Option.none()
            const total = (yield* commits(given.database)) - before
            const frames = readers.map((reader) => reader.count.frames)
            yield* Effect.forEach(readers, (reader) => reader.link.leave, { discard: true })
            expect(finals.filter(complete)).toHaveLength(PERSONS)

            const done = results.filter(
              (result) => RuntimeSettlement.guards.Done(result) && result.reply === REPLY,
            ).length
            const result = {
              persons: PERSONS,
              partialIntervalMs: 100,
              tokensPerSecond: TOKENS_PER_SECOND,
              replyCharacters: REPLY.length,
              pool: POOL,
              coldOpenSeconds: Number(coldOpenSeconds.toFixed(2)),
              done,
              failed: PERSONS - done,
              commits: total,
              seconds: Number(seconds.toFixed(2)),
              commitsPerSecond: Number((total / seconds).toFixed(1)),
              framesPerReaderPerSecond: {
                min: Number((Math.min(...frames) / seconds).toFixed(2)),
                mean: Number(
                  (frames.reduce((sum, value) => sum + value, 0) / frames.length / seconds).toFixed(
                    2,
                  ),
                ),
                max: Number((Math.max(...frames) / seconds).toFixed(2)),
              },
              processCpu: Number(((used.user + used.system) / 1e6 / seconds).toFixed(2)),
            }
            const directory = NodePath.resolve(import.meta.dirname, '../../../../../.cache/port')
            NodeFS.mkdirSync(directory, { recursive: true })
            NodeFS.writeFileSync(
              NodePath.join(directory, 'throughput.json'),
              `${JSON.stringify(result, undefined, 2)}\n`,
            )
            if (Option.isSome(profile)) {
              NodeFS.writeFileSync(
                NodePath.join(directory, 'throughput.cpuprofile'),
                JSON.stringify(profile.value.profile),
              )
              inspector.disconnect()
            }
            NodeProcess.stdout.write(`store throughput ${JSON.stringify(result)}\n`)
            expect(result.failed).toBe(0)
            expect(frames.every((count) => count > 0)).toBe(true)
          }),
        ),
      180_000,
    )
  },
)
