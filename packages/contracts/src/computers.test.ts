import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ActionTarget } from './approvals.js'
import { BrowseRequest, BrowseTarget } from './computers.js'

/** Older callers and persisted Approvals must retain their cloud target during rollout. */
it.effect(
  'decodes old browser requests and approvals as Vivid and refuses device identifiers',
  () =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(BrowseRequest)({
        action: { _tag: 'Read' },
        summary: 'Read',
      })
      const target = yield* Schema.decodeUnknownEffect(ActionTarget)({
        _tag: 'Browser',
        action: { _tag: 'Read' },
      })
      expect(request.target).toEqual(BrowseTarget.cases.Vivid.make({}))
      expect(ActionTarget.guards.Browser(target) && target.target).toEqual(request.target)
      const invalid = yield* Schema.decodeUnknownEffect(BrowseRequest)({
        action: { _tag: 'Read' },
        summary: 'Read',
        target: 'device-123',
      }).pipe(Effect.result)
      expect(invalid._tag).toBe('Failure')
    }),
)
