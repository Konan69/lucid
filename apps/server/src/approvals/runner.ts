import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ActionTarget } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { ComputerStore, computerRunner } from '../computers/store.ts'
import { Executor } from '../connections/executor.ts'
import { ToolEffects } from '../connections/effects.ts'
import { ConnectionStore } from '../connections/store.ts'
import { connectionRunner } from '../connections/tools.ts'
import { ActionRunner } from './gate.ts'

/**
 * Performs an approved action by handing it to the domain that owns its target.
 *
 * The trust loop decides and records; it does not know how to send an email or run a command.
 * Connections own `Connection` targets and the Computer owns `Command` and `Browser`. Each of them
 * re-checks, at the moment of running, that the Person may still do it: an Approval given an hour
 * ago does not outlive a removed Connection or a lost Membership.
 */
export const actionRunnerLayer = Layer.effect(
  ActionRunner,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Database | ConnectionStore | Executor | ComputerStore | ToolEffects
    >()
    return ActionRunner.of({
      run: ({ person, workspace, action }) => {
        const target = action.target
        return ActionTarget.guards.Connection(target)
          ? Effect.provideContext(connectionRunner({ person, workspace, target }), services)
          : Effect.provideContext(computerRunner({ person, target }), services)
      },
    })
  }),
)
