import { unusedMemory } from './tests/harness.ts'
import { describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import {
  ComputerFileReadOutcome,
  ComputerFileWriteOutcome,
  ComputerShellOutcome,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { computerSandbox, machineTools } from './sandbox.ts'
import { Scope, scopedRunner } from './scope.ts'
import schemas from './tests/schemas.json' with { type: 'json' }
import { tools as catalogue } from './index.ts'
import { roundTrip } from './tests/harness.ts'

/** The real generated RPC client observes every file/shell verb. Pi owns validation and durable
 * settlement; only server receipts are hand-answered. No local file or process is substituted. */
const fixture = Effect.fn('MachineTest.fixture')(function* (person: string) {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const layer = Layer.succeed(
    Scope,
    Scope.of({
      acting: {
        personId: PersonId.make(person),
        threadId: ThreadId.make('machine-thread'),
      },

      client: rpc.client,
      timezone: '',
    }),
  )
  /** Protocol exits are a test server adapter; VividRpc owns each request/response schema. */
  const reply = Effect.fn('MachineTest.reply')(function* (
    tag: string,
    payload: Schema.Json | { path: string; content: Uint8Array },
    outcome: ComputerFileReadOutcome | ComputerFileWriteOutcome | ComputerShellOutcome,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request.')
    expect(request.tag).toBe(tag)
    expect(request.payload).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit: Exit.succeed(outcome),
    })
  })
  return {
    tools: machineTools(computerSandbox(scopedRunner(layer), '/home/user')),
    reply,
    requests,
    layer,
    rpc,
  }
})

/** Completed shell receipts keep exit codes and stderr independent from the model's display. */
const command = (stdout: string) =>
  ComputerShellOutcome.cases.Completed.make({
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
  })

describe('Computer tools on Pi', () => {
  it.effect('reads, writes and edits relative paths on the Person’s Computer', () =>
    Effect.gen(function* () {
      const {
        tools: [read, write, edit],
        reply,
      } = yield* fixture('machine-person')
      const signal = yield* Effect.abortSignal
      const [readResult] = yield* Effect.all(
        [
          Effect.promise(() =>
            roundTrip(read, { path: './note.txt', offset: 2, limit: 1 }, signal),
          ),
          reply(
            'ComputerFileRead',
            { path: '/home/user/note.txt' },
            ComputerFileReadOutcome.cases.Read.make({
              content: new TextEncoder().encode('first\nsecond\nthird'),
            }),
          ),
        ],
        { concurrency: 2 },
      )
      expect(readResult.message.content).toEqual([{ type: 'text', text: 'second' }])
      expect(readResult.message.details).toEqual({ path: './note.txt', lines: 3 })
      const [writeResult] = yield* Effect.all(
        [
          Effect.promise(() =>
            roundTrip(write, { path: 'note.txt', content: 'hello world' }, signal),
          ),
          reply(
            'ComputerFileWrite',
            { path: '/home/user/note.txt', content: new TextEncoder().encode('hello world') },
            ComputerFileWriteOutcome.cases.Written.make({}),
          ),
        ],
        { concurrency: 2 },
      )
      expect(writeResult.message.content).toEqual([
        { type: 'text', text: 'Successfully wrote 11 bytes to note.txt' },
      ])
      const [editResult] = yield* Effect.all(
        [
          Effect.promise(() =>
            roundTrip(edit, { path: 'note.txt', oldText: 'world', newText: '$& friend' }, signal),
          ),
          Effect.gen(function* () {
            yield* reply(
              'ComputerFileRead',
              { path: '/home/user/note.txt' },
              ComputerFileReadOutcome.cases.Read.make({
                content: new TextEncoder().encode('hello world'),
              }),
            )
            yield* reply(
              'ComputerFileWrite',
              { path: '/home/user/note.txt', content: new TextEncoder().encode('hello $& friend') },
              ComputerFileWriteOutcome.cases.Written.make({}),
            )
          }),
        ],
        { concurrency: 2 },
      )
      expect(editResult.message.content).toEqual([
        { type: 'text', text: 'Successfully edited note.txt' },
      ])
    }),
  )

  it.effect('runs shell, grep and glob on the Computer without changing main’s vocabulary', () =>
    Effect.gen(function* () {
      const {
        tools: [, , , bash, grep, glob],
        reply,
      } = yield* fixture('machine-person')
      const signal = yield* Effect.abortSignal
      const [shellResult] = yield* Effect.all(
        [
          Effect.promise(() => roundTrip(bash, { command: 'printf hello', timeout: '30' }, signal)),
          reply(
            'ComputerShell',
            { command: 'printf hello', directory: '/home/user', timeoutSeconds: 30 },
            command('hello'),
          ),
        ],
        { concurrency: 2 },
      )
      expect(shellResult.message.content).toEqual([{ type: 'text', text: 'hello' }])
      const [grepResult] = yield* Effect.all(
        [
          Effect.promise(() =>
            roundTrip(grep, { pattern: 'hi', literal: true, include: '*.ts' }, signal),
          ),
          Effect.gen(function* () {
            yield* reply(
              'ComputerShell',
              { command: 'rg --version', directory: '/home/user', timeoutSeconds: 10 },
              command('ripgrep'),
            )
            yield* reply(
              'ComputerShell',
              {
                command:
                  "rg --line-number --with-filename --color never --fixed-strings --glob '*.ts' -- 'hi' '.'",
                directory: '/home/user',
                timeoutSeconds: 120,
              },
              command('a.ts:1:hi'),
            )
          }),
        ],
        { concurrency: 2 },
      )
      expect(grepResult.message.content).toEqual([{ type: 'text', text: 'a.ts:1:hi' }])
      expect(grepResult.message.details).toEqual({ matchCount: 1 })
      const [globResult] = yield* Effect.all(
        [
          Effect.promise(() => roundTrip(glob, { pattern: '*.ts' }, signal)),
          reply(
            'ComputerShell',
            {
              command: "find '.' -type f -name '*.ts' 2>/dev/null | head -1000",
              directory: '/home/user',
              timeoutSeconds: 120,
            },
            command('./a.ts\n'),
          ),
        ],
        { concurrency: 2 },
      )
      expect(globResult.message.content).toEqual([{ type: 'text', text: './a.ts' }])
      expect(globResult.message.details).toEqual({ matchCount: 1 })
    }),
  )
})

/** Model tool schemas and descriptions stay stable across runtime changes. */
it.effect('advertises main’s exact six schemas, descriptions and ordering', () =>
  Effect.gen(function* () {
    const { tools } = yield* fixture('machine-person')
    expect(
      tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ).toEqual(schemas)
  }),
)

it.effect('accepts read optional nulls after Pi normalization', () =>
  Effect.gen(function* () {
    const {
      tools: [read],
      reply,
    } = yield* fixture('machine-person')
    const signal = yield* Effect.abortSignal
    const [result] = yield* Effect.all(
      [
        Effect.promise(() => roundTrip(read, { path: 'a.txt', offset: null }, signal)),
        reply(
          'ComputerFileRead',
          { path: '/home/user/a.txt' },
          ComputerFileReadOutcome.cases.Read.make({ content: new TextEncoder().encode('hello') }),
        ),
      ],
      { concurrency: 2 },
    )
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.message.isError).toBe(false)
  }),
)

for (const scenario of [
  {
    oldText: 'missing',
    text: 'hello',
    replaceAll: false,
    message:
      'Could not find the exact text in a.txt. Make sure your oldText matches exactly, including whitespace and indentation.',
  },
  {
    oldText: 'hi',
    text: 'hi hi',
    replaceAll: false,
    message:
      'Found 2 occurrences of the text in a.txt. Provide more surrounding context to make the match unique, or use replaceAll.',
  },
  {
    oldText: 'missing',
    text: 'hello',
    replaceAll: true,
    message: 'Could not find the text in a.txt. No changes made.',
  },
]) {
  it.effect(`keeps plain edit refusal: ${scenario.message}`, () =>
    Effect.gen(function* () {
      const {
        tools: [, , edit],
        reply,
        requests,
      } = yield* fixture('machine-person')
      const signal = yield* Effect.abortSignal
      const [result] = yield* Effect.all(
        [
          Effect.promise(() =>
            roundTrip(
              edit,
              {
                path: 'a.txt',
                oldText: scenario.oldText,
                newText: 'new',
                replaceAll: scenario.replaceAll,
              },
              signal,
            ),
          ),
          reply(
            'ComputerFileRead',
            { path: '/home/user/a.txt' },
            ComputerFileReadOutcome.cases.Read.make({
              content: new TextEncoder().encode(scenario.text),
            }),
          ),
        ],
        { concurrency: 2 },
      )
      expect(result.message.isError).toBe(true)
      expect(result.message.content).toEqual([{ type: 'text', text: scenario.message }])
      expect(yield* Queue.size(requests)).toBe(0)
    }),
  )
}

it.effect('replaceAll writes literal replacement text once and reports the count', () =>
  Effect.gen(function* () {
    const {
      tools: [, , edit],
      reply,
    } = yield* fixture('machine-person')
    const signal = yield* Effect.abortSignal
    const [result] = yield* Effect.all(
      [
        Effect.promise(() =>
          roundTrip(
            edit,
            { path: 'a.txt', oldText: 'hi', newText: '$&', replaceAll: true },
            signal,
          ),
        ),
        Effect.gen(function* () {
          yield* reply(
            'ComputerFileRead',
            { path: '/home/user/a.txt' },
            ComputerFileReadOutcome.cases.Read.make({ content: new TextEncoder().encode('hi hi') }),
          )
          yield* reply(
            'ComputerFileWrite',
            { path: '/home/user/a.txt', content: new TextEncoder().encode('$& $&') },
            ComputerFileWriteOutcome.cases.Written.make({}),
          )
        }),
      ],
      { concurrency: 2 },
    )
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Replaced 2 occurrences in a.txt' },
    ])
    expect(result.message.details).toEqual({ path: 'a.txt', replacements: 2 })
  }),
)

it.effect('retries a file write only once after creating its Computer parent', () =>
  Effect.gen(function* () {
    const {
      tools: [, write],
      reply,
    } = yield* fixture('machine-person')
    const signal = yield* Effect.abortSignal
    const payload = { path: '/home/user/folder/a.txt', content: new TextEncoder().encode('hi') }
    const [result] = yield* Effect.all(
      [
        Effect.promise(() => roundTrip(write, { path: 'folder/a.txt', content: 'hi' }, signal)),
        Effect.gen(function* () {
          yield* reply(
            'ComputerFileWrite',
            payload,
            ComputerFileWriteOutcome.cases.Refused.make({ reason: 'No such directory' }),
          )
          yield* reply(
            'ComputerShell',
            {
              command: "mkdir -p -- '/home/user/folder'",
              directory: '/home/user',
              timeoutSeconds: 120,
            },
            command(''),
          )
          yield* reply(
            'ComputerFileWrite',
            payload,
            ComputerFileWriteOutcome.cases.Written.make({}),
          )
        }),
      ],
      { concurrency: 2 },
    )
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Successfully wrote 2 bytes to folder/a.txt' },
    ])
  }),
)

it.effect('does not remember a failed grep probe and preserves search failure text', () =>
  Effect.gen(function* () {
    const {
      tools: [, , , , grep],
      reply,
    } = yield* fixture('machine-person')
    const signal = yield* Effect.abortSignal
    for (const first of [true, false]) {
      const [result] = yield* Effect.all(
        [
          Effect.promise(() => roundTrip(grep, { pattern: 'hi' }, signal)),
          Effect.gen(function* () {
            yield* reply(
              'ComputerShell',
              { command: 'rg --version', directory: '/home/user', timeoutSeconds: 10 },
              first
                ? ComputerShellOutcome.cases.Unavailable.make({ reason: 'Computer asleep' })
                : command('rg'),
            )
            yield* reply(
              'ComputerShell',
              {
                command: first
                  ? "grep -rnH -E -- 'hi' '.'"
                  : "rg --line-number --with-filename --color never -- 'hi' '.'",
                directory: '/home/user',
                timeoutSeconds: 120,
              },
              first
                ? command('a.txt:1:hi')
                : ComputerShellOutcome.cases.Completed.make({
                    stdout: '',
                    stderr: 'bad pattern',
                    exitCode: 2,
                    timedOut: false,
                    truncated: false,
                  }),
            )
          }),
        ],
        { concurrency: 2 },
      )
      expect(result.message.content).toEqual([
        { type: 'text', text: first ? 'a.txt:1:hi' : 'grep failed: bad pattern' },
      ])
      expect(result.message.isError).toBe(!first)
    }
  }),
)

it.effect('caps grep at 100 matches and 500 characters per line', () =>
  Effect.gen(function* () {
    const {
      tools: [, , , , grep],
      reply,
    } = yield* fixture('machine-person')
    const signal = yield* Effect.abortSignal
    const line = 'x'.repeat(501)
    const [result] = yield* Effect.all(
      [
        Effect.promise(() => roundTrip(grep, { pattern: 'x' }, signal)),
        Effect.gen(function* () {
          yield* reply(
            'ComputerShell',
            { command: 'rg --version', directory: '/home/user', timeoutSeconds: 10 },
            command('rg'),
          )
          yield* reply(
            'ComputerShell',
            {
              command: "rg --line-number --with-filename --color never -- 'x' '.'",
              directory: '/home/user',
              timeoutSeconds: 120,
            },
            command(Array.from({ length: 101 }, () => line).join('\n')),
          )
        }),
      ],
      { concurrency: 2 },
    )
    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: `${Array.from({ length: 100 }, () => 'x'.repeat(500) + '...').join('\n')}\n\n[Showing 100 of 101 matches. Narrow your search.]`,
      },
    ])
    expect(result.message.details).toEqual({ matchCount: 100 })
  }),
)

/** Hold one Person's actual write RPC, then abort the Pi call without settling that RPC. The
 * second Person must finish the identical path before the first Computer answers anything. */
it.effect('keeps another Computer’s same-path mutation independent after cancellation', () =>
  Effect.gen(function* () {
    const ada = yield* fixture('mutation-ada')
    const dami = yield* fixture('mutation-dami')
    let calls = 0
    const definitions = catalogue(
      () => (++calls === 1 ? ada.layer : dami.layer),
      () => Effect.die('Unexpected memory authority'),
      unusedMemory,
      [],
    ).tools
    const write = definitions.find((tool) => tool.name === 'write')
    if (write === undefined) expect.fail('Missing write tool.')
    // @effect-diagnostics-next-line abortControllerInEffect:off -- This test cancels only Pi’s first submission while its own Effect and second submission remain live.
    const cancel = new AbortController()
    const first = yield* Effect.promise(() =>
      roundTrip(write, { path: './a.txt', content: 'A' }, cancel.signal),
    ).pipe(Effect.forkScoped)
    const pending = yield* Queue.take(ada.requests)
    if (!Predicate.isTagged(pending, 'Request')) expect.fail('Expected a write.')
    expect(pending.tag).toBe('ComputerFileWrite')
    cancel.abort()
    expect((yield* Fiber.join(first)).message.isError).toBe(true)
    const signal = yield* Effect.abortSignal
    const [second] = yield* Effect.all(
      [
        Effect.promise(() => roundTrip(write, { path: 'a.txt', content: 'B' }, signal)),
        dami.reply(
          'ComputerFileWrite',
          { path: '/home/user/a.txt', content: new TextEncoder().encode('B') },
          ComputerFileWriteOutcome.cases.Written.make({}),
        ),
      ],
      { concurrency: 2 },
    )
    expect(second.message.content).toEqual([
      { type: 'text', text: 'Successfully wrote 1 bytes to a.txt' },
    ])
    yield* ada.rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: pending.id,
      exit: Exit.succeed(ComputerFileWriteOutcome.cases.Written.make({})),
    })
  }),
)

/** One catalogue serves different Computers; successful backend probes must remain independent. */
it.effect('probes each Computer before choosing rg or grep', () =>
  Effect.gen(function* () {
    const ada = yield* fixture('grep-ada')
    const dami = yield* fixture('grep-dami')
    let calls = 0
    const definitions = catalogue(
      () => (++calls === 1 ? ada.layer : dami.layer),
      () => Effect.die('Unexpected memory authority'),
      unusedMemory,
      [],
    ).tools
    const grep = definitions.find((tool) => tool.name === 'grep')
    if (grep === undefined) expect.fail('Missing grep tool.')
    const signal = yield* Effect.abortSignal
    for (const [computer, available] of [
      [ada, true],
      [dami, false],
    ] as const) {
      const [result] = yield* Effect.all(
        [
          Effect.promise(() => roundTrip(grep, { pattern: 'hi' }, signal)),
          Effect.gen(function* () {
            yield* computer.reply(
              'ComputerShell',
              { command: 'rg --version', directory: '/home/user', timeoutSeconds: 10 },
              ComputerShellOutcome.cases.Completed.make({
                stdout: '',
                stderr: '',
                exitCode: available ? 0 : 127,
                timedOut: false,
                truncated: false,
              }),
            )
            yield* computer.reply(
              'ComputerShell',
              {
                command: available
                  ? "rg --line-number --with-filename --color never -- 'hi' '.'"
                  : "grep -rnH -E -- 'hi' '.'",
                directory: '/home/user',
                timeoutSeconds: 120,
              },
              command('a.txt:1:hi'),
            )
          }),
        ],
        { concurrency: 2 },
      )
      expect(result.message.content).toEqual([{ type: 'text', text: 'a.txt:1:hi' }])
    }
  }),
)

/** The shared deadline adapter uses a controllable timer. No Computer receipt is required for
 * the model's own deadline to settle with main's exit-124 text instead of a harness error. */
it.effect('returns exit 124 when the model’s own bash deadline expires', () =>
  Effect.gen(function* () {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()))
    const {
      tools: [, , , bash],
      requests,
    } = yield* fixture('deadline-person')
    const signal = yield* Effect.abortSignal
    const running = yield* Effect.promise(() =>
      roundTrip(bash, { command: 'slow', timeout: 30 }, signal),
    ).pipe(Effect.forkScoped)
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected shell RPC.')
    expect(request.payload).toEqual({
      command: 'slow',
      directory: '/home/user',
      timeoutSeconds: 30,
    })
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30000))
    const result = yield* Fiber.join(running)
    expect(result.message.isError).toBe(false)
    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: '[vivid] Command timed out after 30 seconds.\n\nCommand exited with code 124',
      },
    ])
    expect(result.message.details).toEqual({ command: 'slow', exitCode: 124 })
  }),
)

it.effect('refuses empty edit text before reading or writing the Computer', () =>
  Effect.gen(function* () {
    const {
      tools: [, , edit],
      requests,
    } = yield* fixture('empty-edit-person')
    const signal = yield* Effect.abortSignal
    const result = yield* Effect.promise(() =>
      roundTrip(edit, { path: 'a.txt', oldText: '', newText: 'hi' }, signal),
    )
    expect(result.message.isError).toBe(true)
    expect(result.message.content).toEqual([
      { type: 'text', text: 'oldText must be a non-empty string.' },
    ])
    expect(yield* Queue.size(requests)).toBe(0)
  }),
)

it.effect('preserves an unreachable Computer’s plain model-visible error', () =>
  Effect.gen(function* () {
    const {
      tools: [read],
      reply,
    } = yield* fixture('unavailable-person')
    const signal = yield* Effect.abortSignal
    const [result] = yield* Effect.all(
      [
        Effect.promise(() => roundTrip(read, { path: 'a.txt' }, signal)),
        reply(
          'ComputerFileRead',
          { path: '/home/user/a.txt' },
          ComputerFileReadOutcome.cases.Unavailable.make({
            reason: 'The Computer could not be reached. Try again.',
          }),
        ),
      ],
      { concurrency: 2 },
    )
    expect(result.message.isError).toBe(true)
    expect(result.message.content).toEqual([
      { type: 'text', text: 'The Computer could not be reached. Try again.' },
    ])
  }),
)
