import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { Effect, Option, Result, Semaphore } from 'effect'
import {
  EditTextEmpty,
  EditTextMissing,
  EditTextAmbiguous,
  SearchFailed,
  ToolDeadline,
} from './failure.ts'
import { ComputerSaid } from './sandbox.ts'
import * as v from 'valibot'
import { content, reading, shell } from './format.ts'
import type { Sandbox } from './sandbox.ts'
import { defineTool, executeCall, type ContentResult } from './tool.ts'

/** POSIX quoting keeps every pattern and path a single server-side shell argument. */
const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const string = (description: string) => v.pipe(v.string(), v.description(description))
const number = (description: string) => v.pipe(v.number(), v.description(description))

/** The Promise-only Computer adapter is unsafe ingress; domain orchestration keeps typed failures. */
const computerCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new ComputerSaid({
        message:
          cause instanceof Error ? cause.message : 'The Computer could not be reached. Try again.',
      }),
  })

/** Server Computer verbs select by acting Person. Share one queue across that Person's Threads
 * and resolved path aliases, while another Person's identical path stays independent. Keep an
 * in-flight mutation uninterruptible until the RPC settles: releasing early could lose edits. */
function mutations(sandbox: Sandbox) {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>()
  return Effect.fn('ComputerTool.mutate')(function* <A, E>(
    path: string,
    operation: Effect.Effect<A, E>,
  ) {
    const computer = yield* computerCall(() => sandbox.computer())
    const key = JSON.stringify([computer, sandbox.resolvePath(path)])
    return yield* Effect.suspend(() => {
      let lock = locks.get(key)
      if (lock === undefined) {
        lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        locks.set(key, lock)
      }
      const held = lock
      held.users += 1
      return held.semaphore
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              held.users -= 1
              if (held.users === 0) locks.delete(key)
            }),
          ),
        )
    }).pipe(Effect.uninterruptible)
  })
}

/** Main's exact-replacement semantics reject ambiguous regions and preserve literal `$` text. */
function replacement(
  text: string,
  change: { path: string; oldText: string; newText: string; replaceAll?: boolean },
): Result.Result<
  { text: string; result: ContentResult },
  EditTextEmpty | EditTextMissing | EditTextAmbiguous
> {
  const { path, oldText, newText } = change
  if (oldText === '')
    return Result.fail(new EditTextEmpty({ message: 'oldText must be a non-empty string.' }))
  const count = text.split(oldText).length - 1
  if (change.replaceAll === true) {
    const changed = text.replaceAll(oldText, () => newText)
    if (changed === text)
      return Result.fail(
        new EditTextMissing({
          path,
          message: `Could not find the text in ${path}. No changes made.`,
        }),
      )
    return Result.succeed({
      text: changed,
      result: content(`Replaced ${count} occurrences in ${path}`, { path, replacements: count }),
    })
  }
  if (count === 0)
    return Result.fail(
      new EditTextMissing({
        path,
        message: `Could not find the exact text in ${path}. Make sure your oldText matches exactly, including whitespace and indentation.`,
      }),
    )
  if (count > 1)
    return Result.fail(
      new EditTextAmbiguous({
        path,
        count,
        message: `Found ${count} occurrences of the text in ${path}. Provide more surrounding context to make the match unique, or use replaceAll.`,
      }),
    )
  return Result.succeed({
    text: text.replace(oldText, () => newText),
    result: content(`Successfully edited ${path}`, { path }),
  })
}

/** Keep main's six tools, names, schemas, ordering and result text. Pi's stock edit uses an edits
 * array and fuzzy matching, so these are owned adapters over the Person's server-backed Computer. */
export function machineTools(sandbox: Sandbox) {
  const mutate = mutations(sandbox)
  return [
    defineTool({
      name: 'read',
      description:
        'Read a file. Output is truncated to 2000 lines or 50KB; use offset/limit for large files.',
      input: v.object({
        path: string('Path to the file to read'),
        offset: v.optional(number('Line number to start from (1-indexed)')),
        limit: v.optional(number('Maximum number of lines to read')),
      }),
      run: ({ data }) =>
        Effect.gen(function* () {
          const text = yield* computerCall(() => sandbox.readFile(data.path))
          return yield* Effect.fromResult(
            reading(
              data.path,
              text,
              Option.fromUndefinedOr(data.offset),
              Option.fromUndefinedOr(data.limit),
            ),
          )
        }),
    }),
    defineTool({
      name: 'write',
      description:
        'Write content to a file. Creates the file and parent directories if they do not exist.',
      input: v.object({
        path: string('Path to the file to write'),
        content: string('Content to write to the file'),
      }),
      run: ({ data, signal }) =>
        mutate(
          data.path,
          Effect.gen(function* () {
            signal.throwIfAborted()
            yield* computerCall(() => sandbox.writeFile(data.path, data.content))
            return content(`Successfully wrote ${data.content.length} bytes to ${data.path}`, {
              path: data.path,
              size: data.content.length,
            })
          }),
        ),
    }),
    defineTool({
      name: 'edit',
      description:
        'Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences.',
      input: v.object({
        path: string('Path to the file to edit'),
        oldText: string('Exact text to find (must be unique)'),
        newText: string('Replacement text'),
        replaceAll: v.optional(v.pipe(v.boolean(), v.description('Replace all occurrences'))),
      }),
      run: ({ data, signal }) =>
        mutate(
          data.path,
          Effect.gen(function* () {
            signal.throwIfAborted()
            if (data.oldText === '')
              return yield* new EditTextEmpty({ message: 'oldText must be a non-empty string.' })
            const text = yield* computerCall(() => sandbox.readFile(data.path))
            signal.throwIfAborted()
            const changed = yield* Effect.fromResult(replacement(text, data))
            yield* computerCall(() => sandbox.writeFile(data.path, changed.text))
            return changed.result
          }),
        ),
    }),
    shellTool(sandbox),
    grepTool(sandbox),
    globTool(sandbox),
  ] as const
}

/** The server bounds shell deadlines; the runtime also cancels locally when the model supplied
 * a shorter one. An expired shell preserves the reference exit-124 result. */
function shellTool(sandbox: Sandbox) {
  return defineTool({
    name: 'bash',
    description:
      'Execute a bash command. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.',
    input: v.object({
      command: string('Bash command to execute'),
      timeout: v.optional(number('Timeout in seconds')),
    }),
    run: ({ data, signal }) => {
      const timeoutMs = data.timeout === undefined ? undefined : data.timeout * 1000
      const result = Effect.tryPromise({
        try: () =>
          executeCall(
            (shellSignal) => sandbox.exec(data.command, { signal: shellSignal, timeoutMs }),
            withAbortSignal(signal, BACKGROUND_CONTEXT),
            { name: 'bash', timeoutMs },
          ),
        catch: (cause) =>
          cause instanceof ToolDeadline
            ? cause
            : new ComputerSaid({
                message:
                  cause instanceof Error
                    ? cause.message
                    : 'The Computer could not be reached. Try again.',
              }),
      })
      return result.pipe(
        Effect.map((receipt) => shell(receipt, data.command)),
        Effect.catchTag('ToolDeadline', () =>
          Effect.succeed(
            shell(
              {
                stdout: '',
                stderr: `[vivid] Command timed out after ${data.timeout} seconds.`,
                exitCode: 124,
              },
              data.command,
            ),
          ),
        ),
      )
    },
  })
}

/** Probe the Computer used by this call. A fresh probe matches main's submission-local sandbox
 * and cannot retain another Computer's backend or remember an unreachable Computer as grep. */
function grepTool(sandbox: Sandbox) {
  return defineTool({
    name: 'grep',
    description:
      'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
    input: v.object({
      pattern: string('Search pattern (regex)'),
      path: v.optional(string('Directory or file to search (default: .)')),
      include: v.optional(string('Glob filter, e.g. "*.ts"')),
      literal: v.optional(v.pipe(v.boolean(), v.description('Match the pattern as literal text'))),
    }),
    run: ({ data, signal }) =>
      Effect.gen(function* () {
        const chosen = yield* computerCall(() =>
          executeCall(
            (probeSignal) =>
              sandbox.exec('rg --version', { timeoutMs: 10000, signal: probeSignal }),
            BACKGROUND_CONTEXT,
            { name: 'grep backend', timeoutMs: 15000 },
          ),
        ).pipe(
          Effect.map((result) => (result.exitCode === 0 ? ('rg' as const) : ('grep' as const))),
          // Main can still search with grep when the probe cannot answer. This call alone owns
          // that choice; the next call probes again, including after an unavailable Computer.
          Effect.catchTag('ComputerSaid', () => Effect.succeed('grep' as const)),
        )
        const path = data.path || '.'
        const include = data.include
          ? ` --${chosen === 'rg' ? 'glob' : 'include='}${chosen === 'rg' ? ' ' : ''}${word(data.include)}`
          : ''
        const prefix =
          chosen === 'rg'
            ? `rg --line-number --with-filename --color never${data.literal ? ' --fixed-strings' : ''}`
            : `grep -rnH ${data.literal ? '-F' : '-E'}`
        const result = yield* computerCall(() =>
          sandbox.exec(`${prefix}${include} -- ${word(data.pattern)} ${word(path)}`, { signal }),
        )
        return yield* Effect.fromResult(matches(result))
      }),
  })
}

/** Preserve main's match limits and distinguish no matches from a failed search. */
function matches(result: { stdout: string; stderr: string; exitCode: number }) {
  if (result.exitCode === 1 && !result.stdout.trim())
    return Result.succeed(content('No matches found.', { matchCount: 0 }))
  if (result.exitCode > 1)
    return Result.fail(new SearchFailed({ message: `grep failed: ${result.stderr}` }))
  const lines = result.stdout.trim().split('\n')
  let output = lines
    .slice(0, 100)
    .map((line) => (line.length > 500 ? `${line.slice(0, 500)}...` : line))
    .join('\n')
  if (lines.length > 100)
    output += `\n\n[Showing 100 of ${lines.length} matches. Narrow your search.]`
  return Result.succeed(content(output, { matchCount: Math.min(lines.length, 100) }))
}

/** find's basename semantics are main's contract, rather than a new glob engine on the host. */
function globTool(sandbox: Sandbox) {
  return defineTool({
    name: 'glob',
    description:
      'Find files by filename pattern using shell find -name semantics. Returns matching file paths.',
    input: v.object({
      pattern: string('Filename pattern, e.g. "*.ts"'),
      path: v.optional(string('Directory to search in (default: .)')),
    }),
    run: ({ data, signal }) =>
      Effect.gen(function* () {
        const result = yield* computerCall(() =>
          sandbox.exec(
            `find ${word(data.path || '.')} -type f -name ${word(data.pattern)} 2>/dev/null | head -1000`,
            { signal },
          ),
        )
        const paths = result.stdout.trim().split('\n').filter(Boolean)
        if ((result.exitCode !== 0 && !result.stdout.trim()) || paths.length === 0)
          return content('No files found matching pattern.', { matchCount: 0 })
        return content(paths.join('\n'), { matchCount: paths.length })
      }),
  })
}
