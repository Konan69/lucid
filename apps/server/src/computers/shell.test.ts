import * as NodeCrypto from 'node:crypto'
import * as NodeChildProcess from 'node:child_process'
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
import {
  Deferred,
  Fiber,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
} from 'effect'
import { ShellSnapshot, SignalCue } from '@vivid/contracts'
import { commandWorkerLayer, observeCommand, startShell } from './commands.ts'
import { workLayer } from '../database/work.ts'
import { Conversation, DeliveryMessage, type ServerDelivery } from '../threads/conversation.ts'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { nativeTool } from '@vivid/agent-runtime/tooltesting'
import { computerSandbox, machineTools } from '@vivid/agent-runtime/sandbox'
import { Scope as ToolScope, scopedRunner } from '@vivid/agent-runtime/scope'
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
  ComputerStore,
  computerFileRead,
  computerFileWrite,
  computerShell,
  computerStoreLayer,
} from './store.ts'

/**
 * A Computer for tests that is a real SSH server on this machine (`ssh/peer.ts`): its shell and
 * its files are real, and they are reached through the same connection code a Boat machine is.
 * It starts asleep; `ensure` wakes it and is counted, so a test can say what woke it. It replaces
 * only the provider: the store, the takeover and idle rules, the outcomes and Pi's tools
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
    health: () => Effect.die('Shell fixture does not probe health'),
    recover: () => Effect.die('Shell fixture does not dispatch recovery'),
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
    findFields: unused('find fields'),
    fillFields: unused('fill fields'),
    clearFields: unused('clear fields'),
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
    converse: (input) =>
      link.converse(input).pipe(
        Effect.mapError(linkFailure),
        Effect.map((spoken) => ({
          output: spoken.output.pipe(
            Stream.mapError(() => new MachineNotRunning({ key: input.key })),
          ),
          say: (text: string) =>
            spoken.say(text).pipe(Effect.mapError(() => new MachineNotRunning({ key: input.key }))),
          ended: spoken.ended.pipe(
            Effect.mapError(() => new MachineNotRunning({ key: input.key })),
          ),
        })),
      ),
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
    helper: Option.none(),
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
      'keeps shell output and completion owed across a worker restart, and stops only its handle',
      () =>
        Effect.gen(function* () {
          const { server, machine } = yield* standIn()
          const actor = yield* acting()
          const store = computerStoreLayer.pipe(
            Layer.provide(Layer.succeed(Machine, machine)),
            Layer.provide(changesLayer),
          )
          const provided = yield* Layer.build(Layer.mergeAll(store, workLayer))
          const delivered = yield* Queue.unbounded<ServerDelivery>()
          const entered = yield* Deferred.make<void>()
          const conversation = Layer.succeed(
            Conversation,
            Conversation.of({
              admit: () => Effect.die('This test only delivers completion signals'),
              // Hold delivery so shutdown precedes the SQL acknowledgement; runtime admission is not proved here.
              deliver: (delivery) =>
                Queue.offer(delivered, delivery).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Effect.never),
                ),
            }),
          )
          yield* Effect.sync(() =>
            NodeChildProcess.execFileSync('mkfifo', [
              NodePath.join(server.home, 'release'),
              NodePath.join(server.home, 'started'),
            ]),
          )
          const started = yield* startShell(actor, {
            command:
              'printf ready; printf problem >&2; printf ready > started; read -r answer < release; printf "%s" "$answer"; exit 7',
            directory: server.home,
          }).pipe(Effect.provide(provided))
          if (!ShellSnapshot.guards.Running(started))
            return yield* Effect.die('Command did not start')
          const handle = started.handle
          // Register cleanup before assertions can strand a detached process.
          yield* Effect.addFinalizer(() =>
            observeCommand(actor.person.id, 'stop', { handle, seconds: 30 }).pipe(
              Effect.provide(provided),
              Effect.ignore,
            ),
          )
          const read = (action: 'read' | 'wait' | 'stop', seconds: number) =>
            observeCommand(actor.person.id, action, { handle, seconds }).pipe(
              Effect.provide(provided),
            )
          yield* Effect.flatMap(ComputerStore, (computer) =>
            computer.run(actor.person.id, {
              command: 'read -r ready < started',
              directory: server.home,
              timeoutSeconds: 30,
            }),
          ).pipe(Effect.provide(provided))
          const current = yield* read('read', 0)
          expect(current._tag).toBe('Running')
          expect(current).toMatchObject({
            stdout: 'ready',
            stderr: 'problem',
          })
          const worker = commandWorkerLayer.pipe(
            Layer.provide(conversation),
            Layer.provide(Layer.succeedContext(provided)),
          )
          // FIFO input is the release signal, never a sleep or output poll.
          yield* Effect.flatMap(ComputerStore, (computer) =>
            computer.run(actor.person.id, {
              command: "printf 'finished\\n' > release",
              directory: server.home,
              timeoutSeconds: 30,
            }),
          ).pipe(Effect.provide(provided))
          const ended = yield* read('wait', 30)
          expect(ended._tag).toBe('Completed')
          expect(ended).toMatchObject({
            stdout: 'readyfinished',
            stderr: 'problem',
            exitCode: 7,
          })
          const first = yield* Layer.launch(worker).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const before = yield* Queue.take(delivered)
          expect(before.idempotencyKey).toBe(`shell:${handle}`)
          yield* Fiber.interrupt(first)
          // Reacquire the production consumer and reclaim its unacknowledged SQL obligation.
          const second = yield* Layer.launch(worker).pipe(Effect.forkScoped)
          const after = yield* Queue.take(delivered)
          expect(after).toEqual(before)
          expect(after.message).toEqual(
            DeliveryMessage.cases.Signal.make({
              cue: SignalCue.cases.Shell.make({ handle, body: JSON.stringify(ended) }),
            }),
          )
          yield* Fiber.interrupt(second)
          expect(yield* read('read', 0)).toEqual(ended)
          const pending = yield* startShell(actor, {
            command: 'read -r answer < release',
            directory: server.home,
          }).pipe(Effect.provide(provided))
          if (!ShellSnapshot.guards.Running(pending))
            return yield* Effect.die('Second command did not start')
          yield* Effect.addFinalizer(() =>
            observeCommand(actor.person.id, 'stop', { handle: pending.handle, seconds: 30 }).pipe(
              Effect.provide(provided),
              Effect.ignore,
            ),
          )
          const stopped = yield* observeCommand(actor.person.id, 'stop', {
            handle: pending.handle,
            seconds: 30,
          }).pipe(Effect.provide(provided))
          expect(stopped._tag).toBe('Stopped')
          expect(yield* read('read', 0)).toEqual(ended)
          return undefined
        }).pipe(Effect.scoped),
    )
    it.effect(
      'writes, edits and reads a file and runs a command with the runtime tools, and only then wakes the Computer',
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
              timezone: '',
            }),
          )
          // The stand-in's home is its own fresh directory; on a Computer it is the user's home.
          const sandbox = computerSandbox(scopedRunner(scope), server.home)
          const tools = machineTools(sandbox)
          const read = nativeTool(tools[0])
          const write = nativeTool(tools[1])
          const edit = nativeTool(tools[2])
          const bash = nativeTool(tools[3])
          const grep = nativeTool(tools[4])
          const glob = nativeTool(tools[5])
          // Tool construction performs no workspace discovery or RPC.
          expect(yield* Ref.get(wakes)).toBe(0)
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
          const missing = yield* said(() => read.execute('call', { path: 'absent.txt' }))
          expect(missing).toContain('There is no file at that path.')
          // One wake served every call.
          expect(yield* Ref.get(wakes)).toBe(1)
        }).pipe(Effect.scoped),
    )
  })
})
