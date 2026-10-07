import { describe, expect, layer } from '@effect/vitest'
import { ComputerState } from '@vivid/contracts'
import { Effect, Option, Stream } from 'effect'
import { chainFixture, chainLayer } from '../runtime/chains.ts'
import { bindings } from './boat/bindings.ts'
import { active } from './boat/state.ts'
import { transport } from './boat/transport.ts'
import { computerMachineKey } from './store.ts'

/**
 * A second server that names a machine another server's account holds, through the real server
 * and the real machine.
 *
 * The stack this runs against is the mistake itself: its `VIVID_BOAT_MACHINE` names a machine
 * whose own record (`boat/holder.ts`) names a binding in another server's table, which this
 * stack's table has never heard of. Before the record existed that stack bound the machine and
 * shared its desktop, files and signed-in browser with the other account.
 *
 * Nothing is made, stopped or deleted to stage it. The proof refuses to go on unless the machine
 * is running, so that it wakes nothing; a machine that archives in the instant after that check
 * would be woken by the start, which is what a start does and all it would cost. The claim is that the Person on this server
 * is told the computer is another account's, that this server keeps no binding to it, and that
 * the machine's record is exactly what it was.
 */
describe.skipIf(process.env['VIVID_LIVE_MACHINE_HELD'] !== '1')('A held machine, live', () => {
  layer(chainLayer, { excludeTestServices: true })((it) => {
    it.effect(
      'refuses a second server that names a machine another account holds, and changes nothing on it',
      () =>
        Effect.gen(function* () {
          const api = yield* transport()
          const machine = yield* Option.match(api.adopt, {
            onNone: () =>
              Effect.sync(() =>
                expect.fail('The stack must name the held machine in VIVID_BOAT_MACHINE'),
              ),
            onSome: (id) => Effect.succeed(id),
          })
          const fixture = yield* chainFixture('Held machine proof')
          const key = computerMachineKey(fixture.personId)
          expect(
            active((yield* api.get(machine)).sandbox.state),
            'The machine must already be running: this proof does not wake it',
          ).toBe(true)
          const record = api.command(machine, key, 'cat "$HOME/.vivid/holder"', 10)
          const before = yield* record
          expect(before.exitCode, 'The machine must already record its holder').toBe(0)
          // A whole record for this machine, and so some other server's binding: this stack's
          // table is new and holds none.
          expect(before.stdout).toMatch(
            new RegExp(`^${machine} [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\n$`, 'u'),
          )

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
          expect((yield* record).stdout).toBe(before.stdout)
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    )
  })
})
