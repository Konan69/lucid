import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ActionTarget } from './approvals.js'
import { BrowserAction, BrowseRequest, BrowseTarget } from './computers.js'

const LegacyBrowser = Schema.TaggedStruct('Browser', { action: BrowserAction })
const decodeRequest = Schema.decodeUnknownEffect(BrowseRequest)
const decodeTarget = Schema.decodeUnknownEffect(ActionTarget)

/** Older callers and persisted Approvals must retain their cloud target during rollout. */
it.effect(
  'decodes old browser requests and approvals as Vivid and refuses device identifiers',
  () =>
    Effect.gen(function* () {
      const request = yield* decodeRequest({
        action: BrowserAction.cases.Read.make({}),
        summary: 'Read',
      })
      const target = yield* decodeTarget(
        LegacyBrowser.make({ action: BrowserAction.cases.Read.make({}) }),
      )
      expect(request.target).toEqual(BrowseTarget.cases.Vivid.make({}))
      expect(ActionTarget.guards.Browser(target) && target.target).toEqual(request.target)
      const invalid = yield* decodeRequest({
        action: BrowserAction.cases.Read.make({}),
        summary: 'Read',
        target: 'device-123',
      }).pipe(Effect.result)
      expect(invalid._tag).toBe('Failure')
    }),
)
