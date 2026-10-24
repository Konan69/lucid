import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import { expect, layer } from '@effect/vitest'
import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from 'effect'
import { machineLinks } from '../boat/shell.ts'
import { proofComputer } from '../tests/proof.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../../database/testdb.ts'
import { loadRunner } from '../../code/computer.ts'
import { decodeWorker, encodeParent, ParentMessage, WorkerMessage } from '../../code/protocol.ts'
import { MachineKey } from '../machine.ts'
import { KEY_TAG } from './link.ts'

/**
 * Real provider SSH authorization, host keys, files, cancellation and runner frames, on a
 * machine this proof creates from the frozen Computer template. Its unique create receipt is
 * the deletion authority; configured adoption targets are rejected before any guest/SSH work.
 * Each scenario owns its resource, binding and pre-registered proof-directory cleanup. Destroying
 * that disposable resource removes guest keys; teardown never prunes arbitrary KEY_TAG lines.
 */
const enabled =
  NodeProcess.env.VIVID_LIVE_COMPUTER_SSH === '1' &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  testDatabaseConfigured
const dependencies = Layer.mergeAll(NodeHttpClient.layerUndici, testDatabaseLayer)
type Operations = ReturnType<ReturnType<typeof machineLinks>['operations']>

/** Register directory cleanup before the first put/mkdir; failure remains a failed live proof. */
const proofDirectory = Effect.fn('LiveComputer.directory')(function* (
  operations: Operations,
  key: MachineKey,
) {
  const proof = `/home/user/vivid-proof-${NodeCrypto.randomUUID()}`
  yield* Effect.addFinalizer(() =>
    operations
      .run({
        key,
        command: `rm -rf -- ${proof} && test ! -e ${proof}`,
        directory: '/home/user',
        timeoutSeconds: 30,
      })
      .pipe(
        Effect.tap((receipt) =>
          Effect.sync(() =>
            expect(receipt, 'Remove only this proof directory').toMatchObject({
              exitCode: 0,
              timedOut: false,
            }),
          ),
        ),
        Effect.asVoid,
        Effect.timeout('40 seconds'),
        Effect.interruptible,
        Effect.catch(() => Effect.sync(() => expect.fail('SSH proof directory cleanup failed'))),
      ),
  )
  return proof
})

/**
 * The command and its child inherit the lifetime pipe. A second channel blocks on the readiness
 * pipe, then interruption must release the lifetime writer: EOF proves no child retains it.
 * FIFO open/read are kernel waits, replacing the old file/kill busy loops and sleeping worker.
 */
const cancelled = Effect.fn('LiveComputer.cancelled')(function* (
  operations: Operations,
  key: MachineKey,
  proof: string,
) {
  const shell = (command: string) =>
    operations.run({
      key,
      command,
      directory: proof,
      timeoutSeconds: 30,
    })
  expect(yield* shell('mkfifo alive started hold')).toMatchObject({ exitCode: 0, timedOut: false })
  const ended = yield* shell('cat alive; printf "gone\n"').pipe(Effect.forkScoped)
  const running = yield* operations
    .run({
      key,
      command: `bash -c 'exec 3>alive; cat <hold & child=$!; printf "ready\n" >started; wait "$child"' & wait`,
      directory: proof,
      timeoutSeconds: 600,
    })
    .pipe(Effect.forkScoped)
  const ready = yield* shell('read -r status <started; test "$status" = ready && printf "ready\n"')
  expect(ready).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'ready\n' })
  yield* Fiber.interrupt(running)
  const gone = yield* measured('cancelled command and child release their pipe', Fiber.join(ended))
  expect(gone).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'gone\n' })
})

/** A deadline must terminate both lifetime writers, not merely return timedOut to the caller. */
const deadline = Effect.fn('LiveComputer.deadline')(function* (
  operations: Operations,
  key: MachineKey,
  proof: string,
) {
  const ended = yield* operations
    .run({
      key,
      command: 'cat alive; printf "gone\n"',
      directory: proof,
      timeoutSeconds: 30,
    })
    .pipe(Effect.forkScoped)
  const running = yield* operations
    .run({
      key,
      command: `bash -c 'exec 3>alive; cat <hold & child=$!; printf "ready\n" >started; wait "$child"' & wait`,
      directory: proof,
      timeoutSeconds: 3,
    })
    .pipe(Effect.forkScoped)
  const ready = yield* operations.run({
    key,
    command: 'read -r status <started; test "$status" = ready && printf "ready\n"',
    directory: proof,
    timeoutSeconds: 30,
  })
  expect(ready).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'ready\n' })
  const late = yield* Fiber.join(running)
  expect(late).toMatchObject({ exitCode: null, timedOut: true })
  expect(yield* Fiber.join(ended)).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'gone\n' })
})

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

/** Opt-in work has no progress-aware in-test bound yet. Retain the existing runner
 * overrides until that migration. Source: unmeasured existing allocations. */
layer(dependencies, { excludeTestServices: true, timeout: 180_000 })((it) => {
  it.effect.skipIf(!enabled)(
    'runs, writes, reads and cancels on a real Computer, with a key of its own for each opening',
    () =>
      Effect.gen(function* () {
        const key = MachineKey.make(`live-${NodeCrypto.randomUUID()}`)
        const { api, id } = yield* proofComputer(key)
        const connections = machineLinks(api)
        yield* Effect.addFinalizer(() => connections.close)
        const operations = connections.operations(() => Effect.succeed({ id }))
        const shell = (command: string) =>
          operations.run({ key, command, directory: '/home/user', timeoutSeconds: 30 })
        const proof = yield* proofDirectory(operations, key)
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
          operations.put({
            key,
            path: `${proof}/notes/today.txt`,
            content: new TextEncoder().encode(text),
          }),
        )
        const back = yield* measured(
          'read it back',
          operations.read({ key, path: `${proof}/notes/today.txt` }),
        )
        expect(new TextDecoder().decode(back)).toBe(text)
        const seen = yield* shell(`wc -c < ${proof}/notes/today.txt`)
        expect(Number(seen.stdout.trim())).toBe(text.length)
        const big = NodeCrypto.randomBytes(262_144)
        yield* measured(
          'put 256 KB',
          operations.put({ key, path: `${proof}/big.bin`, content: big }),
        )
        const bigBack = yield* measured(
          'read 256 KB',
          operations.read({ key, path: `${proof}/big.bin` }),
        )
        expect(Buffer.from(bigBack).equals(big)).toBe(true)

        yield* cancelled(operations, key, proof)
        yield* deadline(operations, key, proof)

        // The machine stops for Vivid's purposes: the next command is a new opening with a new key,
        // and the line of the opening before it is gone. Lines that are not Vivid's are untouched.
        yield* connections.forget(key)
        yield* measured('second opening and command', shell('true'))
        const after = yield* keys()
        expect(after.mine).toBe('1')
        expect(after.digest).not.toBe(before.digest)
        expect(after.others).toBe(before.others)

        // Scoped directory/connection finalizers run before destruction of this owned machine.
      }).pipe(Effect.scoped),
    180_000,
  )

  /**
   * A program on a real Computer, spoken with over its SSH channel: the real runner
   * (`code/guest.mjs`), started as the server starts it, given a program that uses the Computer's
   * own files and asks the server for one thing. The server's side here is this test: it reads
   * the runner's lines and writes the answer. No Person, no model and no store are involved; that
   * a supervised program works through them is `code/process.test.ts`.
   */
  it.effect.skipIf(!enabled)(
    'runs a program on a real Computer and answers its call over the SSH channel',
    () =>
      Effect.gen(function* () {
        const key = MachineKey.make(`live-${NodeCrypto.randomUUID()}`)
        const { api, id } = yield* proofComputer(key)
        const connections = machineLinks(api)
        yield* Effect.addFinalizer(() => connections.close)
        const operations = connections.operations(() => Effect.succeed({ id }))
        const proof = yield* proofDirectory(operations, key)
        const runner = yield* loadRunner
        yield* operations.put({
          key,
          path: `${proof}/runner.mjs`,
          content: new TextEncoder().encode(runner.text),
        })
        const spoken = yield* measured(
          'start the runner',
          operations.converse({
            key,
            command: `exec node ${proof}/runner.mjs 32768 8192 100 262144`,
            directory: proof,
            timeoutSeconds: 120,
          }),
        )
        const heard = yield* Ref.make('')
        /** The runner's next whole line, as the server reads it. */
        const line = Effect.fn('LiveComputer.line')(function* () {
          const next = yield* spoken.output.pipe(
            Stream.mapEffect((piece) => Ref.updateAndGet(heard, (text) => text + piece)),
            Stream.filter((text) => text.includes('\n')),
            Stream.runHead,
          )
          if (Option.isNone(next)) return expect.fail('The runner ended before it said anything')
          const [whole, ...rest] = next.value.split('\n')
          yield* Ref.set(heard, rest.join('\n'))
          return yield* decodeWorker(String(whole))
        })
        const program = `const files = await import("node:fs/promises");
const found = await tools.find_tools({query: "records"});
await files.writeFile("note.txt", "asked for " + found.answer);
console.log("wrote the file");
return {note: await files.readFile("note.txt", "utf8"), platform: process.platform};`
        const say = (message: ParentMessage) =>
          encodeParent(message).pipe(Effect.flatMap((text) => spoken.say(`${text}\n`)))
        yield* say(ParentMessage.cases.Start.make({ code: program }))
        expect(yield* measured('the program asks', line())).toEqual(
          WorkerMessage.cases.Call.make({ id: 1, kind: 'find_tools', input: { query: 'records' } }),
        )
        yield* say(ParentMessage.cases.Reply.make({ id: 1, value: { answer: 'records' } }))
        expect(yield* measured('the program finishes', line())).toEqual(
          WorkerMessage.cases.Done.make({
            result: { note: 'asked for records', platform: 'linux' },
            logs: ['wrote the file'],
            logsTruncated: false,
          }),
        )
        expect(yield* spoken.ended).toEqual({ exitCode: 0, timedOut: false })
        // Scoped cleanup also runs when runner assertions fail or this case is interrupted.
      }).pipe(Effect.scoped),
    180_000,
  )
})
