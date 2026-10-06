import {
  SandboxOperationUnsupportedError,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  sandboxFromDriver,
  type Sandbox,
  type SandboxDriver,
  type ShellResult,
} from '@flue/runtime'
import {
  ComputerFileReadOutcome,
  ComputerFileWriteOutcome,
  ComputerShellOutcome,
} from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { warnFailure } from './result.ts'
import { Scope, type RunScoped } from './scope.ts'

/** Where Vivid's commands start and relative paths resolve: the home of the Computer's user. Boat
 * names that user `user` on every machine (its SSH key call answers `sshUser: "user"`). */
export const COMPUTER_HOME = '/home/user'
/** A command the model gives no deadline. Flue's `bash` passes one only when the model asks. */
const DEFAULT_SECONDS = 120
/** The longest one call waits (`ComputerShellRequest`). Longer work is started in the background. */
const LONGEST_SECONDS = 600

const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * A Computer that could not be used, said in the runtime's log before the model is told.
 *
 * These verbs answer Flue by throwing, which no other log sees: on 6 October 2026 the Computer
 * refused every command for seven hours and this log held nothing about it. A refusal by the
 * machine's own file system (no such file, not permitted) is an ordinary answer and is not logged.
 */
const unusable = (verb: string, tag: string, reason: string) =>
  warnFailure(verb, tag).pipe(Effect.andThen(Effect.fail(new Error(reason))))

/** Environment for one command, as assignments before it: names are checked, values are quoted. */
const assignments = (env: Readonly<Record<string, string>>) =>
  Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${word(value)}\n`)
    .join('')

/**
 * Flue's machine slot filled with the acting Person's real Computer.
 *
 * Each verb is one call to the server, which holds the SSH connection to the machine
 * (`apps/server/src/computers/ssh`). The server injects whose Computer it is from the call's
 * authority; nothing here names a Person or a machine. A refusal comes back as a sentence and is
 * thrown, because Flue shows a thrown message to the model as the tool's error.
 *
 * Three verbs are deliberately not answered from the machine: `exists`, `stat` and `readdir`.
 * Flue 2.2.2 calls them only to discover a workspace when a conversation starts and when it
 * compacts (`discoverSessionContext` in its `context.ts`: `AGENTS.md`, `CLAUDE.md`,
 * `.agents/skills`, then a listing of the working directory). Its six model tools never call them
 * (`createReadTool` and the rest use `readFile`, `writeFile`, `exec` and `resolvePath` only).
 * Answering discovery from the machine would wake a sleeping Computer for every conversation,
 * put whatever file is in its home directory into Vivid's instructions, and stop every
 * conversation if a skill directory there had the name of one of Vivid's own skills (Flue throws
 * on that collision at start). So discovery finds no workspace: `exists` says no, and the two
 * that may refuse do. Vivid lists and inspects files with `bash`, as a person does.
 *
 * `home` is where commands start and relative paths resolve: `COMPUTER_HOME` on a Computer.
 */
export function computerSandbox(run: RunScoped, home: string): Sandbox {
  const unsupported = (operation: string) =>
    Promise.reject(
      new SandboxOperationUnsupportedError({
        operation,
        provider: 'Vivid Computer',
        options: ['workspace discovery; use a command to list or inspect files'],
      }),
    )
  const shell: SandboxDriver['exec'] = (command, options = {}) => {
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
        return yield* ComputerShellOutcome.match<Effect.Effect<ShellResult, Error>>(outcome, {
          Completed: (done) => {
            // Flue's contract: a deadline is exit code 124 with the reason on stderr, and zero
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
        return yield* ComputerFileReadOutcome.match<Effect.Effect<Uint8Array, Error>>(outcome, {
          Read: ({ content }) => Effect.succeed(content),
          Refused: ({ reason }) => Effect.fail(new Error(`${path}: ${reason}`)),
          Unavailable: ({ reason }) => unusable('read', 'Unavailable', reason),
        })
      }),
      Option.none(),
    )
  const driver: SandboxDriver = {
    exec: shell,
    readFileBuffer: bytes,
    readFile: (path) => bytes(path).then((content) => new TextDecoder().decode(content)),
    writeFile: (path, content) =>
      run(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const outcome = yield* client.ComputerFileWrite({
            path,
            content: content instanceof Uint8Array ? content : new TextEncoder().encode(content),
          })
          return yield* ComputerFileWriteOutcome.match<Effect.Effect<void, Error>>(outcome, {
            Written: () => Effect.void,
            Refused: ({ reason }) => Effect.fail(new Error(`${path}: ${reason}`)),
            Unavailable: ({ reason }) => unusable('write', 'Unavailable', reason),
          })
        }),
        Option.none(),
      ),
    exists: () => Promise.resolve(false),
    stat: () => unsupported('stat'),
    readdir: () => unsupported('readdir'),
    // The machine's own `mkdir` and `rm`: their flags mean what Node's options mean (Flue
    // reference, "SandboxDriver": an adapter that runs verbs through the shell does these there).
    mkdir: (path, { recursive } = {}) =>
      shell(`mkdir ${recursive === true ? '-p ' : ''}-- ${word(path)}`).then(checked),
    rm: (path, { recursive, force } = {}) =>
      shell(
        `rm ${recursive === true ? '-r ' : ''}${force === true ? '-f ' : ''}-- ${word(path)}`,
      ).then(checked),
  }
  return sandboxFromDriver(driver, home)
}

/** A file command that failed says why on its error stream. */
const checked = (result: { readonly exitCode: number; readonly stderr: string }) => {
  if (result.exitCode !== 0) throw new Error(result.stderr.trim())
}

/** Flue's own six tools, built on the sandbox Flue hands back (it carries Flue's skill-file
 * overlay on `readFile`). The public constructor types keep TypeBox internals out of our
 * declaration imports. They are Flue's code and words unchanged. */
export const machineTools = (
  sandbox: Sandbox,
): readonly [
  ReturnType<typeof createReadTool>,
  ReturnType<typeof createWriteTool>,
  ReturnType<typeof createEditTool>,
  ReturnType<typeof createBashTool>,
  ReturnType<typeof createGrepTool>,
  ReturnType<typeof createGlobTool>,
] => [
  createReadTool(sandbox),
  createWriteTool(sandbox),
  createEditTool(sandbox),
  createBashTool(sandbox),
  createGrepTool(sandbox),
  createGlobTool(sandbox),
]
