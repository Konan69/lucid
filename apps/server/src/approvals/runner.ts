import { Audit } from '../audit/record.ts'
import { ActionLookup } from '../actions/journal.ts'
import { Context } from 'effect'
import { IntegrationAnswers } from '../connections/answers.ts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ActionTarget } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { BrowseAuthority, DeviceRegistry } from '../computers/device.ts'
import { ComputerStore, computerRunner, inspectBrowser } from '../computers/store.ts'
import { Executor } from '../connections/executor.ts'
import { ExecutorMembers } from '../connections/members.ts'
import { ToolEffects } from '../connections/effects.ts'
import { ConnectionStore } from '../connections/store.ts'
import { connectionRunner } from '../connections/tools.ts'
import { inspectMail } from '../connections/mail.ts'
import { ActionRunner } from './gate.ts'
import { Watches } from '../watches/lifecycle.ts'

/**
 * Performs an approved action by handing it to the domain that owns its target.
 *
 * The trust loop decides and records; it does not know how to send an email or press a key.
 * Connections own `Connection` targets and the Computer owns `Browser` and `Desktop`. Each of them
 * re-checks, at the moment of running, that the Person may still do it: an Approval given an hour
 * ago does not outlive a removed Connection or a lost Membership.
 */
export const actionRunnerLayer = Layer.effect(
  ActionRunner,
  Effect.gen(function* () {
    const services = Context.omit(IntegrationAnswers)(
      yield* Effect.context<
        | ActionLookup
        | Audit
        | Database
        | ConnectionStore
        | Executor
        | ExecutorMembers
        | ComputerStore
        | ToolEffects
        | DeviceRegistry
        | Watches
      >(),
    )
    const connections = yield* ConnectionStore
    return ActionRunner.of({
      inspect: (input) =>
        Effect.gen(function* () {
          if (input.action.effect === 'read') return []
          const target = input.action.target
          if (ActionTarget.guards.Browser(target))
            return yield* inspectBrowser({
              person: input.person,
              origin: input.origin,
              target,
              authority:
                input.phase === 'Deciding'
                  ? BrowseAuthority.cases.Approved.make({})
                  : BrowseAuthority.cases.Acting.make({}),
            })
          if (!ActionTarget.guards.Connection(target)) return []
          const actor = {
            person: input.person,
            workspace: input.workspace,
            by: 'vivid' as const,
            threadId: Option.some(input.origin.threadId),
            helper: Option.none(),
          }
          const row = yield* connections.get(actor, target.connectionId)
          return yield* inspectMail(row, target)
        }).pipe(Effect.provideContext(services)),
      run: ({ person, workspace, action, origin, operation }) => {
        const target = action.target
        return ActionTarget.guards.Connection(target)
          ? Effect.provideContext(
              connectionRunner({ person, workspace, target, operation }),
              services,
            )
          : Effect.provideContext(computerRunner({ person, target, origin }), services)
      },
    })
  }),
)
