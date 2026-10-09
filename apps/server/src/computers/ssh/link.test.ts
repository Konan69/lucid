import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Ref, Scope, Stream } from 'effect'
import {
  FILE_BYTES,
  LinkFileRefused,
  LinkRunLost,
  LinkUnreachable,
  KEY_TAG,
  OUTPUT_BYTES,
  connectionIdentity,
  openLink,
  type Link,
} from './link.ts'
import { links } from './links.ts'
import { peer, peerAvailable } from './peer.ts'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

/** One server and one connection for a test, as the adapter holds one per awake machine. */
const connected = Effect.fn('LinkTest.connected')(function* () {
  const server = yield* peer()
  const link = yield* openLink(server)
  return { server, link }
})

it.live.skipIf(!peerAvailable)(
  'puts a file in directories that do not exist, reads it back, and a command sees it',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const path = NodePath.join(server.home, 'notes/today/list.txt')
      yield* link.put(path, bytes('milk\nbread\n'))
      expect(NodeFS.readFileSync(path, 'utf8')).toBe('milk\nbread\n')
      expect(text(yield* link.read(path))).toBe('milk\nbread\n')
      const run = yield* link.run({
        command: 'wc -l < notes/today/list.txt; echo problem >&2; exit 3',
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(run.stdout.trim()).toBe('2')
      expect(run.stderr.trim()).toBe('problem')
      expect(run).toMatchObject({ exitCode: 3, timedOut: false, truncated: false })
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'carries bytes that are not text unchanged in both directions',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const picture = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256)
      const path = NodePath.join(server.home, 'picture.bin')
      yield* link.put(path, picture)
      expect(Buffer.from(yield* link.read(path)).equals(Buffer.from(picture))).toBe(true)
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'says why a file could not be read: missing, a directory, or too large',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const missing = yield* Effect.flip(link.read(NodePath.join(server.home, 'absent.txt')))
      expect(missing).toBeInstanceOf(LinkFileRefused)
      expect(missing).toMatchObject({ reason: 'missing' })
      const directory = yield* Effect.flip(link.read(server.home))
      expect(directory).toMatchObject({ reason: 'directory' })
      const large = NodePath.join(server.home, 'large.bin')
      NodeFS.writeFileSync(large, Buffer.alloc(FILE_BYTES + 1))
      expect(yield* Effect.flip(link.read(large))).toMatchObject({ reason: 'large' })
    }).pipe(Effect.scoped),
  30_000,
)

/**
 * Ends the connection from the machine's side, as a machine that stops does: the command kills
 * the server process of its own session (its shell's parent's parent), found by its own ancestry.
 * Its end is therefore never heard.
 */
const hangUp = (link: Link, home: string) =>
  Effect.flip(
    link.run({
      command: 'kill -KILL $(ps -o ppid= -p $PPID)',
      directory: home,
      timeoutSeconds: 20,
    }),
  )

/** Asks the machine itself until the process is gone; the loop is the machine's, not the test's. */
const gone = (pid: string) => `while kill -0 ${pid} 2>/dev/null; do :; done; echo gone`

it.live.skipIf(!peerAvailable)(
  'ends a command and its children at the deadline',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const run = yield* link.run({
        command: 'echo started; sleep 300 & echo $! > pid; wait',
        directory: server.home,
        timeoutSeconds: 1,
      })
      expect(run).toMatchObject({ exitCode: null, timedOut: true })
      expect(run.stdout.trim()).toBe('started')
      const pid = NodeFS.readFileSync(NodePath.join(server.home, 'pid'), 'utf8').trim()
      const after = yield* link.run({
        command: gone(pid),
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(after.stdout.trim()).toBe('gone')
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'ends a command on the machine when the caller stops waiting for it',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const pidFile = NodePath.join(server.home, 'pid')
      const running = yield* Effect.forkChild(
        link.run({
          command: 'sleep 300 & echo $! > pid.part; mv pid.part pid; wait',
          directory: server.home,
          timeoutSeconds: 600,
        }),
      )
      // The command says it started by making the file; wait on the machine for that.
      yield* link.run({
        command: 'until [ -f pid ]; do :; done',
        directory: server.home,
        timeoutSeconds: 20,
      })
      yield* Fiber.interrupt(running)
      const pid = NodeFS.readFileSync(pidFile, 'utf8').trim()
      const after = yield* link.run({
        command: gone(pid),
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(after.stdout.trim()).toBe('gone')
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'keeps the end of an output that is larger than the limit',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const run = yield* link.run({
        command: `head -c ${OUTPUT_BYTES * 3} /dev/zero | tr '\\0' a; echo; echo last-line`,
        directory: server.home,
        timeoutSeconds: 30,
      })
      expect(run.truncated).toBe(true)
      expect(run.stdout.length).toBeLessThanOrEqual(OUTPUT_BYTES)
      expect(run.stdout.endsWith('last-line\n')).toBe(true)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'refuses a host that does not present the expected key, before anything is sent',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const failure = yield* Effect.flip(openLink({ ...server, hostKey: server.stranger }))
      expect(failure._tag).toBe('LinkHostMismatch')
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'tells a running command its end was not heard when the machine goes, and is no longer alive',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const running = yield* Effect.forkChild(
        Effect.flip(
          link.run({
            command: 'touch started; sleep 300',
            directory: server.home,
            timeoutSeconds: 600,
          }),
        ),
      )
      yield* link.run({
        command: 'until [ -f started ]; do :; done',
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(yield* hangUp(link, server.home)).toBeInstanceOf(LinkRunLost)
      yield* server.end
      expect(yield* Fiber.join(running)).toBeInstanceOf(LinkRunLost)
      expect(link.alive()).toBe(false)
      // A call on the dead connection is told at once; it does not wait and does not throw.
      expect(yield* Effect.flip(link.read(`${server.home}/started`))).toBeInstanceOf(
        LinkUnreachable,
      )
      expect(yield* Effect.flip(openLink(server))).toBeInstanceOf(LinkUnreachable)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'hands out one connection per machine, and a new one where the machine now is after the old one died',
  () =>
    Effect.gen(function* () {
      const first = yield* peer()
      const second = yield* peer()
      second.authorize(first.identity.publicKey)
      const located = yield* Ref.make(0)
      const held = links<string>(first.authorizedFile)
      yield* Effect.addFinalizer(() => held.close)
      // The machine "resumes somewhere else": its provider names the second server from then on.
      const locate = Ref.updateAndGet(located, (count) => count + 1).pipe(
        Effect.map((count) => (count === 1 ? first : { ...second, identity: first.identity })),
      )
      const one = yield* held.get('machine', locate)
      expect(yield* held.get('machine', locate)).toBe(one)
      expect(yield* Ref.get(located)).toBe(1)
      yield* hangUp(one, first.home)
      yield* first.end
      const two = yield* held.get('machine', locate)
      expect(two).not.toBe(one)
      expect(yield* Ref.get(located)).toBe(2)
      const run = yield* two.run({ command: 'pwd', directory: second.home, timeoutSeconds: 10 })
      expect(run.stdout.trim()).toBe(second.home)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'opens one machine while another is still being found',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const held = links<string>(server.authorizedFile)
      yield* Effect.addFinalizer(() => held.close)
      // The first machine's provider has been asked where it is and has not answered: a machine
      // that is still waking. `asked` says the opening is under way, so nothing here waits on time.
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const target = server
      const waking = yield* held
        .get(
          'waking',
          Deferred.succeed(asked, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
            Effect.as(target),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(asked)
      const awake = yield* held.get('awake', Effect.succeed(target))
      const run = yield* awake.run({
        command: 'echo here',
        directory: server.home,
        timeoutSeconds: 10,
      })
      expect(run.stdout.trim()).toBe('here')
      yield* Deferred.succeed(answer, undefined)
      expect((yield* Fiber.join(waking)).alive()).toBe(true)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'keeps nothing from an opening whose machine stopped while it was being found',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const held = links<string>(server.authorizedFile)
      yield* Effect.addFinalizer(() => held.close)
      const located = yield* Ref.make(0)
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const target = server
      // The first asking is held until the test answers it; later ones answer at once.
      const locate = Ref.updateAndGet(located, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === 1
            ? Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer)))
            : Effect.void,
        ),
        Effect.as(target),
      )
      const opening = yield* held.get('machine', locate).pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(asked)
      // The machine stops: what was being opened is for the machine as it was.
      yield* held.forget('machine')
      yield* Deferred.succeed(answer, undefined)
      expect(yield* Fiber.join(opening)).toBeInstanceOf(LinkUnreachable)
      // Nothing was kept: the next use asks where the machine is again.
      const link = yield* held.get('machine', locate)
      expect(yield* Ref.get(located)).toBe(2)
      expect(link.alive()).toBe(true)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'leaves a new connection open when a call hears late that the old one died',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const held = links<string>(server.authorizedFile)
      yield* Effect.addFinalizer(() => held.close)
      const located = yield* Ref.make(0)
      const locate = Ref.update(located, (count) => count + 1).pipe(Effect.as(server))
      const old = yield* held.get('machine', locate)
      yield* hangUp(old, server.home)
      const fresh = yield* held.get('machine', locate)
      expect(fresh).not.toBe(old)
      // A second call that was on the old connection reports its loss only now.
      yield* held.discard('machine', old)
      expect(yield* held.get('machine', locate)).toBe(fresh)
      expect(fresh.alive()).toBe(true)
      expect(yield* Ref.get(located)).toBe(2)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'keeps nothing from an opening the owner closed over',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const held = links<string>(server.authorizedFile)
      const located = yield* Ref.make(0)
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const locate = Ref.update(located, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(asked, undefined)),
        Effect.andThen(Deferred.await(answer)),
        Effect.as(server),
      )
      const opening = yield* held.get('machine', locate).pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(asked)
      yield* held.close
      yield* Deferred.succeed(answer, undefined)
      expect(yield* Fiber.join(opening)).toBeInstanceOf(LinkUnreachable)
      // Closed for good: a later use is refused without asking where the machine is.
      expect(yield* Effect.flip(held.get('machine', locate))).toBeInstanceOf(LinkUnreachable)
      expect(yield* Ref.get(located)).toBe(1)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'opens nothing after the owner has closed',
  () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const held = links<string>(server.authorizedFile)
      const located = yield* Ref.make(0)
      const locate = Ref.update(located, (count) => count + 1).pipe(Effect.as(server))
      yield* held.close
      expect(yield* Effect.flip(held.get('machine', locate))).toBeInstanceOf(LinkUnreachable)
      expect(yield* Ref.get(located)).toBe(0)
    }).pipe(Effect.scoped),
  20_000,
)

it.live.skipIf(!peerAvailable)(
  'says a directory may not be made where a file is in the way, instead of calling it missing',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      NodeFS.writeFileSync(NodePath.join(server.home, 'taken'), 'a file')
      const refused = yield* Effect.flip(
        link.put(NodePath.join(server.home, 'taken/inside/file.txt'), bytes('x')),
      )
      expect(refused).toBeInstanceOf(LinkFileRefused)
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'gives every opening a key of its own and removes the lines of the openings before it, keeping lines that are not Vivid’s',
  () =>
    Effect.gen(function* () {
      const machine = yield* peer()
      const other = yield* peer()
      // On the machine before Vivid's first connection: a key of the Person's own, with options
      // and a comment, and the line of the one key an installation used to have.
      const persons = `no-pty ${machine.stranger.split(' ').slice(0, 2).join(' ')} ada@laptop`
      const retired = `${other.stranger.split(' ').slice(0, 2).join(' ')} vivid`
      // Lines that are not key records, though they end in Vivid's words.
      const notes = ['# managed by vivid', '# unrelated vivid-connection']
      machine.authorize(persons)
      machine.authorize(retired)
      for (const note of notes) machine.authorize(note)
      // A mode that is not the temporary file's default, to show the file keeps its own.
      NodeFS.chmodSync(machine.authorizedFile, 0o640)
      const presented: Array<string> = []
      /** What a provider does when asked: makes nothing, lets the given key in, says where. */
      const locate = (server: typeof machine) =>
        connectionIdentity.pipe(
          Effect.map((identity) => {
            presented.push(identity.publicKey)
            server.authorize(identity.publicKey)
            return { ...server, identity }
          }),
        )
      const held = links<string>(machine.authorizedFile)
      const elsewhere = links<string>(other.authorizedFile)
      yield* Effect.addFinalizer(() => held.close)
      yield* Effect.addFinalizer(() => elsewhere.close)

      yield* held.get('machine', locate(machine))
      yield* held.forget('machine')
      const second = yield* held.get('machine', locate(machine))
      yield* elsewhere.get('other', locate(other))

      const [one, two, three] = presented
      if (one === undefined || two === undefined || three === undefined)
        expect.fail('Three openings were expected')
      expect(new Set(presented).size).toBe(3)
      for (const line of presented) expect(line.endsWith(` ${KEY_TAG}`)).toBe(true)

      // The second opening works, and what the machine now lets in is the Person's key and the
      // second opening's: the first opening's line and the retired key's line are gone.
      const run = yield* second.run({
        command: 'echo in',
        directory: machine.home,
        timeoutSeconds: 10,
      })
      expect(run.stdout.trim()).toBe('in')
      const lines = machine.authorizedLines()
      expect(lines).toContain(persons)
      expect(lines).toContain(two)
      expect(lines).not.toContain(one)
      expect(lines).not.toContain(retired)
      // The fixture's own first key carried Vivid's tag too, and went with the rest.
      for (const note of notes) expect(lines).toContain(note)
      expect(lines).toHaveLength(4)
      expect(NodeFS.statSync(machine.authorizedFile).mode & 0o777).toBe(0o640)
      // A session's home is the fixture's own, so a path under the home is never the developer's.
      const home = yield* second.run({
        command: 'echo "$HOME"',
        directory: '/',
        timeoutSeconds: 10,
      })
      expect(home.stdout.trim()).toBe(machine.home)
      // The other machine never saw the first machine's keys.
      expect(other.authorizedLines()).toContain(three)
      expect(other.authorizedLines()).not.toContain(two)
    }).pipe(Effect.scoped),
  40_000,
)

/**
 * A command that is spoken with: it answers each line it is given, as a program on a Computer
 * answers the server. Shown on a real SSH server, because the claim is about the channel.
 */
it.live.skipIf(!peerAvailable)(
  'speaks with a running command in both directions, and hears how it ended',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const spoken = yield* link.converse({
        // Echoes each line back in capitals until it is told to stop; the two-byte character is
        // split across writes to show a piece need not end on a character.
        command: 'while read line; do [ "$line" = stop ] && exit 7; echo "$line" | tr a-z A-Z; done',
        directory: server.home,
        timeoutSeconds: 20,
      })
      const heard = yield* Ref.make('')
      const reading = yield* Effect.forkChild(
        Stream.runForEach(spoken.output, (piece) => Ref.update(heard, (text) => text + piece)),
      )
      yield* spoken.say('first\n')
      yield* spoken.say('caf')
      yield* spoken.say('é second\n')
      yield* spoken.say('stop\n')
      yield* Fiber.join(reading)
      expect(yield* Ref.get(heard)).toBe('FIRST\nCAFé SECOND\n')
      expect(yield* spoken.ended).toEqual({ exitCode: 7, timedOut: false })
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'ends a spoken-with command, and what it started, when its scope closes',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected()
      const scope = yield* Scope.make()
      const spoken = yield* link
        .converse({
          // Starts something that would run for ten minutes, says which process it is, and waits.
          command: 'sleep 600 & echo $!; wait',
          directory: server.home,
          timeoutSeconds: 900,
        })
        .pipe(Scope.provide(scope))
      const first = yield* Stream.runHead(spoken.output)
      const pid = first._tag === 'Some' ? first.value.trim() : ''
      expect(pid).toMatch(/^\d+$/u)
      yield* Scope.close(scope, Exit.void)
      // The machine signalled the command's whole group: what it started is gone as well.
      const after = yield* link.run({
        command: gone(pid),
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(after.stdout.trim()).toBe('gone')
    }).pipe(Effect.scoped),
  30_000,
)
