import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import {
  type ComputerFileReadOutcome,
  ComputerFileReadRequest,
  type ComputerFileWriteOutcome,
  ComputerFileWriteRequest,
  type ComputerShellOutcome,
  ComputerShellRequest,
  ComputerScreen,
  ComputerState,
  Person,
  PersonId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Ref, Schema, Stream } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import {
  Scope as ToolScope,
  scopedRunner,
} from '../../../../packages/agent/runtime/src/tools/scope.ts'
import {
  computerSandbox,
  machineTools,
} from '../../../../packages/agent/runtime/src/tools/sandbox.ts'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import {
  Machine,
  MachineNotRunning,
  MachinePortClosed,
  MachineState,
  computerScreenAddress,
} from './machine.ts'
import { linkFailure } from './boat/shell.ts'
import { LinkPortClosed, openLink } from './ssh/link.ts'
import { peer, peerAvailable } from './ssh/peer.ts'
import {
  type ComputerStore,
  computerFileRead,
  computerFileWrite,
  computerShell,
  computerStoreLayer,
} from './store.ts'

/**
 * A Computer for tests that is a real SSH server on this machine (`ssh/peer.ts`): its shell and
 * its files are real, and they are reached through the same connection code a Boat machine is.
 * It starts asleep; `ensure` wakes it and is counted, so a test can say what woke it. It replaces
 * only the provider: the store, the takeover and idle rules, the outcomes and Flue's own tools
 * are the ones production uses. What it cannot show is Boat: authorizing the key, an address
 * that changes on resume, and a machine that refuses SSH just after a wake.
 */
const standIn = Effect.fn('ShellTest.standIn')(function* () {
  const server = yield* peer()
  const link = yield* openLink(server)
  const wakes = yield* Ref.make(0)
  const awake = yield* Ref.make(false)
  const state = Ref.get(awake).pipe(
    Effect.map((running) =>
      running
        ? MachineState.cases.Running.make({ since: 1 })
        : ComputerState.cases.Stopped.make({ since: 1 }),
    ),
  )
  const unused = (operation: string) => () => Effect.die(`The stand-in does not ${operation}`)
  const machine = Machine.of({
    copySignIn: unused('copy a sign-in'),
    ensure: Effect.fn('StandIn.ensure')(function* () {
      yield* Ref.update(wakes, (count) => count + 1)
      yield* Ref.set(awake, true)
      return MachineState.cases.Running.make({ since: 1 })
    }),
    stop: () => Ref.set(awake, false),
    inspect: () => state,
    status: () =>
      Ref.get(awake).pipe(
        Effect.map((running) =>
          running
            ? ComputerState.cases.Running.make({
                since: 1,
                screen: ComputerScreen.cases.Relay.make({ address: computerScreenAddress }),
              })
            : ComputerState.cases.Stopped.make({ since: 1 }),
        ),
      ),
    screen: (key) => Effect.fail(new MachineNotRunning({ key })),
    exec: unused('run provider commands'),
    follow: () => Stream.die('The stand-in does not follow commands'),
    write: unused('write through the provider'),
    browse: unused('browse'),
    desktop: unused('use the desktop'),
    tunnel: (input) =>
      link
        .tunnel(input.port)
        .pipe(
          Effect.mapError((failure) =>
            failure instanceof LinkPortClosed
              ? new MachinePortClosed({ port: input.port })
              : linkFailure(failure),
          ),
        ),
    run: (input) =>
      link.run(input).pipe(
        Effect.catchTag('LinkRunLost', () => Effect.die('The stand-in lost a command')),
        Effect.mapError(linkFailure),
      ),
    converse: unused('speak with a command'),
    read: ({ path }) => link.read(path).pipe(Effect.mapError(linkFailure)),
    put: ({ path, content }) => link.put(path, content).pipe(Effect.mapError(linkFailure)),
  })
  return { server, wakes, machine }
})

/** One Person with a Computer, and Vivid acting for them in a Thread. */
const acting = Effect.fn('ShellTest.acting')(function* () {
  const database = yield* Database
  const id = PersonId.make(`shell-${NodeCrypto.randomUUID()}`)
  const person = Person.make({ id, name: 'Shell test', email: `${id}@example.test`, image: null })
  // Register deletion before insertion: losing its receipt must not leave this fixture behind.
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, id))).pipe(
      Effect.match({
        onSuccess: () => void 0,
        onFailure: () => expect.fail('Shell Person cleanup failed'),
      }),
    ),
  )
  yield* database.run(database.insert(personTable).values(person))
  const actor: Actor = {
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'vivid',
    threadId: Option.some(ThreadId.make('shell-thread')),
  }
  return actor
})

const isShell = Schema.is(ComputerShellRequest)
const isWrite = Schema.is(ComputerFileWriteRequest)
const isRead = Schema.is(ComputerFileReadRequest)

type Outcome = ComputerShellOutcome | ComputerFileReadOutcome | ComputerFileWriteOutcome

const textOf = (result: { readonly content: ReadonlyArray<{ readonly type: string }> }) =>
  result.content
    .map((block) => (Predicate.hasProperty(block, 'text') ? String(block.text) : ''))
    .join('')

describe.skipIf(!testDatabaseConfigured || !peerAvailable)("Vivid's own Computer tools", () => {
  layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
    it.effect(
      'writes, edits and reads a file and runs a command with Flue’s own tools, and only then wakes the Computer',
      () =>
        Effect.gen(function* () {
          const { server, wakes, machine } = yield* standIn()
          const store = computerStoreLayer.pipe(
            Layer.provide(Layer.succeed(Machine, machine)),
            Layer.provide(changesLayer),
          )
          const actor = yield* acting()
          // The runtime's generated client, answered by the server's own functions for these
          // calls: the same code the RPC handlers run, minus the HTTP hop and the session check.
          const requests =
            yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
          const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
            onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
          })
          const serving = yield* Layer.build(store)
          /** The server's own function with its real store; a failure it does not turn into an
           * outcome fails the test. */
          const serve = <A extends Outcome, E>(
            work: Effect.Effect<A, E, ComputerStore>,
          ): Effect.Effect<Outcome> => work.pipe(Effect.provide(serving), Effect.orDie)
          const answer = Effect.fn('ShellTest.answer')(function* (
            message: RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>,
          ) {
            if (!Predicate.isTagged(message, 'Request')) return
            // Without serialization the payload is the typed value; the schema says which call.
            const { payload } = message
            const outcome = yield* isShell(payload)
              ? serve(computerShell(actor, payload))
              : isWrite(payload)
                ? serve(computerFileWrite(actor, payload))
                : isRead(payload)
                  ? serve(computerFileRead(actor, payload))
                  : Effect.die(`Unexpected call ${message.tag}`)
            yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelope has no constructor in rc.116.
              _tag: 'Exit',
              clientId: 0,
              requestId: message.id,
              exit: Exit.succeed(outcome),
            })
          })
          yield* Queue.take(requests).pipe(
            Effect.flatMap(answer),
            Effect.forever,
            Effect.forkScoped,
          )
          const scope = Layer.succeed(
            ToolScope,
            ToolScope.of({
              acting: { personId: actor.person.id, threadId: ThreadId.make('shell-thread') },
              client: rpc.client,
            }),
          )
          // The stand-in's home is its own fresh directory; on a Computer it is the user's home.
          const sandbox = computerSandbox(scopedRunner(scope), server.home)
          // Flue's workspace discovery asks these when a conversation starts; none reaches the
          // machine, so nothing has woken it.
          expect(yield* Effect.promise(() => sandbox.exists('AGENTS.md'))).toBe(false)
          expect(yield* Ref.get(wakes)).toBe(0)

          const [read, write, edit, bash, grep, glob] = machineTools(sandbox)
          const said = <A extends { readonly content: ReadonlyArray<{ readonly type: string }> }>(
            result: () => Promise<A>,
          ) => Effect.promise(result).pipe(Effect.map(textOf))

          // Relative paths are under the Computer's home, as they are for a person at a shell.
          yield* said(() =>
            write.execute('call', { path: 'work/notes.md', content: 'Buy milk\nCall Ada\n' }),
          )
          expect(yield* Ref.get(wakes)).toBe(1)
          const notes = NodePath.join(server.home, 'work/notes.md')
          expect(NodeFS.readFileSync(notes, 'utf8')).toBe('Buy milk\nCall Ada\n')

          yield* said(() =>
            edit.execute('call', {
              path: 'work/notes.md',
              oldText: 'Call Ada',
              newText: 'Call Grace',
            }),
          )
          expect(yield* said(() => read.execute('call', { path: 'work/notes.md' }))).toContain(
            'Call Grace',
          )
          const counted = yield* said(() =>
            bash.execute('call', {
              command: 'pwd; wc -l < work/notes.md; grep -c Grace work/notes.md',
            }),
          )
          expect(counted.trim().split(/\s+/)).toEqual([server.home, '2', '1'])
          expect(yield* said(() => grep.execute('call', { pattern: 'Grace' }))).toContain(
            'notes.md',
          )
          expect(yield* said(() => glob.execute('call', { pattern: '*.md' }))).toContain(
            'work/notes.md',
          )

          // A refusal by the machine is a sentence for the model, not a crash.
          const missing = yield* Effect.tryPromise(() =>
            read.execute('call', { path: 'absent.txt' }),
          ).pipe(Effect.flip)
          expect(String(missing.cause)).toContain('There is no file at that path.')
          // One wake served every call.
          expect(yield* Ref.get(wakes)).toBe(1)
        }).pipe(Effect.scoped),
      60_000,
    )
  })
})
