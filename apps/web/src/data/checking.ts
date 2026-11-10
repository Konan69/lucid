import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ActionOperationId } from '@vivid/contracts'
import { checking } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { running } from './app'
import { engine } from './runtime'

/**
 * Checking whether an action Vivid never heard back about went through, one for the page
 * (`@vivid/state` `checking`). `ReconcileAction` looks it up at the Integration, read-only; the
 * answer is said on the line under that Run until the next press.
 */
const checker = checking.make(
  Layer.succeed(checking.Checker, {
    check: Effect.fn('Action.check')(function* (asked: checking.Check) {
      const result = yield* running(
        VividRpcClient.use((client) => client.ReconcileAction({ operationId: asked.operationId })),
      )
      return yield* Result.isSuccess(result)
        ? Effect.succeed(checking.findingOf(result.success.reconciliation))
        : Effect.fail(new checking.Unreached({ check: asked }))
    }),
  }),
)

// The answer outlives the Thread being left and opened again.
engine.registry.mount(checker.reading)

/** Where checking stands, for every Thread. */
export const useChecking = () => useAtomValue(checker.reading)

/** The Person pressed Check. A press while a check is on its way is not taken. */
export const checkAction = (operationId: ActionOperationId) =>
  engine.registry.set(
    checker.send,
    checker.check({ attempt: checking.AttemptId.make(crypto.randomUUID()), operationId }),
  )
