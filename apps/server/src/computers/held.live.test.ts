import { describe, expect, layer } from '@effect/vitest'
import { ComputerState } from '@vivid/contracts'
import { Effect, Option, Stream } from 'effect'
import { chainFixture, chainLayer } from '../runtime/chains.ts'
import { bindings } from './boat/bindings.ts'
import { proofComputer, proofProvider } from './tests/proof.ts'
import { computerMachineKey } from './store.ts'

/**
 * The real server meets a proof-owned machine whose guest holder names a different binding.
 * The fixture creates that machine and its first holder, then replaces only the local binding
 * with a fresh intent. The public Start must refuse the guest's original holder, release the
 * refused binding, and leave the holder bytes unchanged. Provider destruction is scoped to the
 * captured create receipt; no installation's existing Computer can be adopted by this proof.
 */
/** Opt-in work has no progress-aware in-test bound yet. Retain the existing runner
 * overrides until that migration. Source: unmeasured existing allocations. */
describe.skipIf(process.env['VIVID_LIVE_MACHINE_HELD'] !== '1')('A held machine, live', () => {
  layer(chainLayer, { excludeTestServices: true, timeout: 120_000 })((it) => {
    it.effect(
      'refuses a different holder, releases its binding and leaves the guest holder unchanged',
      () =>
        Effect.gen(function* () {
          yield* proofProvider()
          const fixture = yield* chainFixture('Held machine proof')
          const key = computerMachineKey(fixture.personId)
          const owned = yield* proofComputer(key)
          const { api, id: machine } = owned
          const saved = yield* bindings()
          // The first binding established the guest holder using production admission. A fresh
          // local binding models another server that knows nothing of that original holder.
          yield* saved.release(key, owned.binding.intent)
          const second = yield* saved.intend(key, api.create)
          expect(second.inserted).toBe(true)
          expect(second.binding.intent).not.toBe(owned.binding.intent)
          yield* saved.bind(key, second.binding.intent, machine)
          const record = api.command(machine, key, 'cat "$HOME/.vivid/holder"', 10)
          const before = yield* record
          expect(before).toMatchObject({ exitCode: 0, timedOut: false })
          expect(before.stdout).toBe(`${machine} ${owned.binding.intent}\n`)
          // A start answers at once with Starting and a worker does the rest (`store.ts`, `begin`),
          // so the outcome is read where the Person's own screen reads it: the live Computer.
          yield* fixture.rpc.StartComputer()
          const settled = yield* fixture.rpc.WatchComputer().pipe(
            Stream.map((answer) => answer.computer.state),
            Stream.filter((state) => !ComputerState.guards.Starting(state)),
            Stream.runHead,
          )
          expect(
            Option.map(settled, (state) => ComputerState.guards.Failed(state) && state.reason),
          ).toEqual(Option.some('Vivid’s computer is already in use by another account.'))
          // This server's table does not go on naming the machine, so it has nothing to use it with.
          expect(yield* (yield* bindings()).load(key)).toEqual(Option.none())
          const after = yield* record
          expect(after).toMatchObject({ exitCode: 0, timedOut: false })
          expect(after.stdout).toBe(before.stdout)
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    )
  })
})
