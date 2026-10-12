import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { Config, Effect, Function, Layer, Option, Ref, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { Database } from '../../database/client.ts'
import { boatMachineLayer } from '../boat.ts'
import { bindings } from '../boat/bindings.ts'
import { ProviderId } from '../boat/protocol.ts'
import { transport, type Transport } from '../boat/transport.ts'
import { Machine, type MachineKey } from '../machine.ts'
import { machineBindings } from '../tables.ts'

/** Test-only resource authority comes from this proof's unique create intent, never a date or an adopted id. */
const Ownership = Schema.TaggedUnion({
  Unstarted: {},
  Creating: {},
  Owned: { id: ProviderId },
})

/** Reject both adoption settings before signup, guest commands, SSH authorization or StartComputer. */
export const proofProvider = Effect.fn('ComputerProof.provider')(function* () {
  const api = yield* transport()
  expect(Option.isNone(api.adopt), 'Computer proofs refuse VIVID_BOAT_MACHINE adoption').toBe(true)
  const legacy = yield* Config.option(Config.String('VIVID_LIVE_COMPUTER_MACHINE'))
  expect(
    Option.isNone(legacy),
    'SSH proofs create their own machine; remove the adoption target',
  ).toBe(true)
  return api
})

/**
 * Delete only the captured create receipt, then this fixture's binding. Other scoped Person or
 * database teardown may remove SQL even after this finalizer fails, so the failure must identify
 * the provider resource and unique create intent independently of surviving database rows.
 */
const deletion = Effect.fn('ComputerProof.deletion')(function* (key: MachineKey) {
  const client = yield* HttpClient.HttpClient
  const secret = yield* Config.Redacted('VIVID_BOAT_API_KEY')
  const org = yield* Config.option(Config.NonEmptyString('VIVID_BOAT_ORG'))
  const database = yield* Database
  const billed = Option.match(org, {
    onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
    onSome: (name) => HttpClientRequest.setHeader('X-Boat-Org', name),
  })
  return Effect.fn('ComputerProof.delete')(function* (id: ProviderId, intent: string) {
    const response = yield* client.execute(
      HttpClientRequest.delete(`https://boat.dev/api/v1/sandboxes/${id}`).pipe(
        HttpClientRequest.bearerToken(secret),
        HttpClientRequest.setHeader('X-Ascii-Confirm-Delete', id),
        HttpClientRequest.setHeader('Connection', 'close'),
        billed,
      ),
    )
    expect(
      response.status >= 200 && response.status < 300,
      `Delete proof-owned Boat machine ${id}; create intent ${intent}`,
    ).toBe(true)
    // This finalizer removes SQL authority only after Boat acknowledges deletion of its owned resource.
    yield* database.run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
  })
})

/** A provider acknowledgement supplies the only machine id this proof may delete. */
const acknowledged = (receipt: Effect.Success<ReturnType<Transport['createMachine']>>) =>
  Option.some(receipt.sandbox.id)

/** Report the owned resource and immutable intent before older fixture finalizers remove SQL state. */
const cleanupFailed = Effect.fn('ComputerProof.cleanupFailed')(function* (
  ownership: Ref.Ref<typeof Ownership.Type>,
  intent: string,
) {
  const state = yield* Ref.get(ownership)
  const resource = Ownership.match(state, {
    Unstarted: () => 'unstarted resource',
    Creating: () => 'unacknowledged resource',
    Owned: ({ id }) => `machine ${id}`,
  })
  return expect.fail(
    `Computer proof cleanup failed for ${resource}; reconcile create intent ${intent}`,
  )
})

/**
 * Register provider cleanup before the first create or binding write. An interrupted/lost create
 * receipt is reconciled once through the same unique idempotency key and immutable body, never
 * through a machine inventory or configured target. The uninterruptible capture closes the gap
 * between receiving a successful creation and registering its id. Failed reconciliation/deletion
 * fails the proof visibly with id/intent, even if later isolated Person/database teardown removes SQL.
 */
const ownedMachine = Effect.fn('ComputerProof.ownedMachine')(function* (
  api: Transport,
  key: MachineKey,
) {
  const intent = NodeCrypto.randomUUID()
  const ownership = yield* Ref.make<typeof Ownership.Type>(Ownership.cases.Unstarted.make({}))
  const remove = yield* deletion(key)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const state = yield* Ref.get(ownership)
      const id = yield* Ownership.match(state, {
        Unstarted: () => Effect.succeedNone,
        Creating: () => api.createMachine(api.create, intent).pipe(Effect.map(acknowledged)),
        Owned: ({ id }) => Effect.succeedSome(id),
      })
      if (Option.isSome(id)) {
        yield* Ref.set(ownership, Ownership.cases.Owned.make({ id: id.value }))
        yield* remove(id.value, intent)
      }
    }).pipe(
      Effect.timeout('90 seconds'),
      Effect.interruptible,
      Effect.catch(() => cleanupFailed(ownership, intent)),
    ),
  )
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* Ref.set(ownership, Ownership.cases.Creating.make({}))
      const receipt = yield* restore(api.createMachine(api.create, intent))
      yield* Ref.set(ownership, Ownership.cases.Owned.make({ id: receipt.sandbox.id }))
      return receipt.sandbox.id
    }),
  )
})

/**
 * Prebind only a newly-created resource to this proof's fresh key. The running stack then uses
 * this durable identity, so its later Start/tools cannot select a configured Person Computer.
 * Production lifecycle owns readiness and holder admission; tests add no readiness polling.
 * All callers provide the existing disposable database fixture, including SSH-only proofs.
 */
export const proofComputer = Effect.fn('ComputerProof.computer')(function* (key: MachineKey) {
  const api = yield* proofProvider()
  const saved = yield* bindings()
  expect(yield* saved.load(key), 'The proof must own a fresh binding key').toEqual(Option.none())
  const id = yield* ownedMachine(api, key)
  const intended = yield* saved.intend(key, api.create)
  expect(intended.inserted).toBe(true)
  const binding = yield* saved.bind(key, intended.binding.intent, id)
  const context = yield* Layer.build(boatMachineLayer)
  const machine = yield* Machine.pipe(Effect.provideContext(context))
  yield* machine.ensure(key)
  return { api, id, key, binding, machine }
})
