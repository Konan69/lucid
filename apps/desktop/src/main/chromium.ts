import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeStream from 'node:stream'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  BrowserState,
  Page,
  PageFavicon,
  PageLoadFailure,
  PageUnavailable,
  ShowingTab,
  Tab,
  UsedTab,
} from '../shared/pages.ts'
import {
  PageGone,
  StepFailed,
  type CommandParameters,
  type ControlledBrowser,
  type ControlledPage,
} from './control.ts'

/**
 * A real Chromium for the executor's live proof (`control.live.test.ts`): one browser the test
 * starts and stops, and pages in it that the executor acts on through Chromium's own debugger
 * protocol. It is never bundled into the app; only test files import it, like `fake.ts`.
 *
 * In the app the debugger is Electron's (`driver.ts`, `contents.debugger.sendCommand`). Here the
 * same commands go to a headless Chromium over its debugging pipe: `--remote-debugging-pipe`,
 * commands written to file descriptor 3 and answers read from 4, each one JSON text ended by a
 * zero byte. A pipe needs no port and no address, and it belongs to the process that was started.
 */

/** Chromium could not be started, or stopped answering; `said` is the end of what it printed. */
export class ChromiumFailed extends Schema.TaggedError<ChromiumFailed>()(
  'ChromiumFailed',
  { step: Schema.String, said: Schema.String },
  { title: 'Chromium could not be used' },
) {}
/** Chromium refused one command. */
class CommandRefused extends Schema.TaggedError<CommandRefused>()(
  'CommandRefused',
  { method: Schema.String },
  { title: 'Chromium refused the command' },
) {}
/** The Chromium process has ended, so no command will be answered. */
class ChromiumGone extends Schema.TaggedError<ChromiumGone>()(
  'ChromiumGone',
  {},
  { title: 'Chromium has ended' },
) {}

/** A command Chromium refused: `{ id, error }`. */
const Refusal = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({ message: Schema.String }),
})
/** Something that happened in a page, told without being asked: `{ method, params }`. */
const Happening = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})
/** The answer to a command: `{ id, result }`. */
const Answer = Schema.Struct({ id: Schema.Int, result: Schema.Unknown })
/**
 * One message from Chromium. The three are told apart by the key only one of them has, in this
 * order: `error`, then `method`, and what is left is an answer.
 */
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Refusal, Happening, Answer])),
)

/** A page finished loading the document a navigation started; the two share `loaderId`. */
const isLoaded = Schema.is(
  Schema.Struct({
    method: Schema.Literal('Page.lifecycleEvent'),
    params: Schema.Struct({ loaderId: Schema.String, name: Schema.Literal('load') }),
  }),
)
const decodeCreated = Schema.decodeUnknownEffect(Schema.Struct({ targetId: Schema.String }))
const decodeAttached = Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String }))
const decodeNavigated = Schema.decodeUnknownEffect(Schema.Struct({ loaderId: Schema.String }))
const decodeNamed = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      value: Schema.Struct({ title: Schema.String, address: Schema.String }),
    }),
  }),
)

/** How much of what Chromium printed is kept for a failure to show. */
const SAID_LENGTH = 4096
/**
 * How long Chromium is given to end after it was asked to. It ends in well under a second; one
 * that has not is killed.
 */
const CLOSING = '5 seconds'

/**
 * The arguments Chromium is started with.
 *
 * `--no-sandbox`: the machines this proof runs on do not all let Chromium build its sandbox (a
 * container, or a root user, cannot), and without the flag Chromium refuses to start there. The
 * only documents it is given are the proof's own, written in the test, and those load nothing from
 * a network. Chromium's own background requests (it makes some when it starts) are not turned off.
 */
const argumentsFor = (profile: string) => [
  '--headless=new',
  '--remote-debugging-pipe',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  'about:blank',
]

/** The process that was started, before its pipe is known to be there. */
interface Spawned {
  readonly child: NodeChildProcess.ChildProcess
  /** The end of what Chromium printed to its error output, or why it could not be started. */
  readonly said: { text: string }
  /**
   * Runs `then` when the process has ended or could not be started at all; at once when it
   * already has. Answers with how to stop waiting.
   */
  readonly whenEnded: (then: () => void) => () => void
}

/** The started process and its two pipe ends. */
interface Started extends Spawned {
  readonly commands: NodeStream.Writable
  readonly answers: NodeStream.Readable
}

/** Starts the process and keeps what it prints. Nothing is waited for here. */
const spawn = (executable: string, profile: string): Spawned => {
  const child = NodeChildProcess.spawn(executable, argumentsFor(profile), {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })
  const said = { text: '' }
  const say = (text: string) => {
    said.text = (said.text + text).slice(-SAID_LENGTH)
  }
  let over = false
  const waiting = new Set<() => void>()
  const end = () => {
    over = true
    for (const then of waiting) then()
    waiting.clear()
  }
  child.once('exit', end)
  // An executable that cannot be started has no exit, only this.
  child.once('error', (cause) => {
    say(String(cause))
    end()
  })
  const whenEnded = (then: () => void) => {
    if (over) then()
    else waiting.add(then)
    return () => waiting.delete(then)
  }
  const errors = child.stdio[2]
  if (errors instanceof NodeStream.Readable)
    errors.on('data', (chunk: Buffer) => say(chunk.toString()))
  return { child, said, whenEnded }
}

/**
 * Ends the process that was started, and waits for it to be gone.
 *
 * Only this process is ever stopped: the one `spawn` returned, through its own handle. It is asked
 * to close first (`Browser.close`), which lets its helper processes end with it; if it has not
 * ended in `CLOSING` it is killed, and its exit is waited for either way.
 */
const stop = Effect.fn('Chromium.stop')(function* (spawned: Spawned) {
  const ended = Effect.callback<void>((resume) =>
    Effect.sync(spawned.whenEnded(() => resume(Effect.void))),
  )
  yield* Effect.sync(() => {
    const commands = spawned.child.stdio[3]
    if (!(commands instanceof NodeStream.Writable)) return
    // A pipe whose other end has gone reports it here; the exit below is what is waited for.
    commands.once('error', () => {})
    commands.end(`${JSON.stringify({ id: 0, method: 'Browser.close' })}\0`)
  })
  const closed = yield* ended.pipe(Effect.timeoutOption(CLOSING))
  if (Option.isSome(closed)) return
  yield* Effect.sync(() => spawned.child.kill('SIGKILL'))
  yield* ended
})

/** Starts Chromium and, when the scope closes, ends it and waits until it has ended. */
const start = Effect.fn('Chromium.start')(function* (executable: string, profile: string) {
  const spawned = yield* Effect.acquireRelease(
    Effect.sync(() => spawn(executable, profile)),
    stop,
  )
  const [, , , commands, answers] = spawned.child.stdio
  if (!(commands instanceof NodeStream.Writable) || !(answers instanceof NodeStream.Readable))
    return yield* new ChromiumFailed({ step: 'pipe', said: spawned.said.text })
  const started: Started = { ...spawned, commands, answers }
  return started
})

/** One command not yet answered: what it was, and how its wait ends. */
interface Asked {
  readonly method: string
  readonly resume: (answer: Effect.Effect<unknown, CommandRefused | ChromiumGone>) => void
}

/** What is waiting for Chromium: the commands not yet answered, and who is watching happenings. */
interface Waiting {
  readonly asked: Map<number, Asked>
  readonly watchers: Set<(happening: typeof Happening.Type) => void>
  /** Every happening so far, so one that came before it was waited for is still found. */
  readonly happened: Array<typeof Happening.Type>
  gone: boolean
  next: number
}

/** Hands one message from Chromium to whoever waits for it. */
const receive = (started: Started, waiting: Waiting, text: string) => {
  const message = decodeMessage(text)
  if (Option.isNone(message)) {
    // Not ignored in silence: a failure that follows shows it with what Chromium printed.
    started.said.text += '\n(a message from Chromium could not be read)'
    return
  }
  const given = message.value
  if ('method' in given) {
    waiting.happened.push(given)
    for (const watcher of waiting.watchers) watcher(given)
    return
  }
  const asked = waiting.asked.get(given.id)
  waiting.asked.delete(given.id)
  if (asked === undefined) return
  if ('error' in given)
    return asked.resume(Effect.fail(new CommandRefused({ method: asked.method })))
  return asked.resume(Effect.succeed(given.result))
}

/**
 * Reads Chromium's answers off its pipe and hands each to whoever waits for it. The process
 * ending answers every command still waiting, so nothing waits on a Chromium that is gone.
 */
const listen = (started: Started): Waiting => {
  const waiting: Waiting = {
    asked: new Map(),
    watchers: new Set(),
    happened: [],
    gone: false,
    next: 1,
  }
  let unread = ''
  started.answers.setEncoding('utf8')
  started.answers.on('data', (chunk: string) => {
    const text = unread + chunk
    // Each message ends with a zero byte; what follows the last one is a message still arriving.
    const end = text.lastIndexOf('\0')
    unread = text.slice(end + 1)
    if (end === -1) return
    for (const each of text.slice(0, end).split('\0')) receive(started, waiting, each)
  })
  // A pipe whose other end has gone reports it here; the process ending is what is acted on.
  started.commands.on('error', () => {})
  started.whenEnded(() => {
    waiting.gone = true
    const asked = [...waiting.asked.values()]
    waiting.asked.clear()
    for (const each of asked) each.resume(Effect.fail(new ChromiumGone({})))
  })
  return waiting
}

/** Where a command goes: the browser itself, or one page's own session. */
type Receiver = Option.Option<string>

/** One command, and its answer. Stopping the wait forgets the command; Chromium still has it. */
const command = (
  started: Started,
  waiting: Waiting,
  receiver: Receiver,
  sent: { readonly method: string; readonly parameters: CommandParameters },
) =>
  Effect.callback<unknown, CommandRefused | ChromiumGone>((resume) => {
    if (waiting.gone) return resume(Effect.fail(new ChromiumGone({})))
    const id = waiting.next++
    waiting.asked.set(id, { method: sent.method, resume })
    const message = { id, method: sent.method, params: sent.parameters }
    const addressed = Option.match(receiver, {
      onNone: () => message,
      onSome: (sessionId) => ({ ...message, sessionId }),
    })
    started.commands.write(`${JSON.stringify(addressed)}\0`)
    return Effect.sync(() => waiting.asked.delete(id))
  })

/**
 * Waits for a happening, whether it already came or is still to come. Chromium ending first is a
 * failure, so a page that will never load is not waited for.
 */
const happening = (
  started: Started,
  waiting: Waiting,
  wanted: (happening: typeof Happening.Type) => boolean,
) =>
  Effect.callback<void, ChromiumGone>((resume) => {
    if (waiting.happened.some(wanted)) return resume(Effect.void)
    const watcher = (given: typeof Happening.Type) => {
      if (!wanted(given)) return
      waiting.watchers.delete(watcher)
      resume(Effect.void)
    }
    waiting.watchers.add(watcher)
    const unwatch = started.whenEnded(() => resume(Effect.fail(new ChromiumGone({}))))
    return Effect.sync(() => {
      waiting.watchers.delete(watcher)
      unwatch()
    })
  })

/** One page of the started Chromium, as the executor uses it and as a proof measures it. */
export interface ChromiumPage {
  /** A Browser holding this one page, in front. */
  readonly browser: ControlledBrowser
  /** One debugger command on the page, outside the executor: how a proof looks at the page. */
  readonly send: ControlledPage['send']
}

/**
 * A page that never navigates has no tab row, no history and nowhere else to go: every request
 * to the Browser other than acting on the page is refused, not answered as if it had been done.
 */
const noOtherPages = Effect.fail(new PageUnavailable({}))

/**
 * The executor's `ControlledPage` over a real page.
 *
 * `send` is the real thing: the command goes to Chromium and its answer comes back undecoded, as
 * in `driver.ts`. What this page does not have is an app around it:
 * - `focus` gives the keyboard to the page inside the app's window (`driver.ts`, `keyboard`). A
 *   headless page has no window and nothing else holds the keyboard, so there is nothing to take
 *   or give back. That step is proved in real Electron (`driver.live.test.ts`), not here.
 * - `capture` is refused: the proof takes no picture.
 * - `settle` returns at once: the proof's documents are loaded before the executor is given them
 *   and never navigate.
 */
const controlled = (tab: Tab, send: ControlledPage['send']): ControlledPage => ({
  tab,
  send,
  focus: Effect.succeed(Effect.void),
  capture: Effect.fail(new StepFailed({ step: 'capture' })),
  settle: Effect.void,
})

/**
 * Starts a headless Chromium from `executable` for as long as the scope is open, and answers with
 * how to open a page in it. Its profile is a directory of its own under the system's temporary
 * directory, removed after the process has ended.
 */
export const chromium = Effect.fn('Chromium.make')(function* (executable: string) {
  const profile = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-chromium-'))),
    (directory) =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  )
  const started = yield* start(executable, profile)
  const waiting = listen(started)
  /** A command that must work for the proof to mean anything; its failure shows what Chromium said. */
  const must = (receiver: Receiver, method: string, parameters: CommandParameters) =>
    command(started, waiting, receiver, { method, parameters }).pipe(
      Effect.mapError(() => new ChromiumFailed({ step: method, said: started.said.text })),
    )
  const failing = (step: string) =>
    Effect.mapError(() => new ChromiumFailed({ step, said: started.said.text }))

  /**
   * Opens a new page on this document and waits until it has loaded. The first answer here is also
   * the receipt that Chromium started and is listening.
   *
   * A page has no release of its own. Every page lives in the one process `start` owns, and that
   * process ending (`stop`: `Browser.close`, then a kill after `CLOSING`) is what closes them all.
   * A `Target.closeTarget` here would run before `stop`, with no time limit, so a Chromium that
   * has stopped answering would hold the scope open and `stop` would never get to end it.
   *
   * The same three domains are enabled as in the app (`driver.ts`, `initialise`).
   */
  const open = Effect.fn('Chromium.open')(function* (html: string) {
    const browser: Receiver = Option.none()
    const { targetId } = yield* must(browser, 'Target.createTarget', { url: 'about:blank' }).pipe(
      Effect.flatMap((created) => decodeCreated(created).pipe(failing('Target.createTarget'))),
    )
    const { sessionId } = yield* must(browser, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    }).pipe(
      Effect.flatMap((attached) => decodeAttached(attached).pipe(failing('Target.attachToTarget'))),
    )
    const page: Receiver = Option.some(sessionId)
    for (const method of ['Runtime.enable', 'Accessibility.enable', 'Page.enable'])
      yield* must(page, method, {})
    yield* must(page, 'Page.setLifecycleEventsEnabled', { enabled: true })
    const { loaderId } = yield* must(page, 'Page.navigate', {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    }).pipe(
      Effect.flatMap((navigated) => decodeNavigated(navigated).pipe(failing('Page.navigate'))),
    )
    yield* happening(
      started,
      waiting,
      (given) => isLoaded(given) && given.params.loaderId === loaderId,
    ).pipe(failing('Page.lifecycleEvent'))
    const named = yield* must(page, 'Runtime.evaluate', {
      expression: '({ title: document.title, address: location.href })',
      returnByValue: true,
    }).pipe(Effect.flatMap((answer) => decodeNamed(answer).pipe(failing('Runtime.evaluate'))))

    const tab = Tab.make(NodeCrypto.randomUUID())
    const state = BrowserState.make({
      revision: 0,
      tabs: [
        Page.make({
          tab,
          address: named.result.value.address,
          title: named.result.value.title,
          favicon: PageFavicon.cases.None.make({}),
          loading: false,
          canGoBack: false,
          canGoForward: false,
          failed: PageLoadFailure.cases.None.make({}),
        }),
      ],
      showing: ShowingTab.cases.Some.make({ value: tab }),
      using: UsedTab.cases.None.make({}),
    })
    const send: ControlledPage['send'] = (method, parameters) =>
      command(started, waiting, page, { method, parameters }).pipe(
        Effect.catchTags({
          ChromiumGone: () => Effect.fail(new PageGone({})),
          CommandRefused: () => Effect.fail(new StepFailed({ step: method })),
        }),
      )
    const opened: ChromiumPage = {
      browser: {
        state: () => state,
        page: (asked) =>
          asked === tab ? Effect.succeed(controlled(tab, send)) : Effect.fail(new PageGone({})),
        request: () => noOtherPages,
        visit: () => noOtherPages,
        refused: () => false,
      },
      send,
    }
    return opened
  })

  return { open }
})
