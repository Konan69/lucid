import {
  AuditEvent,
  MemorySource,
  MemoryRetraction,
  MemoryWrite,
  type CorrectMemoryRequest,
  type ForgetMemoryRequest,
  type MemoryAddress,
  type MemoryListing,
} from '@vivid/contracts'
import { Clock, Effect } from 'effect'
import { requireActor } from '../auth/access.ts'
import { Audit } from '../audit/record.ts'
import { CellMemory } from './client.ts'

export const memoryHandlers = {
  /** Personal memory follows the actor across workspaces. */
  GetMemoryIndex: Effect.fn('Rpc.GetMemoryIndex')(function* () {
    const actor = yield* requireActor()
    return yield* (yield* CellMemory).index(actor.person.id)
  }),
  /** Pagination is the cell's contract, independent of product Thread ownership. */
  ListMemory: Effect.fn('Rpc.ListMemory')(function* (input: MemoryListing) {
    const actor = yield* requireActor()
    return yield* (yield* CellMemory).list(actor.person.id, input)
  }),
  /** An address is always read inside the acting Person's cell. */
  ReadMemory: Effect.fn('Rpc.ReadMemory')(function* (input: MemoryAddress) {
    const actor = yield* requireActor()
    return yield* (yield* CellMemory).read(actor.person.id, input)
  }),
  /** Settings writes carry the Person's authority and compare the revision they saw. */
  CorrectMemory: Effect.fn('Rpc.CorrectMemory')(function* (input: CorrectMemoryRequest) {
    const actor = yield* requireActor()
    const at = yield* Clock.currentTimeMillis
    const saved = yield* (yield* CellMemory).write(
      actor.person.id,
      MemoryWrite.make({
        entry: input.entry,
        expected: input.expected,
        authority: { actor: actor.person.id, source: MemorySource.cases.Settings.make({ at }) },
      }),
    )
    yield* (yield* Audit).record(actor, AuditEvent.cases.MemorySaved.make({ scope: 'Person' }))
    return saved
  }),
  /** Audit a successful retraction only; a stale or missing entry changes nothing. */
  ForgetMemory: Effect.fn('Rpc.ForgetMemory')(function* (input: ForgetMemoryRequest) {
    const actor = yield* requireActor()
    const at = yield* Clock.currentTimeMillis
    yield* (yield* CellMemory).retract(
      actor.person.id,
      MemoryRetraction.make({
        address: input.address,
        expected: input.expected,
        authority: { actor: actor.person.id, source: MemorySource.cases.Settings.make({ at }) },
      }),
    )
    yield* (yield* Audit).record(actor, AuditEvent.cases.MemoryForgotten.make({ scope: 'Person' }))
  }),
}
