import { defineTool } from './tool.ts'
import {
  ForgetChange,
  ForgetMemoryRequest,
  ForgetRemaining,
  MemoryAddress,
  MemoryEntry,
  MemoryFile,
  MemoryForgetReceipt,
  MemoryLayer,
  MemoryRevision,
  OwedState,
  PlanMemoryForgetRequest,
  StandingLayer,
  Tool,
  WatchState,
} from '@vivid/contracts'
import { Array as Arr, Effect, Result, Schema } from 'effect'
import { InvalidRequest } from '@vivid/contracts/rpc'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { named } from './names.ts'
import { modelText } from './views.ts'
import { Scope, type RunTool } from './scope.ts'

const entryInput = v.object({
  layer: v.optional(v.picklist(MemoryLayer.literals), 'memory'),
  file: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u)),
  expected_revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rewrite: v.optional(
    v.object({
      description: text('The entry’s one line, without the forgotten thing.', 200),
      body: text(
        'The whole page again, with every other fact kept and the forgotten one gone.',
        100_000,
      ),
    }),
  ),
})

/**
 * One entry of the plan. A standing page holds other facts, so it is rewritten without the
 * forgotten one; its kind, basis and scope stay as the page has them.
 */
const changeFor = Effect.fn('ForgetTools.change')(function* (
  input: v.InferOutput<typeof entryInput>,
) {
  const address = MemoryAddress.make({ layer: input.layer, file: MemoryFile.make(input.file) })
  const expected = MemoryRevision.make(input.expected_revision)
  const rewrite = input.rewrite
  if (rewrite === undefined) return ForgetChange.cases.Retract.make({ address, expected })
  const { client } = yield* Scope
  const current = yield* client.ReadMemory(address)
  return ForgetChange.cases.Rewrite.make({
    entry: MemoryEntry.make({
      layer: current.layer,
      file: current.file,
      kind: current.kind,
      basis: current.basis,
      scope: current.scope,
      description: rewrite.description,
      body: rewrite.body,
    }),
    expected,
  })
})

/** Live Watches and open owed records by the names the model was shown; ambiguity stops the plan. */
const dependents = Effect.fn('ForgetTools.dependents')(function* (
  watches: ReadonlyArray<string>,
  owed: ReadonlyArray<string>,
) {
  const { client } = yield* Scope
  const live = (yield* client.ListWatches()).watches.filter(
    (watch) => !WatchState.guards.Stopped(watch.state),
  )
  const open = (yield* client.ListOwed()).owed.filter((record) =>
    OwedState.isAnyOf(['Open', 'Nudged'])(record.state),
  )
  const watchIds = yield* Effect.forEach(watches, (name) =>
    Result.match(
      named(
        live.map((item) => ({ name: item.name, item })),
        name,
      ),
      { onFailure: Effect.fail, onSuccess: (watch) => Effect.succeed(watch.id) },
    ),
  )
  const owedIds = yield* Effect.forEach(owed, (what) =>
    Result.match(
      named(
        open.map((item) => ({ name: item.what, item })),
        what,
      ),
      { onFailure: Effect.fail, onSuccess: (record) => Effect.succeed(record.id) },
    ),
  )
  return { watches: watchIds, owed: owedIds }
})

/** What a receipt says to the model: where the forget stands and counts, never ids or the fact. */
const receiptView = (receipt: MemoryForgetReceipt) =>
  MemoryForgetReceipt.match<{ readonly [key: string]: Schema.Json }>(receipt, {
    Pending: () => ({ state: 'pending' }),
    Completed: ({ done }) => ({ state: 'completed', done }),
    Blocked: ({ done, remaining }) => ({
      state: 'blocked',
      done,
      remaining: remaining.map((item) =>
        ForgetRemaining.match(item, {
          Entry: ({ address }) => `memory ${address.layer}/${address.file} still holds it`,
          Watch: () => 'a Watch could not be stopped',
          Owed: () => 'something they are waiting on could not be dropped',
          SharedLearning: () => 'learning in a shared conversation is in someone else’s keeping',
          Reply: () => 'another conversation was already answering with the old memory',
          Unplanned: () => 'the forget was never carried out',
        }),
      ),
    }),
  })

/**
 * Forgetting across Vivid, the way the forget-something skill describes it: plan by meaning, show
 * the plan, carry it out after one clear yes. The model names entries, Watches and owed records
 * by what it was shown; the host resolves them, and the server stops, retracts and reads back.
 */
export function forgetTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.plan_forget,
      description: `Plan forgetting something the Person asked you to forget. Change nothing yet. Name every memory entry that says it, at the revision you read: retract an ordinary entry; for a standing page (${StandingLayer.literals.join(', ')}) give rewrite with the whole page minus that fact. Name, exactly as list_watches and the waiting-on list show them, every Watch whose instruction uses it and every open waiting-on record about it. Queued learning is stopped for you. Then tell the Person what will go and what will stay, and ask once before forget_memory.`,
      input: v.object({
        summary,
        entries: v.pipe(v.array(entryInput), v.minLength(1)),
        watches: v.optional(v.array(text('Exact Watch name.', 80)), []),
        owed: v.optional(v.array(text('Exact waiting-on record, as listed.', 300)), []),
      }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const changes = yield* Effect.forEach(data.entries, changeFor)
            if (!Arr.isReadonlyArrayNonEmpty(changes))
              return yield* new InvalidRequest({ message: 'Name at least one memory entry.' })
            const found = yield* dependents(data.watches, data.owed)
            const plan = yield* client.PlanMemoryForget(
              PlanMemoryForgetRequest.make({ changes, ...found }),
            )
            return {
              output: {
                ok: true,
                retract: plan.changes.filter(ForgetChange.guards.Retract).length,
                rewrite: plan.changes.filter(ForgetChange.guards.Rewrite).length,
                watches: data.watches.map(modelText),
                waiting_on: data.owed.map(modelText),
                shared_conversations: plan.shared.length,
                next: 'Say what will be forgotten and what stays, then ask once. Call forget_memory only after a clear yes.',
              },
            }
          }),
          { signal, tool: 'plan_forget' },
        )
      },
    }),
    defineTool({
      name: Tool.forget_memory,
      description:
        'Carry out the plan you made with plan_forget in this conversation, after the Person confirmed it. Stops its Watches and waiting-on records and queued learning, retracts and rewrites its entries, reads everything back and answers completed or blocked with what remains. Say it is forgotten only when this answers completed.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const receipt = yield* client.ForgetMemory(ForgetMemoryRequest.cases.Planned.make({}))
            return { output: receiptView(receipt) }
          }),
          { signal, tool: 'forget_memory' },
        )
      },
    }),
  ] as const
}
