import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ActionTarget } from './approvals.js'
import { BrowserAction, BrowseTarget } from './computers.js'

const LegacyBrowser = Schema.TaggedStruct('Browser', { action: BrowserAction })
const decodeTarget = Schema.decodeUnknownEffect(ActionTarget)

/** Approvals stored before a browser action named its target must keep acting on Vivid's Computer. */
it.effect('decodes a stored browser Approval without a target as Vivid’s Computer', () =>
  Effect.gen(function* () {
    const target = yield* decodeTarget(
      LegacyBrowser.make({ action: BrowserAction.cases.Read.make({}) }),
    )
    expect(ActionTarget.guards.Browser(target) && target.target).toEqual(
      BrowseTarget.cases.Vivid.make({}),
    )
  }),
)
