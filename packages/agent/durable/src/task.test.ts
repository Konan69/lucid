import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  LiveDoc,
  ToolTask,
  type TaskId,
  type ToolSlot,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Option, Schema } from 'effect'
import * as Pi from './pi.ts'

const context = BACKGROUND_CONTEXT
const Identity = Schema.Struct({
  taskId: Schema.Number,
  slotTaskId: Schema.Number,
  status: Schema.Literal('pending'),
})
const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))

/** Observe the hook's pending slot, kill that exact child, and verify the recovered hook has the same task. */
it.live(
  'keeps the pending slot task id equal to the hook id across SIGKILL recovery',
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-task-'))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      )
      const file = NodePath.join(directory, 'session.sqlite')
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(
            process.execPath,
            [NodeURL.fileURLToPath(new URL('./fixtures/task.ts', import.meta.url)), file],
            { stdio: ['ignore', 'pipe', 'inherit'] },
          ),
        ),
        (spawned) =>
          Effect.sync(() => {
            spawned.kill('SIGKILL')
          }),
      )
      const receipt = yield* Effect.callback<string, Error>((resume) => {
        const received = (line: Buffer) => resume(Effect.succeed(line.toString()))
        const failed = (error: Error) => resume(Effect.fail(error))
        child.stdout.once('data', received)
        child.once('error', failed)
        return Effect.sync(() => {
          child.stdout.removeListener('data', received)
          child.removeListener('error', failed)
        })
      })
      const before = yield* decodeIdentity(receipt)
      expect(before.taskId).toBe(before.slotTaskId)
      const exited = NodeEvents.EventEmitter.once(child, 'exit')
      child.kill('SIGKILL')
      yield* Effect.promise(() => exited)

      const recovered = yield* Deferred.make<{ taskId: TaskId; slot: Option.Option<ToolSlot> }>()
      const registry = createRegistry()
      registry.install(
        defineExtension({
          name: 'identity',
          tools: [
            defineTool({
              name: 'work',
              description: 'Observe the pending task',
              parameters: Type.Object({}),
              execute: (_args, _api, callbackContext) =>
                Pi.runForPi(Effect.never, callbackContext.abortSignal),
            }),
          ],
          hooks: [
            hook(ToolTask, {
              beforeTool: (_call, api, callbackContext) =>
                Pi.runForPi(
                  Effect.gen(function* () {
                    const live = Option.getOrThrow(
                      yield* Pi.snapshot(api, LiveDoc, api.conversationId, callbackContext),
                    )
                    yield* Deferred.succeed(recovered, {
                      taskId: api.taskId,
                      slot: Option.fromNullishOr(
                        (live.tools ?? []).find((candidate) => candidate.taskId === api.taskId),
                      ),
                    })
                    return yield* Effect.never
                  }),
                  callbackContext.abortSignal,
                ),
            }),
          ],
        }),
      )
      const storage = yield* Effect.promise(() => openNodeSqliteStorage(file))
      const harness = yield* Effect.acquireRelease(
        Effect.promise(() => Harness.open(storage, { registry, models: createModels() }, context)),
        (opened) => Effect.promise(() => opened.close(context)),
      )
      harness.resume()
      const after = yield* Deferred.await(recovered)
      expect(Option.getOrThrow(after.slot)).toMatchObject({
        status: 'pending',
        taskId: before.taskId,
      })
      expect(after.taskId).toBe(before.taskId)
    }),
  30_000,
)
