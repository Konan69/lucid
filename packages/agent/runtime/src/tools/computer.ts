import {
  defineTool,
  useSandbox,
  SandboxOperationUnsupportedError,
  type Sandbox,
  type SandboxFactory,
  type LlmImageContent,
  type LlmTextContent,
} from '@flue/runtime'
import { Type } from '@earendil-works/pi-ai'
import {
  BrowserAction,
  BrowseTarget,
  RunCommandRequest,
  DesktopOutcome,
  CommandOutcome,
  BrowseOutcome,
  UseDesktopRequest,
  type DesktopView,
} from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Match from 'effect/Match'
import { warnFailure } from './result.ts'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'
import { browseOutcome, commandOutcome, desktopOutcome } from './outcomes.ts'

/** Model-facing text rules are shared by Valibot ingress and native Flue JSON parameters. */
const browserWords = {
  address: { description: 'The page address to open.', maximum: 4000 },
  control: { description: 'The control’s exact accessible name from the outline.', maximum: 4000 },
  field: { description: 'The field’s exact accessible name from the outline.', maximum: 4000 },
  text: { description: 'The text to enter.', maximum: 4000 },
  key: { description: 'The key or key combination.', maximum: 200 },
}

/** Native image tools need JSON Schema; preserve the same limits and whitespace rule as text(). */
const modelWord = (spec: { readonly description: string; readonly maximum: number }) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isPattern(/\S/),
    Schema.isMaxLength(spec.maximum),
  ).annotate({ description: spec.description })

const action = v.variant('kind', [
  v.object({
    kind: v.literal('open'),
    address: text(browserWords.address.description, browserWords.address.maximum),
  }),
  v.object({ kind: v.literal('read') }),
  v.object({
    kind: v.literal('click'),
    target: text(browserWords.control.description, browserWords.control.maximum),
  }),
  v.object({
    kind: v.literal('type'),
    target: text(browserWords.field.description, browserWords.field.maximum),
    text: text(browserWords.text.description, browserWords.text.maximum),
  }),
  v.object({
    kind: v.literal('press'),
    key: text(browserWords.key.description, browserWords.key.maximum),
  }),
  v.object({ kind: v.literal('screenshot') }),
  v.object({
    kind: v.literal('scroll'),
    direction: v.picklist(['up', 'down', 'left', 'right']),
    notches: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
  }),
  v.object({ kind: v.literal('back') }),
  v.object({ kind: v.literal('forward') }),
  v.object({
    kind: v.literal('wait'),
    seconds: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
  }),
  v.object({
    kind: v.literal('open_tab'),
    address: text(browserWords.address.description, browserWords.address.maximum),
  }),
  v.object({
    kind: v.literal('show_tab'),
    tab: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  }),
  v.object({
    kind: v.literal('close_tab'),
    tab: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  }),
])

const browseInput = v.object({
  computer: v.optional(v.picklist(['vivid', 'person']), 'vivid'),
  action: v.pipe(action, v.description('The browser action and the fields it needs.')),
  summary,
})

/** Reuse server field constraints while giving the model plain action words. */
const modelAction = <Fields extends Schema.Struct.Fields>(fields: Fields, kind: string) =>
  Schema.Struct({ ...Struct.omit(fields, ['_tag']), kind: Schema.Literal(kind) })

/** Native model parameters retain the existing Valibot vocabulary; RPC still uses BrowserAction. */
const browserDocument = Schema.toJsonSchemaDocument(
  Schema.Struct({
    computer: Schema.optionalKey(Schema.Literals(['vivid', 'person'])),
    action: Schema.Union([
      modelAction(
        { ...BrowserAction.cases.Open.fields, address: modelWord(browserWords.address) },
        'open',
      ),
      modelAction(BrowserAction.cases.Read.fields, 'read'),
      modelAction(
        { ...BrowserAction.cases.Click.fields, target: modelWord(browserWords.control) },
        'click',
      ),
      modelAction(
        {
          ...BrowserAction.cases.Type.fields,
          target: modelWord(browserWords.field),
          text: modelWord(browserWords.text),
        },
        'type',
      ),
      modelAction(
        { ...BrowserAction.cases.Press.fields, key: modelWord(browserWords.key) },
        'press',
      ),
      modelAction(BrowserAction.cases.Screenshot.fields, 'screenshot'),
      modelAction(BrowserAction.cases.Scroll.fields, 'scroll'),
      modelAction(BrowserAction.cases.Back.fields, 'back'),
      modelAction(BrowserAction.cases.Forward.fields, 'forward'),
      modelAction(BrowserAction.cases.Wait.fields, 'wait'),
      modelAction(
        { ...BrowserAction.cases.OpenTab.fields, address: modelWord(browserWords.address) },
        'open_tab',
      ),
      modelAction(BrowserAction.cases.ShowTab.fields, 'show_tab'),
      modelAction(BrowserAction.cases.CloseTab.fields, 'close_tab'),
    ]),
    summary: RunCommandRequest.fields.summary,
  }),
)
const browserParameters = Type.Unsafe(
  Object.assign({}, browserDocument.schema, { $defs: browserDocument.definitions }),
)

/** Pictures leave bounded text only after the authoritative RPC result has been decoded. */
const browseProgram = Effect.fn('ComputerTool.browse')(function* (
  data: v.InferOutput<typeof browseInput>,
  picture: (bytes: string) => void,
) {
  const { client } = yield* Scope
  const outcome = yield* client.Browse({
    target:
      data.computer === 'person'
        ? BrowseTarget.cases.Person.make({})
        : BrowseTarget.cases.Vivid.make({}),
    action: browserAction(data.action),
    summary: data.summary,
  })
  if (BrowseOutcome.isAnyOf(['Blocked', 'Unavailable'])(outcome))
    yield* warnFailure('browse', outcome._tag)
  if (BrowseOutcome.guards.Completed(outcome) && outcome.result.picture !== undefined)
    picture(outcome.result.picture)
  return browseOutcome(outcome)
})

/** The model vocabulary maps exhaustively to the server's closed BrowserAction contract. */
function browserAction(input: v.InferOutput<typeof action>): BrowserAction {
  return Match.value(input).pipe(
    Match.discriminatorsExhaustive('kind')({
      open: ({ address }) => BrowserAction.cases.Open.make({ address }),
      read: () => BrowserAction.cases.Read.make({}),
      click: ({ target }) => BrowserAction.cases.Click.make({ target }),
      type: ({ target, text: entered }) => BrowserAction.cases.Type.make({ target, text: entered }),
      press: ({ key }) => BrowserAction.cases.Press.make({ key }),
      screenshot: () => BrowserAction.cases.Screenshot.make({}),
      scroll: ({ direction, notches }) => BrowserAction.cases.Scroll.make({ direction, notches }),
      back: () => BrowserAction.cases.Back.make({}),
      forward: () => BrowserAction.cases.Forward.make({}),
      wait: ({ seconds }) => BrowserAction.cases.Wait.make({ seconds }),
      open_tab: ({ address }) => BrowserAction.cases.OpenTab.make({ address }),
      show_tab: ({ tab }) => BrowserAction.cases.ShowTab.make({ tab }),
      close_tab: ({ tab }) => BrowserAction.cases.CloseTab.make({ tab }),
    }),
  )
}

/** Computer tools propose actions only; availability, takeover and approvals belong to the server. */
export function computerTools(runTool: RunTool) {
  useSandbox(desktopToolFactory(runTool))
  return [commandDefinition(runTool)]
}

/** Plain definitions can be inspected without rendering Flue hooks; the image tool mounts separately. */
export function computerDefinitions(runTool: RunTool) {
  return [commandDefinition(runTool), browserDefinition(runTool)] as const
}

/** The command definition is mounted directly; native browse mounts through the image factory. */
function commandDefinition(runTool: RunTool) {
  return defineTool({
    name: 'run_command',
    description:
      'Run a command on the person’s Computer when needed for their request. If approval is requested, stop and wait.',
    input: v.object({
      command: text('The command to run.', 8000),
      summary,
      timeoutSeconds: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description('Maximum seconds to wait for the command.'),
        ),
      ),
    }),
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    run({ data, signal }) {
      const request: Schema.Struct.Mutable<RunCommandRequest> = {
        command: data.command,
        summary: data.summary,
      }
      if (data.timeoutSeconds !== undefined) request.timeoutSeconds = data.timeoutSeconds
      return runTool(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const outcome = yield* client.RunCommand(RunCommandRequest.make(request))
          if (CommandOutcome.isAnyOf(['Blocked', 'Unavailable'])(outcome))
            yield* warnFailure('run_command', outcome._tag)
          return commandOutcome(outcome)
        }),
        { signal, tool: 'run_command' },
      )
    },
  })
}

const browseDescription =
  'Open, read or interact with a browser page. Use Vivid’s own computer by default. Choose person for their signed-in sites, something only on their machine, or when they ask to use their computer; their desktop app must be connected. Screenshot returns a picture. If approval is requested, stop and wait.'

/** The rehearsal catalog keeps the same schema and program as native browse, without image bytes. */
function browserDefinition(runTool: RunTool) {
  return defineTool({
    name: 'browse',
    description: browseDescription,
    input: browseInput,
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          return yield* browseProgram(data, () => undefined)
        }),
        { signal, tool: 'browse' },
      )
    },
  })
}

const decodeDesktop = Schema.decodeUnknownResult(UseDesktopRequest)
// The TypeBox schema is derived from the authoritative Effect contract, with runtime decoding
// below. Type.Unsafe is TypeBox's public bridge for an existing JSON Schema, not an input cast.
const desktopDocument = Schema.toJsonSchemaDocument(UseDesktopRequest)
const desktopParameters = Type.Unsafe<UseDesktopRequest>(
  Object.assign({}, desktopDocument.schema, { $defs: desktopDocument.definitions }),
)

type DesktopToolResult = {
  content: Array<LlmTextContent | LlmImageContent>
  details: Schema.Json
  terminate: boolean
}

/** Browse uses the same Flue native image path as use_desktop; screenshots never enter bounded JSON. */
export function browseModelTool(runTool: RunTool) {
  return {
    name: 'browse',
    label: 'Browse',
    description: browseDescription,
    parameters: browserParameters,
    /** Valibot owns model-input decoding; the server alone owns authority, policy and dispatch. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Flue input is untrusted; decode the shared browser model schema.
    execute(_call: string, input: unknown, signal?: AbortSignal) {
      const parsed = v.safeParse(browseInput, input)
      if (!parsed.success)
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'The browser request is invalid.' }],
          details: { ok: false },
          terminate: false,
        })
      let picture = Option.none<string>()
      const cancellation = signal === undefined ? new AbortController().signal : signal
      return runTool(
        browseProgram(parsed.output, (bytes) => {
          picture = Option.some(bytes)
        }),
        {
          signal: cancellation,
          tool: 'browse',
        },
      ).then((result): DesktopToolResult => {
        const metadata = { type: 'text' as const, text: JSON.stringify(result.output) }
        return Option.match(picture, {
          onNone: () => ({
            content: [metadata],
            details: result.output,
            terminate: result.terminate,
          }),
          onSome: (bytes) => ({
            content: [metadata, { type: 'image' as const, mimeType: 'image/png', data: bytes }],
            details: result.output,
            terminate: result.terminate,
          }),
        })
      })
    },
  }
}

/** Native AgentTool content preserves image bytes through Flue's model messages and attachment
 * store. Ordinary defineTool would stringify them, and settle would truncate them to 4,000 chars.
 * Only bounded human metadata uses runTool; picture bytes travel separately in this invocation.
 * Flue 2.1 docs reference/sandbox-api; conversation-stream-store persistToolResultContent. */
export function desktopModelTool(runTool: RunTool) {
  return {
    name: 'use_desktop',
    label: 'Use the Computer desktop',
    description:
      'Look at the Computer or use its pointer and keyboard. Every completed action returns a picture. If approval is requested, stop and wait.',
    parameters: desktopParameters,
    /** Decode before RPC; capture only a successful receipt, after the server Gate and takeover check. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Flue adapter inputs are unknown; decode the authoritative RPC schema before any execution.
    execute(_call: string, input: unknown, signal?: AbortSignal) {
      const request = decodeDesktop(input)
      if (Result.isFailure(request)) {
        const refusal: DesktopToolResult = {
          content: [{ type: 'text' as const, text: 'The desktop request is invalid.' }],
          details: { ok: false },
          terminate: false,
        }
        return Promise.resolve(refusal)
      }
      let picture = Option.none<DesktopView>()
      const cancellation = signal === undefined ? new AbortController().signal : signal
      return runTool(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const outcome = yield* client.UseDesktop(request.success)
          if (DesktopOutcome.isAnyOf(['Blocked', 'Unavailable'])(outcome))
            yield* warnFailure('use_desktop', outcome._tag)
          if (DesktopOutcome.guards.Completed(outcome)) picture = Option.some(outcome.view)
          return desktopOutcome(outcome)
        }),
        { signal: cancellation, tool: 'use_desktop' },
      ).then((result): DesktopToolResult => {
        const metadata = { type: 'text' as const, text: JSON.stringify(result.output) }
        return Option.match(picture, {
          onNone: () => ({
            content: [metadata],
            details: result.output,
            terminate: result.terminate,
          }),
          onSome: (view) => ({
            content: [
              metadata,
              { type: 'image' as const, mimeType: 'image/png', data: view.picture },
            ],
            details: result.output,
            terminate: result.terminate,
          }),
        })
      })
    },
  }
}

/** Flue exposes image content through SandboxFactory.tools. This factory supplies a tool-only,
 * empty virtual namespace, not the guest filesystem: raw FS/shell cannot bypass Vivid's RPC Gate.
 * Flue resolves it once per submission; the acting Person stays fixed while deliveries join
 * that response (agents/vivid.ts). A later submission gets a newly attributed factory. */
export function desktopToolFactory(runTool: RunTool): SandboxFactory {
  return {
    createSandbox: () => Promise.resolve(toolNamespace()),
    tools: () => [desktopModelTool(runTool), browseModelTool(runTool)],
  }
}

/** The namespace contains only its root; it makes no claim about guest files or provider identity.
 * Writes and raw execution are explicitly unsupported. Existing run_command remains gated RPC. */
function toolNamespace(): Sandbox {
  const unsupported = (operation: string) =>
    Promise.reject(
      new SandboxOperationUnsupportedError({
        operation,
        provider: 'Vivid Computer tools',
        options: ['raw filesystem or shell access'],
      }),
    )
  return {
    cwd: '/',
    resolvePath: (path) => (path.startsWith('/') ? path : `/${path}`),
    exists: (path) => Promise.resolve(path === '/'),
    readdir: (path) => (path === '/' ? Promise.resolve([]) : unsupported('readdir')),
    stat: (path) =>
      path === '/' ? Promise.resolve({ isDirectory: true, isFile: false }) : unsupported('stat'),
    exec: () => unsupported('exec'),
    readFile: () => unsupported('readFile'),
    readFileBuffer: () => unsupported('readFileBuffer'),
    writeFile: () => unsupported('writeFile'),
    mkdir: () => unsupported('mkdir'),
    rm: () => unsupported('rm'),
  }
}
