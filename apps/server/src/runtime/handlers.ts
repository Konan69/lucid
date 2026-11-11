import {
  AuditEvent,
  ForgetMemoryRequest,
  MemoryAddress,
  MemoryCitation,
  MemoryExport,
  type MemoryLine,
  type MemoryPage,
  MemorySource,
  MemoryWrite,
  type CorrectMemoryRequest,
  type MemoryForgetId,
  type PlanMemoryForgetRequest,
  type MemoryListing,
} from '@vivid/contracts'
import { Clock, Effect } from 'effect'
import { requireActor, requirePerson } from '../auth/access.ts'
import { Audit } from '../audit/record.ts'
import { carryOut, forgetFromSettings, planForget } from '../forget/close.ts'
import { ForgetStore } from '../forget/store.ts'
import { live } from '../live/query.ts'
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
  /**
   * Every entry of the Person's memory, read whole, for their download. The cell's own pages are
   * walked to the end in its order (all layers), then each entry is read as Settings reads one, so
   * the file holds what the cell holds and nothing is summarised.
   */
  ExportMemory: Effect.fn('Rpc.ExportMemory')(function* () {
    const auth = yield* requirePerson()
    const cell = yield* CellMemory
    const exportedAt = yield* Clock.currentTimeMillis
    const lines: Array<MemoryLine> = []
    let after: MemoryListing['after'] = null
    do {
      const page: MemoryPage = yield* cell.list(auth.person.id, { layer: null, after, limit: 100 })
      lines.push(...page.entries)
      after = page.next
    } while (after !== null)
    const entries = yield* Effect.forEach(
      lines,
      (line) =>
        cell.read(auth.person.id, MemoryAddress.make({ layer: line.layer, file: line.file })),
      { concurrency: 4 },
    )
    return MemoryExport.make({ exportedAt, entries })
  }),
  /**
   * Settings writes carry the Person's authority and compare the revision they saw. A correction
   * keeps what the entry rested on and adds the Person's own say-so from Settings.
   */
  CorrectMemory: Effect.fn('Rpc.CorrectMemory')(function* (input: CorrectMemoryRequest) {
    const actor = yield* requireActor()
    const at = yield* Clock.currentTimeMillis
    const cell = yield* CellMemory
    const before = yield* cell.read(actor.person.id, MemoryAddress.make(input.entry))
    const source = MemorySource.cases.Settings.make({ at })
    const saved = yield* cell.write(
      actor.person.id,
      MemoryWrite.make({
        entry: input.entry,
        expected: input.expected,
        authority: { actor: actor.person.id, source },
        citations: [...before.citations, MemoryCitation.cases.Run.make({ source })],
      }),
    )
    yield* (yield* Audit).record(actor, AuditEvent.cases.MemorySaved.make({ scope: 'Person' }))
    return saved
  }),
  /** Vivid's plan for a forget, checked against the acting Person's memory and records. */
  PlanMemoryForget: Effect.fn('Rpc.PlanMemoryForget')(function* (input: PlanMemoryForgetRequest) {
    return yield* planForget(yield* requireActor(), input)
  }),
  /** A confirmed plan carried out, or a Settings press handed to Vivid; both answer a receipt. */
  ForgetMemory: Effect.fn('Rpc.ForgetMemory')(function* (input: ForgetMemoryRequest) {
    const actor = yield* requireActor()
    return yield* ForgetMemoryRequest.match(input, {
      Planned: () => carryOut(actor),
      Entry: ({ address, expected }) => forgetFromSettings(actor, address, expected),
    })
  }),
  /** One forget's receipt for the Person who asked, live until it settles. */
  WatchMemoryForget: ({ id }: { readonly id: MemoryForgetId }) =>
    live(
      'WatchMemoryForget',
      ['activity'],
      Effect.fn('Rpc.WatchMemoryForget.read')(function* (actor) {
        return yield* (yield* ForgetStore).receipt(actor.person.id, id)
      }),
    ),
}
