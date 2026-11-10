import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ActionOperationId } from '@vivid/contracts'
import { checking, type makeLive } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { tick } from './haptics'
import { useLiveData, type LiveData } from './live'

/**
 * Checking whether an action Vivid never heard back about went through (`@vivid/state`
 * `checking`), one for the session, as the web has one for the page (`apps/web/src/data/checking.ts`).
 * `ReconcileAction` looks it up at the Integration, read-only; the answer is said on the line under
 * that Run until the next press.
 */
export const makeChecking = (engine: ReturnType<typeof makeLive>) => {
  const checker = checking.make(
    Layer.succeed(checking.Checker, {
      check: Effect.fn('Action.check')(function* (asked: checking.Check) {
        const result = yield* engine.run(
          VividRpcClient.use((client) =>
            client.ReconcileAction({ operationId: asked.operationId }),
          ),
        )
        return yield* Result.isSuccess(result)
          ? Effect.succeed(checking.findingOf(result.success.reconciliation))
          : Effect.fail(new checking.Unreached({ check: asked }))
      }),
    }),
  )
  // The answer outlives the Thread being left and opened again.
  engine.registry.mount(checker.reading)
  return checker
}

/** Where checking stands, for every Thread. */
export const useChecking = () => useAtomValue(useLiveData().checking.reading)

/** The Person pressed Check. A press while a check is on its way is not taken. */
export const checkAction = (data: LiveData, operationId: ActionOperationId) => {
  tick()
  data.registry.set(
    data.checking.send,
    data.checking.check({ attempt: checking.AttemptId.make(randomUUID()), operationId }),
  )
}
