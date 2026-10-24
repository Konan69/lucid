import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeV8 from 'node:v8'
import * as NodeVM from 'node:vm'
import * as NodeTimersPromises from 'node:timers/promises'
import { describe, expect, it, vi } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { AgentFS } from 'agentfs-sdk'
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Scope,
  Exit,
  Schema,
  References,
  Scheduler,
  Latch,
  Option,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Note, NoteFile, NotesSettings, make, NotesUnavailable, NotesAtCapacity } from './notes.ts'

/**
 * The real store, AgentFS on a SQLite file, in a temporary directory that is removed when the test
 * ends. All store and note operations use real AgentFS; the failed-open race controls one mkdir receipt.
 */
const directory = Effect.acquireRelease(
  Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-notes-'))),
  (path) =>
    Effect.tryPromise(() => NodeFSP.rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
)

/** The directory is already owned before Notes can write; its finalizer runs after store close. */
const store = Effect.fn('NotesTest.store')(function* (person: string) {
  const path = yield* directory
  const notes = yield* make(
    NotesSettings.make({ directory: path, capacity: 2, idle: Duration.seconds(1) }),
  )
  return { directory: path, person: PersonId.make(person), notes }
})

/**
 * AgentFS 0.6.4 leaves short-lived prepared statements unclosed. Turso 0.4.4 native objects
 * retain the file descriptor until GC even after database.close(). Force collection only in
 * this test worker, then await the event-loop receipt that flushes native finalizers; this is
 * neither a sleep nor polling. The public close is still the only production cleanup API.
 */
NodeV8.setFlagsFromString('--expose-gc')
const collect = Schema.decodeUnknownSync(
  Schema.declare<() => void>(
    // The native gc callable is a test-runtime boundary, not persisted domain data.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    (value): value is () => void => typeof value === 'function',
  ),
)(NodeVM.runInNewContext('gc'))
NodeV8.setFlagsFromString('--no-expose-gc')

const descriptorGone = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))

/** Native descriptors distinguish an owner dropping its store from a cache that retains it. */
const handles = Effect.fn('NotesTest.handles')(function* (path: string) {
  collect()
  yield* Effect.tryPromise(() => NodeTimersPromises.setImmediate())
  const descriptors = yield* Effect.tryPromise(() => NodeFSP.readdir('/proc/self/fd'))
  const links = yield* Effect.forEach(descriptors, (descriptor) =>
    Effect.tryPromise(() => NodeFSP.readlink(`/proc/self/fd/${descriptor}`)).pipe(
      Effect.map(Option.some),
      // A descriptor can disappear after enumeration; any other observation failure fails proof.
      Effect.catchIf(
        (error) => descriptorGone(error.cause),
        () => Effect.succeed(Option.none()),
      ),
    ),
  )
  return links.filter(Option.isSome).filter((link) => link.value === path).length
})

/** A separate real SDK handle is scoped too; it is used only to install malformed persisted input. */
const external = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => AgentFS.open({ path })),
    (fs) => Effect.tryPromise(() => fs.close()).pipe(Effect.ignore),
  )

const note = (file: string, description: string, body = 'The fact.') =>
  Note.make({ file: NoteFile.make(file), kind: 'preference', description, body })

describe('notes', () => {
  it.effect('keeps a note and reads it back whole', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const replaced = yield* notes.notes.write(
        notes.person,
        note(
          'mornings.md',
          'Ada wants meetings before noon',
          'Meetings before noon.\nWhy: she writes later.',
        ),
      )
      expect(replaced).toBe(false)
      const read = yield* notes.notes.read(notes.person, NoteFile.make('mornings.md'))
      expect(read).toEqual(
        note(
          'mornings.md',
          'Ada wants meetings before noon',
          'Meetings before noon.\nWhy: she writes later.',
        ),
      )
    }).pipe(Effect.scoped),
  )

  it.effect('replaces a note under the same file name instead of adding a second', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* notes.notes.write(notes.person, note('mornings.md', 'Meetings before noon'))
      const replaced = yield* notes.notes.write(
        notes.person,
        note('mornings.md', 'Meetings until 4pm'),
      )
      expect(replaced).toBe(true)
      const index = yield* notes.notes.index(notes.person)
      expect(index.lines.map((line) => line.description)).toEqual(['Meetings until 4pm'])
    }).pipe(Effect.scoped),
  )

  it.effect('deletes a note, and says so when there is none to delete or read', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* notes.notes.write(notes.person, note('gym.md', 'The gym is on Awolowo Road'))
      yield* notes.notes.delete(notes.person, NoteFile.make('gym.md'))
      expect((yield* notes.notes.index(notes.person)).lines).toEqual([])
      const again = yield* Effect.flip(notes.notes.delete(notes.person, NoteFile.make('gym.md')))
      expect(again._tag).toBe('NoteMissing')
      const read = yield* Effect.flip(notes.notes.read(notes.person, NoteFile.make('gym.md')))
      expect(read._tag).toBe('NoteMissing')
    }).pipe(Effect.scoped),
  )

  it.effect('keeps each Person’s notes in their own file', () =>
    Effect.gen(function* () {
      const ada = yield* store('ada')
      const dami = PersonId.make('dami')
      yield* ada.notes.write(ada.person, note('mornings.md', 'Ada wants meetings before noon'))
      expect((yield* ada.notes.index(dami)).lines).toEqual([])
      expect((yield* ada.notes.index(ada.person)).lines).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect('folds a description to one line so it cannot add a header field', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* notes.notes.write(
        notes.person,
        note('trick.md', 'A fact\nkind: decision\ndescription: forged'),
      )
      const index = yield* notes.notes.index(notes.person)
      expect(index.lines).toEqual([
        {
          file: 'trick.md',
          kind: 'preference',
          description: 'A fact kind: decision description: forged',
        },
      ])
    }).pipe(Effect.scoped),
  )

  it.effect('leaves a file that is not a note out of the index', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* notes.notes.write(notes.person, note('real.md', 'A real note'))
      // Written beside the notes by something other than Vivid: no header, so not a note.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* external(NodePath.join(notes.directory, 'ada.db'))
          yield* Effect.tryPromise(() => fs.fs.writeFile('/stray.md', 'just text'))
        }),
      )
      expect((yield* notes.notes.index(notes.person)).lines.map((line) => line.file)).toEqual([
        'real.md',
      ])
    }).pipe(Effect.scoped),
  )

  it.effect('stops the index at its budget and says older notes exist', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const long = 'x'.repeat(190)
      const count = 48
      for (let n = 0; n < count; n++)
        yield* notes.notes.write(notes.person, note(`note-${n}.md`, `${n} ${long}`.slice(0, 200)))
      const index = yield* notes.notes.index(notes.person)
      expect(index.more).toBe(true)
      expect(index.lines.length).toBeLessThan(count)
      expect(index.lines.length).toBeGreaterThan(30)
      // The documented 8,000-character allowance counts filenames and descriptions, not a count
      // of entries. Check the boundary independently so ignoring either field exceeds the budget.
      const used = index.lines.reduce(
        (sum, line) => sum + line.file.length + line.description.length,
        0,
      )
      expect(used).toBeLessThanOrEqual(8000)
      const remaining = 8000 - used
      expect(remaining).toBeLessThan(200)
    }).pipe(Effect.scoped),
  )

  it.effect('refuses a Person identifier that is not a plain identifier', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const failure = yield* Effect.flip(notes.notes.index(PersonId.make('../escape')))
      expect(failure._tag).toBe('NotesUnavailable')
    }).pipe(Effect.scoped),
  )
  it.effect('reuses a native handle and releases it when its idle lease expires', () =>
    Effect.gen(function* () {
      const fixture = yield* store('ada')
      const path = NodePath.join(fixture.directory, 'ada.db')
      yield* fixture.notes.write(fixture.person, note('kept.md', 'Kept'))
      const opened = yield* handles(path)
      expect(opened).toBeGreaterThan(0)
      yield* fixture.notes.read(fixture.person, NoteFile.make('kept.md'))
      expect(yield* handles(path)).toBe(opened)
      yield* TestClock.adjust('1 second')
      expect(yield* handles(path)).toBe(0)
      expect((yield* fixture.notes.read(fixture.person, NoteFile.make('kept.md'))).body).toBe(
        'The fact.',
      )
      expect(yield* handles(path)).toBe(opened)
    }),
  )

  it.effect('reports capacity separately and frees idle capacity without losing notes', () =>
    Effect.gen(function* () {
      const fixture = yield* store('ada')
      yield* fixture.notes.write(fixture.person, note('kept.md', 'Kept'))
      yield* fixture.notes.index(PersonId.make('dami'))
      const failure = yield* Effect.flip(fixture.notes.index(PersonId.make('third')))
      expect(failure).toBeInstanceOf(NotesAtCapacity)
      expect(yield* Effect.flip(fixture.notes.index(PersonId.make('../escape')))).toBeInstanceOf(
        NotesUnavailable,
      )
      yield* TestClock.adjust('1 second')
      expect((yield* fixture.notes.index(PersonId.make('third'))).lines).toEqual([])
      expect((yield* fixture.notes.read(fixture.person, NoteFile.make('kept.md'))).body).toBe(
        'The fact.',
      )
    }),
  )

  it.effect('does not cache a failed open or let it exhaust capacity', () =>
    Effect.gen(function* () {
      const parent = yield* directory
      const blocked = NodePath.join(parent, 'blocked')
      yield* Effect.tryPromise(() => NodeFSP.writeFile(blocked, 'not a directory'))
      const notes = yield* make(
        NotesSettings.make({ directory: blocked, capacity: 1, idle: Duration.minutes(1) }),
      )
      const person = PersonId.make('ada')
      const failures = yield* Effect.all(
        [Effect.flip(notes.index(person)), Effect.flip(notes.index(person))],
        { concurrency: 2 },
      )
      expect(failures.every((failure) => failure instanceof NotesUnavailable)).toBe(true)
      yield* Effect.tryPromise(() => NodeFSP.unlink(blocked))
      yield* notes.write(person, note('recovered.md', 'Recovered'))
      expect((yield* notes.index(person)).lines).toHaveLength(1)
      const openCount = yield* handles(NodePath.join(blocked, 'ada.db'))
      yield* notes.index(person)
      expect(yield* handles(NodePath.join(blocked, 'ada.db'))).toBe(openCount)
    }),
  )

  it.effect(
    'an abandoned failed open terminates its lookup and permits reuse before idle expiry',
    () =>
      Effect.gen(function* () {
        const path = yield* directory
        const owner = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
        const unavailable = yield* Deferred.make<void>()
        const mkdir = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(NodeFS.promises, 'mkdir')),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        mkdir.mockImplementationOnce(() => {
          // rc.116 Fiber.getCurrent is a public synchronous runtime seam. Capture the actual
          // RcMap lookup at its native receipt: reopen alone cannot detect its self-deadlock.
          const lookup = Fiber.getCurrent()
          if (lookup === undefined) expect.fail('mkdir must run inside the store lookup fiber')
          Deferred.doneUnsafe(entered, Effect.succeed(lookup))
          // This Promise boundary only holds the filesystem receipt; the next open is real SQLite.
          // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library, vivid/no-runpromise-nested
          return Effect.runPromise(
            Deferred.await(unavailable).pipe(
              Effect.andThen(Effect.fail(new Error('Test-controlled directory failure'))),
            ),
          )
        })
        const notes = yield* make(
          NotesSettings.make({ directory: path, capacity: 1, idle: Duration.minutes(1) }),
        ).pipe(Scope.provide(owner))
        // Release the receipt before the owner finalizer on assertion failure too.
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(unavailable, undefined).pipe(Effect.asVoid),
        )
        const person = PersonId.make('ada')
        const opening = yield* Effect.forkChild(notes.index(person))
        const lookup = yield* Deferred.await(entered)
        yield* Fiber.interrupt(opening)
        // No clock advancement: invalidation must release the failed entry without idle expiry.
        yield* Deferred.succeed(unavailable, undefined)
        expect(Exit.isFailure(yield* Fiber.await(lookup))).toBe(true)
        yield* notes.write(person, note('recovered.md', 'Recovered'))
        expect((yield* notes.index(person)).lines).toHaveLength(1)
        expect(mkdir).toHaveBeenCalledTimes(2)
        yield* Scope.close(owner, Exit.void)
        expect(yield* handles(NodePath.join(path, 'ada.db'))).toBe(0)
        expect(yield* Effect.flip(notes.index(person))).toBeInstanceOf(NotesUnavailable)
      }),
  )

  it.effect(
    'an expired failed lookup cannot invalidate a replacement store for the same Person',
    () =>
      Effect.gen(function* () {
        const path = yield* directory
        const entered = Latch.makeUnsafe()
        const unavailable = yield* Deferred.make<void>()
        const mkdir = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(NodeFS.promises, 'mkdir')),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        mkdir.mockImplementationOnce(() => {
          entered.openUnsafe()
          // Only this filesystem receipt is held. The replacement opens real AgentFS and SQLite;
          // no SDK method is replaced. This public Promise adapter owns test coordination only.
          // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library, vivid/no-runpromise-nested
          return Effect.runPromise(
            Deferred.await(unavailable).pipe(
              Effect.andThen(Effect.fail(new Error('Test-controlled directory failure'))),
            ),
          )
        })
        const notes = yield* make(
          NotesSettings.make({ directory: path, capacity: 1, idle: Duration.seconds(1) }),
        )
        // Registered after the owner: release the pending receipt before owner finalization can wait.
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(unavailable, undefined).pipe(Effect.asVoid),
        )
        const person = PersonId.make('ada')
        const opening = yield* Effect.forkChild(notes.index(person))
        yield* entered.await
        yield* Fiber.interrupt(opening)
        // Expiry removes the old key and interrupts its still-uninterruptible acquisition.
        yield* TestClock.adjust('1 second')
        yield* notes.write(person, note('kept.md', 'Kept'))
        expect(mkdir).toHaveBeenCalledTimes(2)
        yield* Deferred.succeed(unavailable, undefined)
        // The event-loop receipt settles the rejected native Promise and its Effect continuation.
        yield* Effect.tryPromise(() => NodeTimersPromises.setImmediate())
        expect((yield* notes.read(person, NoteFile.make('kept.md'))).body).toBe('The fact.')
        expect(mkdir).toHaveBeenCalledTimes(2)
        expect(yield* handles(NodePath.join(path, 'ada.db'))).toBe(1)
      }),
  )

  it.effect('owner close releases native handles and refuses retained service references', () =>
    Effect.gen(function* () {
      const path = yield* directory
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const notes = yield* make(
        NotesSettings.make({ directory: path, capacity: 2, idle: Duration.minutes(1) }),
      ).pipe(Scope.provide(owner))
      yield* notes.write(PersonId.make('ada'), note('kept.md', 'Kept'))
      yield* notes.index(PersonId.make('dami'))
      expect(yield* handles(NodePath.join(path, 'ada.db'))).toBeGreaterThan(0)
      yield* Scope.close(owner, Exit.void)
      expect(yield* handles(NodePath.join(path, 'ada.db'))).toBe(0)
      expect(yield* handles(NodePath.join(path, 'dami.db'))).toBe(0)
      expect(yield* Effect.flip(notes.index(PersonId.make('ada')))).toBeInstanceOf(NotesUnavailable)
    }),
  )

  it.effect('reads a multi-call index across idle time without closing its leased handle', () =>
    Effect.gen(function* () {
      const fixture = yield* store('ada')
      for (let index = 0; index < 5; index++)
        yield* fixture.notes.write(fixture.person, note(`kept-${index}.md`, 'Kept'))
      const entered = Latch.makeUnsafe()
      const normal = new Scheduler.MixedScheduler()
      let held = true
      let pending = Option.none<() => void>()
      // Pause only the read fiber at its first native receipt/cooperative yield. RcMap's idle
      // fiber and TestClock still use the normal scheduler. This controls scheduling, not SDK
      // behavior, so the store and every SQLite call are real and no method is replaced.
      const blocked = new Scheduler.MixedScheduler('async', (task) => {
        if (!held) return normal.setImmediate(task)
        pending = Option.some(task)
        entered.openUnsafe()
        return () => {
          pending = Option.none()
        }
      })
      let steps = 0
      const scheduler: Scheduler.Scheduler = {
        executionMode: 'async',
        // Native Promise receipts reset currentOpCount. Accumulate steps across them so the
        // read pauses after leasing and before completing, independent of I/O timing.
        shouldYield: (fiber) => (held ? ++steps >= 50 : normal.shouldYield(fiber)),
        makeDispatcher: () => blocked.makeDispatcher(),
      }
      const release = Effect.sync(() => {
        held = false
        const task = pending
        pending = Option.none()
        Option.match(task, { onNone: () => undefined, onSome: (resume) => resume() })
      })
      yield* Effect.addFinalizer(() => release)
      const reading = yield* Effect.forkChild(
        fixture.notes
          .index(fixture.person)
          .pipe(
            Effect.provideService(References.Scheduler, scheduler),
            Effect.provideService(References.PreventSchedulerYield, false),
          ),
        { startImmediately: true },
      )
      yield* entered.await
      yield* TestClock.adjust('2 seconds')
      expect(reading.pollUnsafe()).toBeUndefined()
      // Had the pause happened before leasing, the previous idle timer would have closed it.
      expect(yield* handles(NodePath.join(fixture.directory, 'ada.db'))).toBeGreaterThan(0)
      yield* fixture.notes.index(PersonId.make('dami'))
      expect(yield* Effect.flip(fixture.notes.index(PersonId.make('third')))).toBeInstanceOf(
        NotesAtCapacity,
      )
      yield* release
      expect((yield* Fiber.join(reading)).lines).toHaveLength(5)
      yield* TestClock.adjust('1 second')
      expect(yield* handles(NodePath.join(fixture.directory, 'ada.db'))).toBe(0)
    }),
  )
})
