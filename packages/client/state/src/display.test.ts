import { describe, expect, it } from 'vitest'
import { it as effectIt } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  ApprovalId,
  CodeFailure,
  CodeOutcome,
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  DisplayApprovalUnsupported,
  Forbidden,
  InvalidRequest,
  NotFound,
  RuntimeUnavailable,
  ServiceId,
  ServiceUnavailable,
  ThreadId,
  ToolOutcome,
  Unauthenticated,
} from '@vivid/contracts'
import { Effect, Exit, Fiber, Option, Predicate, Queue, Result, Schema } from 'effect'
import { VividRpc } from '@vivid/contracts/rpc'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import {
  callDisplayTool,
  displayCodeResult,
  displayToolAnswer,
  displayToolResult,
  DisplayThreadRequired,
  said,
  stretches,
  displayTools,
  DisplayProgramAmbiguous,
} from './display.ts'

const FENCE = '```'
const queries = displayTools({ mutationStatements: [], queryStatements: [] })

describe('a reply with displays in it', () => {
  it('is only words when it holds no display', () => {
    expect(stretches('Revenue is up 12%.')).toEqual([
      { kind: 'words', from: 0, text: 'Revenue is up 12%.' },
    ])
  })

  it('is words, the display between its fences, then the words after it', () => {
    const reply = `Here it is:\n\n${FENCE}openui-lang\nroot = Title("Hi")\n${FENCE}\n\nSay if it is wrong.`
    expect(stretches(reply)).toEqual([
      { kind: 'words', from: 0, text: 'Here it is:\n\n' },
      { kind: 'display', from: 13, text: 'root = Title("Hi")\n', whole: true },
      { kind: 'words', from: 50, text: '\n\nSay if it is wrong.' },
    ])
  })

  it('draws a display that is still arriving, and keeps its place when the rest lands', () => {
    const arriving = `Look:\n${FENCE}openui-lang\nroot = Col([a])\na = Tit`
    const [, early] = stretches(arriving)
    expect(early).toEqual({
      kind: 'display',
      from: 6,
      text: 'root = Col([a])\na = Tit',
      whole: false,
    })
    const [, late] = stretches(`${arriving}le("Hi")\n${FENCE}\nDone.`)
    expect(late).toEqual({
      kind: 'display',
      from: 6,
      text: 'root = Col([a])\na = Title("Hi")\n',
      whole: true,
    })
  })

  it('shows nothing of a fence line it is still in the middle of', () => {
    expect(stretches(`Look:\n${FENCE}openui`)).toEqual([{ kind: 'words', from: 0, text: 'Look:' }])
    expect(stretches(`Look:\n${FENCE}openui-lang`)).toEqual([
      { kind: 'words', from: 0, text: 'Look:' },
    ])
  })

  it('keeps each of two displays apart', () => {
    const reply = `${FENCE}openui-lang\nroot = Title("A")\n${FENCE}\n${FENCE}openui-lang\nroot = Title("B")\n${FENCE}`
    expect(stretches(reply).map((stretch) => stretch.text)).toEqual([
      'root = Title("A")\n',
      'root = Title("B")\n',
    ])
  })
})

describe('a program written the other ways OpenUI recognises', () => {
  it('draws a fence tagged openui', () => {
    const reply = `Here:\n${FENCE}openui\nroot = Title("Hi")\n${FENCE}\nDone.`
    expect(stretches(reply).map((stretch) => stretch.kind)).toEqual(['words', 'display', 'words'])
  })

  it('draws an untagged fence whose body is a program', () => {
    const reply = `Open slots:\n\n${FENCE}\nroot = Col([head], 2)\nhead = Title("Slots")\n${FENCE}\n\npick one`
    expect(stretches(reply)).toEqual([
      { kind: 'words', from: 0, text: 'Open slots:\n\n' },
      {
        kind: 'display',
        from: 13,
        text: 'root = Col([head], 2)\nhead = Title("Slots")\n',
        whole: true,
      },
      { kind: 'words', from: 64, text: '\n\npick one' },
    ])
  })

  it('leaves code in another language as words, even when it assigns root', () => {
    const reply = `Try:\n${FENCE}ts\nroot = 1\n${FENCE}\nThen run it.`
    expect(stretches(reply)).toEqual([{ kind: 'words', from: 0, text: reply }])
  })

  it('draws a bare program and the words after it', () => {
    const reply =
      'root = Col([head, slot1], 2)\nhead = Title("Open slots")\nslot1 = Card([Title("Wed"),\n  Text("9:00")], "soft")\n\ntell me the slot.'
    expect(stretches(reply)).toEqual([
      {
        kind: 'display',
        from: 0,
        text: 'root = Col([head, slot1], 2)\nhead = Title("Open slots")\nslot1 = Card([Title("Wed"),\n  Text("9:00")], "soft")\n',
        whole: true,
      },
      { kind: 'words', from: 109, text: '\ntell me the slot.' },
    ])
  })

  it('keeps a bare program arriving while a statement is still open', () => {
    expect(stretches('Here:\nroot = Col([a,')).toEqual([
      { kind: 'words', from: 0, text: 'Here:\n' },
      { kind: 'display', from: 6, text: 'root = Col([a,', whole: false },
    ])
  })
})

describe('a reply that only looks like a program', () => {
  it('is words when root is compared, not assigned', () => {
    expect(stretches('root == 1')).toEqual([{ kind: 'words', from: 0, text: 'root == 1' }])
  })

  it('leaves a fence with any other tag as words', () => {
    const reply = `${FENCE}json5\nroot = 1\n${FENCE}`
    expect(stretches(reply)).toEqual([{ kind: 'words', from: 0, text: reply }])
  })
})

describe('a program read as OpenUI reads it', () => {
  it('ignores brackets inside single-quoted strings', () => {
    expect(stretches("root = Text('Use ( here')\n\nDone.")).toEqual([
      { kind: 'display', from: 0, text: "root = Text('Use ( here')\n", whole: true },
      { kind: 'words', from: 26, text: '\nDone.' },
    ])
  })

  it('keeps a string that runs across lines in the program', () => {
    expect(stretches('root = Text("a\n(b")\nDone.').map((stretch) => stretch.kind)).toEqual([
      'display',
      'words',
    ])
  })

  it('keeps statements after a comment', () => {
    const [display] = stretches('root = Col([head])\n// title\nhead = Text("Hi")\n\nDone.')
    expect(display).toEqual({
      kind: 'display',
      from: 0,
      text: 'root = Col([head])\n// title\nhead = Text("Hi")\n',
      whole: true,
    })
  })

  it('does not close a fence on a fence line inside a string', () => {
    const reply = `${FENCE}openui-lang\nroot = Text("a\n${FENCE}\nb")\n${FENCE}\nDone.`
    expect(stretches(reply).map((stretch) => [stretch.kind, stretch.text])).toEqual([
      ['display', `root = Text("a\n${FENCE}\nb")\n`],
      ['words', '\nDone.'],
    ])
  })

  it('reads nothing inside a comment', () => {
    expect(
      stretches('root = Col([head])\n// The person\'s title (\nhead = Text("Hi")\n\nDone.').map(
        (stretch) => [stretch.kind, stretch.text],
      ),
    ).toEqual([
      ['display', 'root = Col([head])\n// The person\'s title (\nhead = Text("Hi")\n'],
      ['words', '\nDone.'],
    ])
  })

  it('closes a fence even when the program left a bracket open', () => {
    const reply = `${FENCE}openui-lang\nroot = Col([Text("Hi")\n${FENCE}\nDone.`
    expect(stretches(reply).map((stretch) => [stretch.kind, stretch.text])).toEqual([
      ['display', 'root = Col([Text("Hi")\n'],
      ['words', '\nDone.'],
    ])
  })

  it('keeps the branches of a ternary in a bare program', () => {
    const program = 'root = $show\n  ? Col([Text("A")])\n  : Col([Text("B")])\n$show = true\n'
    expect(stretches(`${program}\nDone.`).map((stretch) => stretch.text)).toEqual([
      program,
      '\nDone.',
    ])
  })

  it('keeps a ternary whose operators end their lines', () => {
    const program = 'root = $show ?\n  Col([Text("A")]) :\n  Col([Text("B")])\n$show = true\n'
    expect(stretches(`${program}\nDone.`).map((stretch) => stretch.text)).toEqual([
      program,
      '\nDone.',
    ])
  })

  it('draws an indented bare program', () => {
    expect(stretches('  root = Title("Hi")')).toEqual([
      { kind: 'display', from: 0, text: '  root = Title("Hi")', whole: true },
    ])
  })
})

describe('what a press says', () => {
  it('is the Button’s words alone when no form was filled', () => {
    expect(said('Book Arik Air at 7:10', { $flight: 'Arik Air at 7:10' })).toBe(
      'Book Arik Air at 7:10',
    )
  })

  it('adds each filled field as a line and skips empty and unticked ones', () => {
    const state = {
      $pace: 'Relaxed',
      trip: {
        city: { value: 'Abuja', componentType: 'Input' },
        nights: { value: 2, componentType: 'Input' },
        notes: { value: '  ', componentType: 'TextArea' },
        window: { value: true, componentType: 'Checkbox' },
        late: { value: false, componentType: 'Checkbox' },
      },
    }
    expect(said('Plan my trip', state)).toBe('Plan my trip\ncity: Abuja\nnights: 2\nwindow: yes')
  })
})

/** The generated RPC client exercises real request routing; only server answers are hand-supplied. */
const displayTransport = Effect.fn('Test.displayTransport')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  return { requests, rpc }
})

describe('programs in a display', () => {
  const thread = ThreadId.make('the-displays-thread')
  const request = { code: 'return {count: 3}', summary: 'Count the records' }
  const completed = CodeOutcome.cases.Completed.make({
    result: { count: 3 },
    calls: [],
    truncated: false,
    logs: ['private log'],
    logsTruncated: false,
  })

  for (const kind of ['Query', 'Mutation'] as const) {
    effectIt.effect(
      `routes a ${kind} program with its own Thread and unwraps only its return value`,
      () =>
        Effect.gen(function* () {
          const { rpc, requests } = yield* displayTransport()
          const tools = displayTools({
            queryStatements: [],
            mutationStatements:
              kind === 'Mutation' ? [{ toolAST: { k: 'Str', v: 'run_code' } }] : [],
          })
          const running = yield* callDisplayTool(
            'run_code',
            Option.some(request),
            tools,
            Option.some(thread),
          ).pipe(Effect.provideService(VividRpcClient, rpc.client), Effect.forkScoped)
          const sent = yield* Queue.take(requests)
          if (!Predicate.isTagged(sent, 'Request')) return yield* Effect.die('Expected RPC request')
          expect(sent.tag).toBe('RunDisplayCode')
          expect(sent.payload).toEqual({ ...request, thread, kind })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor.
            _tag: 'Exit',
            clientId: 0,
            requestId: sent.id,
            exit: Exit.succeed(completed),
          })
          expect(yield* Fiber.join(running)).toEqual({
            content: [{ type: 'text', text: '{"count":3}' }],
            structuredContent: { count: 3 },
          })
        }),
    )
  }

  effectIt.effect('refuses a program without a Thread before sending either RPC', () =>
    Effect.gen(function* () {
      const { rpc, requests } = yield* displayTransport()
      const answer = yield* Effect.result(
        callDisplayTool('run_code', Option.some(request), queries, Option.none()),
      ).pipe(Effect.provideService(VividRpcClient, rpc.client))
      expect(displayToolAnswer(answer)).toEqual({
        content: [{ type: 'text', text: 'Open this display in its Thread to run the program.' }],
        isError: true,
      })
      expect(yield* Queue.size(requests)).toBe(0)
    }),
  )

  for (const toolAST of [
    { k: 'Str', v: 'run_code' },
    { k: 'Ref', v: '$operation' },
  ] as const) {
    effectIt.effect(`refuses mixed program intent before RPC when a Query names ${toolAST.k}`, () =>
      Effect.gen(function* () {
        const { rpc, requests } = yield* displayTransport()
        const tools = displayTools({
          queryStatements: [{ toolAST }],
          mutationStatements: [{ toolAST: { k: 'Str', v: 'run_code' } }],
        })
        const answered = yield* Effect.result(
          callDisplayTool('run_code', Option.some(request), tools, Option.some(thread)),
        ).pipe(Effect.provideService(VividRpcClient, rpc.client))
        expect(displayToolAnswer(answered)).toEqual({
          content: [
            {
              type: 'text',
              text: 'This display mixes automatic programs with button actions. Ask Vivid to use separate displays.',
            },
          ],
          isError: true,
        })
        expect(yield* Queue.size(requests)).toBe(0)
      }),
    )
  }

  effectIt.effect('refuses invalid program arguments before sending either RPC', () =>
    Effect.gen(function* () {
      const { rpc, requests } = yield* displayTransport()
      const answer = yield* Effect.result(
        callDisplayTool('run_code', Option.some({ code: 4 }), queries, Option.some(thread)),
      ).pipe(Effect.provideService(VividRpcClient, rpc.client))
      expect(displayToolAnswer(answer)).toEqual({
        content: [
          { type: 'text', text: 'This display sent invalid information. Ask Vivid to fix it.' },
        ],
        isError: true,
      })
      expect(yield* Queue.size(requests)).toBe(0)
    }),
  )

  effectIt.effect('keeps Integration calls on their existing RPC without requiring a Thread', () =>
    Effect.gen(function* () {
      const { rpc, requests } = yield* displayTransport()
      const running = yield* callDisplayTool(
        'read@Work',
        Option.some({ limit: 2 }),
        queries,
        Option.none(),
      ).pipe(Effect.provideService(VividRpcClient, rpc.client), Effect.forkScoped)
      const sent = yield* Queue.take(requests)
      if (!Predicate.isTagged(sent, 'Request')) return yield* Effect.die('Expected RPC request')
      expect(sent.tag).toBe('UseDisplayTool')
      expect(sent.payload).toEqual({ name: 'read@Work', input: { limit: 2 }, kind: 'Query' })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor.
        _tag: 'Exit',
        clientId: 0,
        requestId: sent.id,
        exit: Exit.succeed(ToolOutcome.cases.Completed.make({ output: [1, 2] })),
      })
      expect((yield* Fiber.join(running)).structuredContent).toEqual([1, 2])
    }),
  )
})

const decodeString = Schema.decodeUnknownResult(Schema.String)

describe('display errors', () => {
  const privateMessage = 'private-id credential-secret tool connection agent'
  const approvalId = ApprovalId.make('private-approval')
  const schemaFailure = Result.match(decodeString(42), {
    onSuccess: () => new DisplayThreadRequired({}),
    onFailure: (failure) => failure,
  })
  const failures = [
    [
      new NotFound({ message: privateMessage }),
      'This Thread or Integration is no longer available to you.',
    ],
    [new Forbidden({ message: privateMessage }), 'You do not have permission to run this display.'],
    [new Unauthenticated({ message: privateMessage }), 'Sign in again to use this display.'],
    [
      new Conflict({ message: privateMessage }),
      'The Integration changed. Refresh this display and try again.',
    ],
    [
      new InvalidRequest({ message: privateMessage }),
      'This display sent a request Vivid could not accept.',
    ],
    [
      new RuntimeUnavailable({ message: privateMessage }),
      'Vivid is unavailable. Try again shortly.',
    ],
    [
      new ServiceUnavailable({ service: 'connections', message: privateMessage }),
      'The Integration is unavailable. Try again shortly.',
    ],
    [
      new ServiceUnavailable({ service: 'computer', message: privateMessage }),
      'Your Computer is unavailable. Open it and try again.',
    ],
    [
      new ServiceUnavailable({ service: 'memory', message: privateMessage }),
      'Vivid could not read its memory. Try again shortly.',
    ],
    [
      new DatabaseUnavailable({ message: privateMessage }),
      'Vivid could not read the saved information. Try again shortly.',
    ],
    [
      new DatabaseFailure({ message: privateMessage }),
      'Vivid could not read the saved information. Try again shortly.',
    ],
    [
      new DatabaseConstraintViolation({ message: privateMessage }),
      'The saved information changed. Refresh and try again.',
    ],
    [
      new DisplayApprovalUnsupported({}),
      'This Integration needs an approval Vivid cannot provide yet.',
    ],
    [new DisplayThreadRequired({}), 'Open this display in its Thread to run the program.'],
    [
      new DisplayProgramAmbiguous({}),
      'This display mixes automatic programs with button actions. Ask Vivid to use separate displays.',
    ],
    [schemaFailure, 'This display sent invalid information. Ask Vivid to fix it.'],
    [
      new RpcClientError({
        reason: new RpcClientDefect({ message: privateMessage, cause: privateMessage }),
      }),
      'Vivid could not be reached. Check your internet and try again.',
    ],
  ] as const
  it.each(failures)(
    'preserves a readable RPC refusal for %s without private payloads',
    (failure, message) => {
      expect(displayToolAnswer(Result.fail(failure))).toEqual({
        content: [{ type: 'text', text: message }],
        isError: true,
      })
    },
  )

  const outcomes = [
    [
      ToolOutcome.cases.Rejected.make({ message: privateMessage }),
      'The Integration rejected this request. Check the information and try again.',
    ],
    [ToolOutcome.cases.Blocked.make({ rule: privateMessage }), 'A rule prevents this action.'],
    [
      ToolOutcome.cases.ApprovalRequired.make({ approvalId, summary: privateMessage }),
      'This needs your approval in the Thread.',
    ],
    [
      ToolOutcome.cases.ConnectionNotReady.make({
        service: ServiceId.make('private-service'),
        serviceName: privateMessage,
      }),
      'This Integration needs to be connected again.',
    ],
    [
      ToolOutcome.cases.OutcomeUnknown.make({}),
      'No answer came back. It may or may not have happened.',
    ],
  ] as const
  it.each(outcomes)('reports an Integration %s as an OpenUI error', (outcome, message) => {
    expect(displayToolResult(outcome)).toEqual({
      content: [{ type: 'text', text: message }],
      isError: true,
    })
  })

  const codeFailures = [
    [
      CodeFailure.cases.Threw.make({ message: privateMessage }),
      'The program failed. Ask Vivid to fix it.',
    ],
    [
      CodeFailure.cases.TimedOut.make({ seconds: 300 }),
      'The program took too long and was stopped.',
    ],
    [
      CodeFailure.cases.Unavailable.make({}),
      'Your Computer is unavailable. Open it and try again.',
    ],
    ...(['memory', 'calls', 'data', 'result'] as const).map(
      (limit) =>
        [
          CodeFailure.cases.OverLimit.make({ limit }),
          `The program exceeded its ${limit} limit. Ask Vivid to do less at once.`,
        ] as const,
    ),
  ] as const
  it.each(codeFailures)('reports program failure %s', (failure, message) => {
    expect(
      displayCodeResult(
        CodeOutcome.cases.Failed.make({
          failure,
          calls: [],
          logs: [privateMessage],
          logsTruncated: false,
        }),
      ),
    ).toEqual({ content: [{ type: 'text', text: message }], isError: true })
  })

  it.each([
    [
      CodeOutcome.cases.Blocked.make({ rule: privateMessage, calls: [] }),
      'A rule prevents this action.',
    ],
    [
      CodeOutcome.cases.ApprovalRequired.make({ approvalId, summary: privateMessage, calls: [] }),
      'This needs your approval in the Thread.',
    ],
    [
      CodeOutcome.cases.OutcomeUnknown.make({ calls: [] }),
      'No answer came back. It may or may not have happened.',
    ],
  ] as const)('reports program decision %s', (outcome, message) => {
    expect(displayCodeResult(outcome)).toEqual({
      content: [{ type: 'text', text: message }],
      isError: true,
    })
  })
})
