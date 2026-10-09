import * as NodeWorkerThreads from 'node:worker_threads'
import { CodeCallKind, CodeFailure } from '@vivid/contracts/code'
import { Effect, Fiber, Option, type Schema } from 'effect'
import { budgets } from './budgets.ts'
import { Program, Tool, toolRefusal } from './interpreter/index.ts'
import { encodedSize } from './interpreter/work.ts'
import { boundedLogs } from './logs.ts'
import { decodeJson, decodeParent, encodeWorker, ParentMessage, WorkerMessage } from './protocol.ts'

/**
 * The thread one program is interpreted on. `runner.ts` starts it and is its only peer.
 *
 * It holds nothing of the server: no database, no credentials, no Person. A tool call is a
 * message to the supervisor, which checks it as the Person and answers; the program waits for
 * the answer. Everything the supervisor reports about the program (receipts, decisions, the
 * deadline) it decides itself: this thread only says what the program asked for and how it ended.
 */
const port = NodeWorkerThreads.parentPort
const waiting = new Map<number, (value: Schema.Json) => void>()
const printed: string[] = []
const calls = { next: 0 }
const running = { program: Option.none<Fiber.Fiber<void>>() }

/** One message to the supervisor. A thread started by anything else has nobody to tell. */
const say = (message: WorkerMessage) =>
  encodeWorker(message).pipe(
    Effect.map((text) => {
      if (port !== null) port.postMessage(text)
    }),
    // A message that cannot be written is a result that is not JSON; the program has no result.
    Effect.ignore,
  )

/** What the program printed so far, within its allowance. */
const logs = () => boundedLogs(printed, budgets.logs, false)

/**
 * One of the program's tools. The call is numbered and sent, and the effect completes when its
 * answer arrives. It never completes when the supervisor decides the program is over (a limit, an
 * Approval, a block, an unknown outcome): no answer is sent, and the thread is ended instead.
 */
const tool = (kind: CodeCallKind) =>
  Tool.make({
    description: kind,
    // The arguments are checked where each call is checked as the Person (`calls.ts`).
    input: { type: 'object' },
    run: (input) =>
      Effect.gen(function* () {
        // Measured before it is written or sent: arguments past what one call may carry end the
        // program here, and the supervisor's thread never holds them. The effect then never
        // completes, so a `catch` in the program cannot carry it past its limit.
        if (encodedSize(input, budgets.frame) > budgets.frame) {
          yield* failed(CodeFailure.cases.OverLimit.make({ limit: 'data' }))
          return yield* Effect.never
        }
        // `undefined` has no JSON form; a program that passes nothing passes null.
        const text = JSON.stringify(input === undefined ? null : input)
        const arguments_ = yield* decodeJson(text).pipe(
          Effect.mapError(() => toolRefusal('Tool arguments must be JSON.')),
        )
        const id = ++calls.next
        yield* say(WorkerMessage.cases.Call.make({ id, kind, input: arguments_ }))
        return yield* Effect.callback<Schema.Json>((resume) => {
          waiting.set(id, (value) => resume(Effect.succeed(value)))
          // The program stopped waiting (a lost Promise.race); the answer, if one comes, is dropped.
          return Effect.sync(() => waiting.delete(id))
        })
      }),
  })

/** The program's own fault: the model reads the message and writes a better program. */
const threw = (diagnostic: Program.Diagnostic) =>
  CodeFailure.cases.Threw.make({ message: diagnostic.message.slice(0, 500) })

/**
 * Why the interpreter stopped a program, in the words of the contract. Every kind of diagnostic
 * is named, so a kind the interpreter gains has no entry here and fails typecheck.
 */
const failures: Record<Program.DiagnosticKind, (diagnostic: Program.Diagnostic) => CodeFailure> = {
  TimeoutExceeded: () => CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds }),
  WorkLimitExceeded: () => CodeFailure.cases.OverLimit.make({ limit: 'work' }),
  ToolCallLimitExceeded: () => CodeFailure.cases.OverLimit.make({ limit: 'calls' }),
  ParseError: threw,
  UnsupportedSyntax: threw,
  UnknownTool: threw,
  InvalidToolInput: threw,
  InvalidToolOutput: threw,
  InvalidDataValue: threw,
  ToolFailure: threw,
  ExecutionFailure: threw,
}

/** The final message of a program that has no result, with what it printed. */
const failed = (failure: CodeFailure) => {
  const kept = logs()
  return say(
    WorkerMessage.cases.Failed.make({
      failure,
      logs: kept.logs,
      logsTruncated: kept.logsTruncated,
    }),
  )
}

/**
 * Interprets the program and says how it ended. The deadline is the supervisor's: it orders the
 * stop, so no timeout is set here. The result is measured before it is written, so a program
 * cannot make this thread write, or the supervisor read, more than a result may be.
 */
const interpret = Effect.fn('Code.interpret')(function* (code: string) {
  const result = yield* Program.execute({
    code,
    logs: printed,
    tools: {
      find_tools: tool('find_tools'),
      use_tool: tool('use_tool'),
      browse: tool('browse'),
      read_page: tool('read_page'),
    },
    limits: { maxSteps: budgets.steps, maxGrowth: budgets.growth, maxToolCalls: budgets.calls },
  })
  if (!result.ok) return yield* failed(failures[result.error.kind](result.error))
  if (encodedSize(result.value, budgets.result) > budgets.result)
    return yield* failed(CodeFailure.cases.OverLimit.make({ limit: 'result' }))
  const kept = logs()
  return yield* say(
    WorkerMessage.cases.Done.make({
      result: result.value,
      logs: kept.logs,
      logsTruncated: kept.logsTruncated,
    }),
  )
})

/**
 * Starts the program once and remembers its fiber, so that an order to stop can interrupt it. A
 * second Start is ignored: one thread runs one program.
 */
const start = Effect.fn('Code.start')(function* (code: string) {
  if (Option.isSome(running.program)) return
  running.program = Option.some(yield* Effect.forkDetach(interpret(code)))
})

/** The supervisor keeps its own reason for stopping; this returns what was printed so far. */
const cancel = Effect.fn('Code.cancel')(function* () {
  if (Option.isSome(running.program)) yield* Fiber.interrupt(running.program.value)
  return yield* failed(CodeFailure.cases.Unavailable.make({}))
})

/** The supervisor's three messages. Text that is not one of them is ignored. */
const receive = Effect.fn('Code.receive')(function* (text: string) {
  const message = yield* decodeParent(text)
  return yield* ParentMessage.match(message, {
    Start: ({ code }) => start(code),
    Reply: ({ id, value }) =>
      Effect.sync(() => {
        const answer = waiting.get(id)
        waiting.delete(id)
        if (answer !== undefined) answer(value)
      }),
    Cancel: () => cancel(),
  })
})

if (port !== null)
  port.on('message', (text: string) => {
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- This file is the thread's entry point: a message from the supervisor is where its Effects start.
    Effect.runFork(Effect.ignore(receive(text)))
  })
