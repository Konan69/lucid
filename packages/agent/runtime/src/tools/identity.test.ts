import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ThreadId } from '@vivid/contracts'
import { operationId } from './identity.ts'

it.effect(
  'reuses the same operation id on replay while separating Threads, calls and purposes',
  () =>
    Effect.sync(() => {
      const original = operationId(ThreadId.make('thread-1'), 'call-1', 'task')
      expect(operationId(ThreadId.make('thread-1'), 'call-1', 'task')).toBe(original)
      expect(original).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u)
      expect(
        new Set([
          original,
          operationId(ThreadId.make('thread-2'), 'call-1', 'task'),
          operationId(ThreadId.make('thread-1'), 'call-2', 'task'),
          operationId(ThreadId.make('thread-1'), 'call-1', 'follow-up'),
        ]).size,
      ).toBe(4)
    }),
)
