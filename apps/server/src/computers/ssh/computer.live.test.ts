import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import { expect, layer } from '@effect/vitest'
import { Duration, Effect, Fiber, Schema } from 'effect'
import { machineLinks } from '../boat/shell.ts'
import { ProviderId } from '../boat/protocol.ts'
import { active } from '../boat/state.ts'
import { transport } from '../boat/transport.ts'
import { MachineKey } from '../machine.ts'
import { KEY_TAG } from './link.ts'

/**
 * The SSH step on a real Computer: Boat's own `sshkey` call, the address it answers, the host key
 * it reports, and the machine's real shell, files and authorized keys.
 *
 * It names one existing machine (`VIVID_LIVE_COMPUTER_MACHINE`) and only uses it: it refuses to
 * run unless Boat says the machine is already running, so it wakes, stops, creates and deletes
 * nothing, and it binds no Person. What it leaves is nothing: its files and its own key line are
 * removed at the end. It does remove the key lines of Vivid's earlier connections, as every new
 * connection does; a server that holds a connection to the machine is not affected by that.
 *
 * It is the transport on a real machine, not the product: no Thread, no model, no store.
 */
const enabled =
  NodeProcess.env.VIVID_LIVE_COMPUTER_SSH === '1' &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  Object.hasOwn(NodeProcess.env, 'VIVID_LIVE_COMPUTER_MACHINE')

const decodeMachine = Schema.decodeUnknownEffect(ProviderId)

/** Only the step and how long it took are printed; never output of the machine or a key. */
const measured = <A, E, R>(step: string, program: Effect.Effect<A, E, R>) =>
  Effect.timed(program).pipe(
    Effect.map(([duration, result]) => {
      NodeProcess.stdout.write(
        `${JSON.stringify({ step, milliseconds: Math.round(Duration.toMillis(duration)) })}\n`,
      )
      return result
    }),
  )

layer(NodeHttpClient.layerUndici, { excludeTestServices: true, timeout: 180_000 })((it) => {
  it.effect.skipIf(!enabled)(
    'runs, writes, reads and cancels on a real Computer, with a key of its own for each opening',
    () =>
      Effect.gen(function* () {
        const api = yield* transport()
        const id = yield* decodeMachine(NodeProcess.env.VIVID_LIVE_COMPUTER_MACHINE)
        const record = (yield* api.get(id)).sandbox
        if (!active(record.state))
          expect.fail('The Computer is not running; this proof wakes nothing')
        const key = MachineKey.make(`live-${NodeCrypto.randomUUID()}`)
        const connections = machineLinks(api)
        yield* Effect.addFinalizer(() => connections.close)
        const { run, read, put } = connections.operations(() => Effect.succeed({ id }))
        const shell = (command: string) =>
          run({ key, command, directory: '/home/user', timeoutSeconds: 30 })
        const proof = `/home/user/vivid-proof-${NodeCrypto.randomUUID()}`
        /** The machine's key lines as counts and this connection's key, never the lines themselves. */
        const keys = Effect.fn('LiveComputer.keys')(function* () {
          const listed = yield* shell(
            `grep -c ' ${KEY_TAG}$' .ssh/authorized_keys; grep -vc ' ${KEY_TAG}$' .ssh/authorized_keys; grep ' ${KEY_TAG}$' .ssh/authorized_keys | cut -d' ' -f2 | sha256sum | cut -c1-16`,
          )
          const [mine, others, digest] = listed.stdout.trim().split('\n')
          return { mine, others, digest }
        })

        // The first command opens the connection: Boat lets this opening's key in and says where
        // the machine is, the host key is checked, and earlier key lines are removed.
        const first = yield* measured('open and first command', shell('whoami'))
        expect(first).toMatchObject({ exitCode: 0, timedOut: false })
        expect(first.stdout.trim()).toBe('user')
        yield* measured('second command', shell('true'))
        const before = yield* keys()
        expect(before.mine).toBe('1')

        const text = `written ${proof}\n`
        yield* measured(
          'put a file in a new directory',
          put({ key, path: `${proof}/notes/today.txt`, content: new TextEncoder().encode(text) }),
        )
        const back = yield* measured(
          'read it back',
          read({ key, path: `${proof}/notes/today.txt` }),
        )
        expect(new TextDecoder().decode(back)).toBe(text)
        const seen = yield* shell(`wc -c < ${proof}/notes/today.txt`)
        expect(Number(seen.stdout.trim())).toBe(text.length)
        const big = NodeCrypto.randomBytes(262_144)
        yield* measured('put 256 KB', put({ key, path: `${proof}/big.bin`, content: big }))
        const bigBack = yield* measured('read 256 KB', read({ key, path: `${proof}/big.bin` }))
        expect(Buffer.from(bigBack).equals(big)).toBe(true)

        // A command the caller stops waiting for is ended on the machine, with its child.
        const running = yield* Effect.forkChild(
          run({
            key,
            command: `sleep 300 & echo $! > ${proof}/pid.part; mv ${proof}/pid.part ${proof}/pid; wait`,
            directory: '/home/user',
            timeoutSeconds: 600,
          }),
        )
        yield* shell(`until [ -f ${proof}/pid ]; do :; done`)
        yield* Fiber.interrupt(running)
        const gone = yield* measured(
          'cancelled command gone',
          shell(`while kill -0 $(cat ${proof}/pid) 2>/dev/null; do :; done; echo gone`),
        )
        expect(gone.stdout.trim()).toBe('gone')
        // And one that passes its deadline.
        const late = yield* shell('true').pipe(
          Effect.andThen(
            run({ key, command: 'sleep 30', directory: '/home/user', timeoutSeconds: 1 }),
          ),
        )
        expect(late).toMatchObject({ exitCode: null, timedOut: true })

        // The machine stops for Vivid's purposes: the next command is a new opening with a new key,
        // and the line of the opening before it is gone. Lines that are not Vivid's are untouched.
        yield* connections.forget(key)
        yield* measured('second opening and command', shell('true'))
        const after = yield* keys()
        expect(after.mine).toBe('1')
        expect(after.digest).not.toBe(before.digest)
        expect(after.others).toBe(before.others)

        // Leave nothing: the proof's files, then this opening's own key line.
        const cleaned = yield* shell(
          `rm -rf ${proof} && sed -i '/ ${KEY_TAG}$/d' .ssh/authorized_keys && grep -c ' ${KEY_TAG}$' .ssh/authorized_keys; test ! -e ${proof} && echo clean`,
        )
        expect(cleaned.stdout.trim().split('\n')).toEqual(['0', 'clean'])
      }).pipe(Effect.scoped),
    180_000,
  )
})
