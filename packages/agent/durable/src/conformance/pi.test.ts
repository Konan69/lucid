import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { tool } from 'ai'
import { describe, expect, it as piIt } from 'vitest'
import { it } from '@effect/vitest'
import { Deferred, Effect, Option } from 'effect'
import { runForPi } from '../pi.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { z } from 'zod'

import { attachRun, followRun, streamRun } from '../main.ts'
import { context, host, modelText, texts } from './fixtures/host.ts'

/**
 * Pi: packages/durable/test/memory-storage.test.ts, registerStorageConformance.
 * Each generated test keeps its upstream name from src/testing/storage-conformance.ts.
 * Use the real SQLite adapter used by recovery.test.ts, with a fresh database per case.
 * No environment conformance: this package does not supply an ExecutionEnv.
 */
registerStorageConformance({ describe, expect, it: piIt }, 'Pi SQLite storage', (use) =>
  runForPi(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => openNodeSqliteStorage(':memory:'),
            catch: (cause) => new FixtureFailed({ cause }),
          }),
          (value) => Effect.promise(() => value.close(BACKGROUND_CONTEXT)),
        )
        yield* Effect.promise(() => use(storage))
      }),
    ),
    undefined,
  ),
)

// Pi packages/durable/test/harness-events.test.ts: streams a run as lifecycle events and text deltas that rebuild the answer.
it.live('watch before submit loses no event from an immediate response', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const { harness, root, faux } = yield* fixture.open()
    const text = 'A complete answer with its first and last character.'
    faux.setResponses([fauxAssistantMessage(text)])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          harness,
          { conversationId: root.id, content: 'Answer', requestId: 'instant' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.chunks.at(0)).toMatchObject({ type: 'start', messageId: result.message.id })
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(result.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
    expect(texts(result.message)).toEqual([text])
  }),
)

// Pi packages/durable/test/harness-inbox.test.ts: queues busy submissions and places writes before user items at the final boundary, one follow-up per run.
it.live('streams a busy follow-up as its own run', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const { harness, root, faux } = yield* fixture.open()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      fauxAssistantMessage('Second.'),
    ])
    const first = yield* Effect.promise(() =>
      streamRun(
        harness,
        { conversationId: root.id, content: 'First', requestId: 'first' },
        context,
      ),
    )
    yield* Deferred.await(entered)
    const second = streamRun(
      harness,
      { conversationId: root.id, content: 'Second', requestId: 'second' },
      context,
    )
    // submit() is asynchronous inside stream start; the model gate makes both admissions observable.
    yield* Deferred.succeed(release, undefined)
    const a = yield* consumeReadable(first, Option.none())
    const b = yield* consumeReadable(yield* Effect.promise(() => second), Option.none())
    expect(texts(a.message)).toEqual(['First.'])
    expect(texts(b.message)).toEqual(['Second.'])
    expect(b.message.id).not.toBe(a.message.id)
    expect(b.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
  }),
)

// Pi packages/durable/test/harness-inbox.test.ts: returns a queued submission for its repeated request ID without a second item.
it.live('joins repeated request ids while queued without a second model response', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const { harness, root, faux } = yield* fixture.open()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    let calls = 0
    faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      () => {
        calls++
        return fauxAssistantMessage('Once.')
      },
    ])
    const first = yield* Effect.promise(() =>
      streamRun(
        harness,
        { conversationId: root.id, content: 'First', requestId: 'first' },
        context,
      ),
    )
    yield* Deferred.await(entered)
    const input = { conversationId: root.id, content: 'Repeat', requestId: 'repeat' }
    const one = streamRun(harness, input, context)
    const two = streamRun(harness, input, context)
    yield* Deferred.succeed(release, undefined)
    yield* consumeReadable(first, Option.none())
    const a = yield* consumeReadable(yield* Effect.promise(() => one), Option.none())
    const b = yield* consumeReadable(yield* Effect.promise(() => two), Option.none())
    yield* Effect.promise(() => root.waitForIdle(context))
    expect(a.message).toEqual(b.message)
    expect(texts(a.message)).toEqual(['Once.'])
    expect(calls).toBe(1)
    expect(
      (yield* Effect.promise(() => root.context(context))).entries.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toHaveLength(2)
  }),
)

// Pi packages/durable/test/harness-generation.test.ts: retries a retryable error after a durable backoff and then answers.
it.live('retries a failed partial response without duplicate parts', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const { harness, root, faux } = yield* fixture.open()
    faux.setResponses([
      fauxAssistantMessage('Discard this partial.', {
        stopReason: 'error',
        errorMessage: '503 Service Unavailable',
      }),
      fauxAssistantMessage('Recovered.'),
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          harness,
          { conversationId: root.id, content: 'Try', requestId: 'retry' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(texts(result.message)).toEqual(['Recovered.'])
    expect(result.chunks.filter((chunk) => chunk.type === 'reset-step')).toHaveLength(1)
    expect(result.chunks.filter((chunk) => chunk.type === 'error')).toEqual([])
    expect(result.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
  }),
)

/** Kill only the child spawned here, after its execution signal proves the durable intent exists. */
const crash = Effect.fn('Test.crash')(function* (file: string, policy: 'safe' | 'unsafe') {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url)), file, policy],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      ),
    ),
    (spawned) =>
      Effect.promise(() => {
        if (spawned.exitCode !== null || spawned.signalCode !== null) return Promise.resolve()
        const exited = NodeEvents.EventEmitter.once(spawned, 'exit')
        spawned.kill('SIGKILL')
        return exited.then(() => {})
      }),
  )
  const [data] = yield* Effect.promise(() => NodeEvents.EventEmitter.once(child.stdout, 'data'))
  if (!Buffer.isBuffer(data))
    return yield* new FixtureFailed({ cause: new Error('Expected an execution signal') })
  expect(data.toString()).toContain('executing')
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  return yield* Effect.asVoid(Effect.promise(() => exited))
})

// Pi packages/durable/test/harness-tools-recovery.test.ts: answers an unsafe tool interrupted after intent with its durable partial output;
// reruns a tool only when both the stored and the current replay policy are safe.
it.live.each(['unsafe', 'safe'] as const)(
  'reports interrupted %s tools through the public stream',
  (policy) =>
    Effect.gen(function* () {
      let executions = 0
      let prompt = ''
      const fixture = yield* host(
        {
          work: tool({
            description: 'Build a report',
            inputSchema: z.object({}),
            execute: () => {
              executions++
              return Promise.resolve('12 pages')
            },
          }),
        },
        { replay: { work: policy } },
      )
      yield* crash(fixture.file, policy)
      const { harness, root, faux } = yield* fixture.open()
      faux.setResponses([
        (request) => {
          prompt = modelText(request.messages)
          return fauxAssistantMessage('Finished.')
        },
      ])
      const attachedRun = yield* Effect.promise(() => attachRun(harness, root.id, context))
      if (attachedRun.status === 'idle')
        return yield* new FixtureFailed({ cause: new Error('Expected the interrupted run') })
      harness.resume()
      const result = yield* consumeReadable(attachedRun.stream, Option.none())
      const part = result.message.parts.find((candidate) => candidate.type === 'tool-work')
      if (policy === 'safe') {
        expect(executions).toBe(1)
        expect(part).toMatchObject({ state: 'output-available', output: '12 pages' })
        expect(prompt).toContain('12 pages')
      } else {
        expect(executions).toBe(0)
        expect(part).toMatchObject({
          state: 'output-error',
          errorText: expect.stringContaining('was interrupted and may have partially run'),
        })
        expect(prompt).toContain('was interrupted and may have partially run')
      }
      expect(texts(result.message)).toEqual(['Finished.'])
      return undefined
    }),
)

/** A real process dies after durable tool intent; request-only recovery replays the same run. */
it.live('follows a host request after process restart and harness.resume', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      { work: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('recovered') }) },
      { replay: { work: 'safe' } },
    )
    yield* crash(fixture.file, 'safe')
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Recovered host run.')])
    const stream = yield* Effect.promise(() =>
      followRun(opened.harness, opened.root.id, 'crash', context),
    )
    opened.harness.resume()
    const result = yield* consumeReadable(stream, Option.none())
    expect(texts(result.message)).toEqual(['Recovered host run.'])
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-work',
        state: 'output-available',
        output: 'recovered',
      }),
    )
  }),
)
