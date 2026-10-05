import { defineTool } from '@flue/runtime'
import { BrowserAction, CodeFailure, CodeOutcome, ReadPageOutcome } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { CodeTiming, CodeToolTimeout } from '@vivid/contracts/code'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { warnFailure, type ToolResult } from './result.ts'
import * as views from './views.ts'

/** The calls a program can make as the Person, with human account names and no Vivid ownership
 * arguments. Everything else it has is the Computer it runs on. */
const PROGRAM = `Run a JavaScript async function body on your Computer (top-level await and return work). Return JSON; lines printed with console.log are returned too. It runs under Node 24 there: await import("node:fs/promises") and other Node modules work, and so do the Computer's files and network. Variables do not last to the next program; files on the Computer do. Limits: 16 KiB source, ${CodeTiming.seconds} seconds total including the Computer waking, 100 calls, 256 KiB per call/result, 4 MiB data, 32 KiB final result. Approval, a blocking rule or an unknown action ends the program; calls already started finish and completed calls stay completed. Never replay it to resume. A failure of Unavailable means the Computer could not be used just now (it did not start, or the Person is using it): say so and do not try again in a loop.
The callable API (TypeScript declarations describe JavaScript inputs):
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
declare const tools: {
find_tools(input: {query: string, limit?: number}): Promise<{tools: {account: string, tool: string, description: string, effect: "read" | "write" | "destructive", call: string, signature: string}[], unconnected: {service: string, description: string}[]}>;
use_tool(input: {account: string, tool: string, input: Json, summary: string, rationale: string}): Promise<{ok: true, output: Json} | {ok: false, reason: string}>;
run_command(input: {command: string, summary: string, timeoutSeconds?: number}): Promise<{ok: true, result: {exitCode: number, output: string, truncated: boolean}} | {ok: false, reason: string}>;
browse(input: {action: BrowserAction, summary: string}): Promise<{ok: true, result: {title: string, outline: string, truncated: boolean}} | {ok: false, reason: string}>;
read_page(input: {address: string}): Promise<{ok: true, address: string, title: string, text: string, truncated: boolean} | {ok: false, reason: string}>;
};
declare const accounts: {[account: string]: {[tool: string]: (input: Json, about: {summary: string, rationale: string}) => Promise<{ok: true, output: Json} | {ok: false, reason: string}>}};
BrowserAction is defined by this JSON Schema: ${JSON.stringify(Schema.toJsonSchemaDocument(BrowserAction).schema)}
Find first: find_tools returns each tool's call expression and its TypeScript signature. Call a tool exactly as its call says, for example await accounts["Work Gmail"].send_email({to, subject, body}, {summary, rationale}). Calls started together run together: use Promise.all for independent calls and pass one call's result into the next for dependent ones. Use only accounts and tools that find_tools returned. Provider record identifiers remain usable data. Do not catch an approval to continue or retry an unknown action.`

/** Error metadata is Vivid's; provider records in successful results retain their usable identifiers. */
function failureView(failure: CodeFailure): Schema.Json {
  return CodeFailure.match<Schema.Json>(failure, {
    Threw: ({ message }) => CodeFailure.cases.Threw.make({ message: views.modelText(message) }),
    TimedOut: () => failure,
    OverLimit: () => failure,
    Unavailable: () => failure,
  })
}

/** Parent receipts expose completed/uncertain work; the existing Approval card remains top-level. */
export function codeOutcome(outcome: CodeOutcome): ToolResult {
  const calls = outcome.calls.map(({ kind, summary: purpose, end }) => ({
    kind,
    summary: views.modelText(purpose),
    end,
  }))
  return CodeOutcome.match<ToolResult>(outcome, {
    Completed: ({ result, truncated, logs, logsTruncated }) => ({
      output: { ok: true, result, calls, truncated, logs, logsTruncated },
    }),
    ApprovalRequired: ({ approvalId, summary: purpose }) => ({
      output: { ...views.approval({ approvalId, summary: purpose }), calls },
      terminate: true,
    }),
    Blocked: ({ rule }) => ({
      output: { ok: false, rule: views.modelText(rule), calls },
      terminate: true,
    }),
    Failed: ({ failure, logs, logsTruncated }) => ({
      output: { ok: false, failure: failureView(failure), calls, logs, logsTruncated },
    }),
    OutcomeUnknown: () => ({
      output: {
        ok: false,
        calls,
        message: 'An action may have happened. Do not retry without asking the Person.',
      },
      terminate: true,
    }),
  })
}

/** Public text is projected just like a Computer page; no credential or session can enter this call. */
export function pageOutcome(outcome: ReadPageOutcome): ToolResult {
  return ReadPageOutcome.match<ToolResult>(outcome, {
    Read: ({ address, title, text: content, truncated }) => ({
      output: {
        ok: true,
        address: views.modelText(address),
        title: views.modelText(title),
        text: views.modelText(content),
        truncated,
      },
    }),
    Refused: ({ reason }) => ({ output: { ok: false, reason } }),
  })
}

/** Scope injects the acting Person/Thread through the attributed client; neither tool accepts ids. */
export function codeTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'run_code',
      // The shared timing contract leaves room for transport and log collection.
      timeoutMs: CodeToolTimeout,
      description: PROGRAM,
      input: v.object({ code: text('The JavaScript program.', 16_384), summary }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const outcome = yield* (yield* Scope).client.RunCode({
              code: data.code,
              summary: data.summary,
            })
            if (CodeOutcome.guards.Failed(outcome))
              yield* warnFailure('run_code', outcome.failure._tag)
            if (CodeOutcome.isAnyOf(['Blocked', 'OutcomeUnknown'])(outcome))
              yield* warnFailure('run_code', outcome._tag)
            return codeOutcome(outcome)
          }),
          { signal, tool: 'run_code' },
        )
      },
    }),
    defineTool({
      name: 'read_page',
      description:
        'Read any public web page as text, without a Computer or signed-in browser. Returns title, headings, paragraphs, lists and links.',
      input: v.object({ summary, address: text('The public http or https page address.', 4000) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const outcome = yield* (yield* Scope).client.ReadPage({ address: data.address })
            if (ReadPageOutcome.guards.Refused(outcome))
              yield* warnFailure('read_page', outcome._tag)
            return pageOutcome(outcome)
          }),
          { signal, tool: 'read_page' },
        )
      },
    }),
  ] as const
}
