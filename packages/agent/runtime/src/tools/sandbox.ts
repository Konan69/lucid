import * as NodePath from 'node:path'
export { machineTools } from './machine.ts'
import {
  type PersonId,
  ComputerFileReadOutcome,
  ComputerFileWriteOutcome,
  ComputerShellOutcome,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { warnFailure } from './result.ts'
import { Scope, type RunScoped } from './scope.ts'

/** Carries the Computer's words that the model must read verbatim at the Pi sandbox boundary. */
export class ComputerSaid extends Schema.TaggedError<ComputerSaid>()(
  'ComputerSaid',
  {
    message: Schema.String,
  },
  { title: 'The Computer’s response' },
) {}

/** Where Vivid's commands start and relative paths resolve: the home of the Computer's user. Boat
 * names that user `user` on every machine (its SSH key call answers `sshUser: "user"`). */
export const COMPUTER_HOME = '/home/user'
/** A command the model gives no deadline. Pi's `bash` passes one only when the model asks. */
const DEFAULT_SECONDS = 120
/** The longest one call waits (`ComputerShellRequest`). Longer work is started in the background. */
const LONGEST_SECONDS = 600

const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * A Computer that could not be used, said in the runtime's log before the model is told.
 *
 * These verbs answer Pi by throwing, which no other log sees: on 6 October 2026 the Computer
 * refused every command for seven hours and this log held nothing about it. A refusal by the
 * machine's own file system (no such file, not permitted) is an ordinary answer and is not logged.
 */
const unusable = (verb: string, tag: string, reason: string) =>
  warnFailure(verb, tag).pipe(Effect.andThen(Effect.fail(new ComputerSaid({ message: reason }))))

/** Environment for one command, as assignments before it: names are checked, values are quoted. */
const assignments = (env: Readonly<Record<string, string>>) =>
  Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${word(value)}\n`)
    .join('')

/** Every verb reaches the acting Person's Computer through the server RPC. Paths and deadlines
 * keep main's meanings, and server refusal text remains the model's error. Tool construction
 * performs no workspace discovery or RPC, so a conversation never wakes a sleeping Computer. */
export function computerSandbox(run: RunScoped, home: string): Sandbox {
  const shell: ComputerDriver['exec'] = (command, options = {}) => {
    const { timeoutMs, cwd, env, signal } = options
    const seconds = timeoutMs === undefined ? DEFAULT_SECONDS : Math.ceil(timeoutMs / 1000)
    return run(
      Effect.gen(function* () {
        const { client } = yield* Scope
        const outcome = yield* client.ComputerShell({
          command: (env === undefined ? '' : assignments(env)) + command,
          directory: cwd === undefined ? home : cwd,
          timeoutSeconds: Math.min(Math.max(seconds, 1), LONGEST_SECONDS),
        })
        return yield* ComputerShellOutcome.match(outcome, {
          Completed: (done) => {
            // Pi's contract: a deadline is exit code 124 with the reason on stderr, and zero
            // only for a command that clearly succeeded.
            if (done.timedOut)
              return Effect.succeed({
                stdout: done.stdout,
                stderr: `${done.stderr}\nThe command was ended after ${seconds} seconds.`,
                exitCode: 124,
              })
            if (done.exitCode === null)
              return Effect.succeed({
                stdout: done.stdout,
                stderr: `${done.stderr}\nThe command was ended by a signal.`,
                exitCode: 137,
              })
            return Effect.succeed({
              stdout: done.stdout,
              stderr: done.stderr,
              exitCode: done.exitCode,
            })
          },
          Unavailable: ({ reason }) => unusable('bash', 'Unavailable', reason),
          OutcomeUnknown: () =>
            unusable(
              'bash',
              'OutcomeUnknown',
              'The connection to the Computer was lost while the command ran. It may have run: check before running it again.',
            ),
        })
      }),
      Option.fromUndefinedOr(signal),
    )
  }
  const bytes = (path: string) =>
    run(
      Effect.gen(function* () {
        const { client } = yield* Scope
        const outcome = yield* client.ComputerFileRead({ path })
        return yield* ComputerFileReadOutcome.match(outcome, {
          Read: ({ content }) => Effect.succeed(content),
          Refused: ({ reason }) => Effect.fail(new ComputerSaid({ message: `${path}: ${reason}` })),
          Unavailable: ({ reason }) => unusable('read', 'Unavailable', reason),
        })
      }),
      Option.none(),
    )
  const driver: ComputerDriver = {
    exec: shell,
    readFile: (path) => bytes(path).then((content) => new TextDecoder().decode(content)),
    writeFile: (path, content) =>
      run(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const outcome = yield* client.ComputerFileWrite({
            path,
            content: content instanceof Uint8Array ? content : new TextEncoder().encode(content),
          })
          return yield* ComputerFileWriteOutcome.match(outcome, {
            Written: () => Effect.void,
            Refused: ({ reason }) =>
              Effect.fail(new ComputerSaid({ message: `${path}: ${reason}` })),
            Unavailable: ({ reason }) => unusable('write', 'Unavailable', reason),
          })
        }),
        Option.none(),
      ),
    // Parent creation stays on the Computer, through the same scoped shell RPC.
    // The options are annotated because the type checker (tsc-rs 0.1.0, as TypeScript 7.1's
    // nightlies since 23 Sep 2026, microsoft/TypeScript pull request 64043) reports TS7031 for a
    // destructured element missing from a `= {}` default even where `ComputerDriver` types it.
    mkdir: (path, { recursive }: { recursive?: boolean } = {}) =>
      shell(`mkdir ${recursive === true ? '-p ' : ''}-- ${word(path)}`).then(checked),
  }
  return {
    ...fromDriver(driver, home),
    // The server's Computer verbs select the machine by the acting Person, never by a path or
    // Thread. The same Person across Threads therefore shares a mutation queue; others do not.
    computer: () =>
      run(
        Effect.map(Scope, ({ acting }) => acting.personId),
        Option.none(),
      ),
  }
}

/** A file command that failed says why on its error stream. */
const checked = (result: { readonly exitCode: number; readonly stderr: string }) => {
  if (result.exitCode !== 0) throw new ComputerSaid({ message: result.stderr.trim() })
}

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}
interface ShellOptions {
  readonly timeoutMs?: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}
interface ComputerDriver {
  readonly exec: (command: string, options?: ShellOptions) => Promise<ShellResult>
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, content: string | Uint8Array) => Promise<void>
  readonly mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>
}
export interface Sandbox extends Omit<ComputerDriver, 'mkdir'> {
  readonly computer: () => Promise<PersonId>
  readonly cwd: string
  readonly resolvePath: (path: string) => string
}

/** Relative paths and mutations stay on the server's Computer. Preserve main's lazy parent
 * creation and single retry; no host filesystem or process is ever used by this adapter. */
function fromDriver(driver: ComputerDriver, home: string): Omit<Sandbox, 'computer'> {
  const resolvePath = (path: string) => NodePath.posix.resolve(home, path)
  return {
    cwd: home,
    resolvePath,
    exec: (command, options: ShellOptions = {}) =>
      driver.exec(command, {
        ...options,
        cwd: options.cwd === undefined ? home : resolvePath(options.cwd),
      }),
    readFile: (path) => driver.readFile(resolvePath(path)),
    writeFile: (path, content) => {
      const resolved = resolvePath(path)
      return driver.writeFile(resolved, content).catch(() =>
        driver
          .mkdir(NodePath.posix.dirname(resolved), { recursive: true })
          .catch(() => undefined)
          .then(() => driver.writeFile(resolved, content)),
      )
    },
  }
}
