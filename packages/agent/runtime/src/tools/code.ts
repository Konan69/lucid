import { defineTool } from '@flue/runtime'
import { BrowserAction, CodeFailure, CodeOutcome, ReadPageOutcome } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import type { ToolResult } from './result.ts'
import * as views from './views.ts'

/** These are the entire guest API, with human account names and no Vivid ownership arguments. */
const PROGRAM = `Run a short JavaScript async function body (top-level await and return work). Return JSON. No imports, network, filesystem, process or persistent state. Limits: 16 KiB source, 30 seconds total, 25 calls, 256 KiB per call/result, 1 MiB data, 32 KiB final result. Calls are serialized. Approval, a blocking rule or an unknown action ends the program; completed calls stay completed. Never replay it to resume.
The callable API (TypeScript declarations describe JavaScript inputs):
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
declare const tools: {
find_tools(input: {query: string, limit?: number}): Promise<{tools: {account: string, tool: string, description: string, effect: "read" | "write" | "destructive", input: Json}[], unconnected: {service: string, description: string}[]}>;
use_tool(input: {account: string, tool: string, input: Json, summary: string, rationale: string}): Promise<{ok: true, output: Json} | {ok: false, reason: string}>;
run_command(input: {command: string, summary: string, timeoutSeconds?: number}): Promise<{ok: true, result: {exitCode: number, output: string, truncated: boolean}} | {ok: false, reason: string}>;
browse(input: {action: BrowserAction, summary: string}): Promise<{ok: true, result: {title: string, outline: string, truncated: boolean}} | {ok: false, reason: string}>;
read_page(input: {address: string}): Promise<{ok: true, address: string, title: string, text: string, truncated: boolean} | {ok: false, reason: string}>;
};
BrowserAction is defined by this JSON Schema: ${JSON.stringify(Schema.toJsonSchemaDocument(BrowserAction).schema)}
Use only account/tool names and input schemas found by find_tools. Provider record identifiers remain usable data. Do not catch an approval to continue or retry an unknown action.`

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
    Completed: ({ result, truncated }) => ({ output: { ok: true, result, calls, truncated } }),
    ApprovalRequired: ({ approvalId, summary: purpose }) => ({
      output: { ...views.approval({ approvalId, summary: purpose }), calls },
      terminate: true,
    }),
    Blocked: ({ rule }) => ({
      output: { ok: false, rule: views.modelText(rule), calls },
      terminate: true,
    }),
    Failed: ({ failure }) => ({ output: { ok: false, failure: failureView(failure), calls } }),
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
      description: PROGRAM,
      input: v.object({ code: text('The JavaScript program.', 16_384), summary }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            return codeOutcome(yield* (yield* Scope).client.RunCode(data))
          }),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'read_page',
      description:
        'Read any public web page as text, without a Computer or signed-in browser. Returns title, headings, paragraphs, lists and links.',
      input: v.object({ address: text('The public http or https page address.', 4000) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            return pageOutcome(yield* (yield* Scope).client.ReadPage(data))
          }),
          { signal },
        )
      },
    }),
  ] as const
}
