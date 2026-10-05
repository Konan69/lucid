import {
  defineTool,
  useSandbox,
  SandboxOperationUnsupportedError,
  type Sandbox,
  type SandboxFactory,
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
} from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Match from 'effect/Match'
import { pictureResult } from './picture.ts'
import { personComputerModelTool } from './windows.ts'
import { warnFailure } from './result.ts'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'
import { browseOutcome, commandOutcome, desktopOutcome } from './outcomes.ts'

/** The authoritative browser schema uses these model-facing words and text limits. */
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

/** Reuse server field constraints while giving the model plain action words. */
const modelAction = <Fields extends Schema.Struct.Fields, const Kind extends string>(
  fields: Fields,
  kind: Kind,
) => Schema.Struct({ ...Struct.omit(fields, ['_tag']), kind: Schema.Literal(kind) })

/** Native model parameters use plain action words; RPC still uses BrowserAction. */
const browseInput = Schema.Struct({
  computer: Schema.Literals(['vivid', 'person'])
    .annotate({
      description:
        'Use vivid by default. Choose person for their signed-in sites, something only on their machine, or when they ask; their desktop app must be connected.',
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed('vivid' as const))),
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
    modelAction({ ...BrowserAction.cases.Press.fields, key: modelWord(browserWords.key) }, 'press'),
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
  summary: RunCommandRequest.fields.summary
    .check(
      Schema.isPattern(/\S/),
      Schema.makeFilter((value) => v.is(summary, value)),
    )
    .annotate({ description: v.getDescription(summary) }),
})
const decodeBrowse = Schema.decodeUnknownResult(browseInput)
const browserDocument = Schema.toJsonSchemaDocument(browseInput)
// Public TypeBox JSON Schema adapter, as use_desktop uses below; decoding and documentation
// both derive from browseInput. This constructor does not assert untrusted input is typed.
const browserParameters = Type.Unsafe<typeof browseInput.Encoded>(
  Object.assign({}, browserDocument.schema, { $defs: browserDocument.definitions }),
)

/** Pictures leave bounded text only after the authoritative RPC result has been decoded. */
const browseProgram = Effect.fn('ComputerTool.browse')(function* (
  data: typeof browseInput.Type,
  picture: (bytes: string) => void,
) {
  const { client } = yield* Scope
  const outcome = yield* client.Browse({
    target: Match.value(data.computer).pipe(
      Match.when('person', () => BrowseTarget.cases.Person.make({})),
      Match.when('vivid', () => BrowseTarget.cases.Vivid.make({})),
      Match.exhaustive,
    ),
    action: browserAction(data.action),
    summary: data.summary,
  })
  if (!BrowseOutcome.isAnyOf(['Completed', 'ApprovalRequired'])(outcome))
    yield* warnFailure('browse', outcome._tag)
  if (BrowseOutcome.guards.Completed(outcome))
    Option.match(Option.fromUndefinedOr(outcome.result.picture), {
      onNone: () => undefined,
      onSome: picture,
    })
  return { ...browseOutcome(outcome), computer: data.computer }
})

/** The model vocabulary maps exhaustively to the server's closed BrowserAction contract. */
function browserAction(input: typeof browseInput.Type.action): BrowserAction {
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

/** The command definition is mounted directly; native browse mounts through the image factory. */
export function commandDefinition(runTool: RunTool) {
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

/** Native image tools retain the server's action schema but validate and describe display words
 * with the same Valibot summary as every defineTool input; no second wording or limit is owned here. */
const desktopInput = UseDesktopRequest.mapFields((fields) => ({
  action: fields.action,
  summary: fields.summary
    .check(
      Schema.isPattern(/\S/),
      Schema.makeFilter((value) => v.is(summary, value)),
    )
    .annotate({ description: v.getDescription(summary) }),
}))
const decodeDesktop = Schema.decodeUnknownResult(desktopInput)
// Type.Unsafe is TypeBox's public bridge for an existing JSON Schema, not an input cast.
const desktopDocument = Schema.toJsonSchemaDocument(desktopInput)
const desktopParameters = Type.Unsafe<typeof desktopInput.Encoded>(
  Object.assign({}, desktopDocument.schema, { $defs: desktopDocument.definitions }),
)

/** Browse uses the same Flue native image path as use_desktop; screenshots never enter bounded JSON. */
export function browseModelTool(runTool: RunTool) {
  return {
    name: 'browse',
    label: 'Browse',
    description: browseDescription,
    parameters: browserParameters,
    /** The same Effect schema owns decoding and model parameters; the server owns authority. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Flue input is untrusted; decode the shared browser model schema.
    execute(_call: string, input: unknown, signal?: AbortSignal) {
      const parsed = decodeBrowse(input)
      if (Result.isFailure(parsed))
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'The browser request is invalid.' }],
          details: { ok: false },
          terminate: false,
        })
      let picture = Option.none<string>()
      const cancellation = signal === undefined ? new AbortController().signal : signal
      return runTool(
        browseProgram(parsed.success, (bytes) => {
          picture = Option.some(bytes)
        }),
        {
          signal: cancellation,
          tool: 'browse',
        },
      ).then((result) => pictureResult(result, picture))
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
        const refusal = {
          content: [{ type: 'text' as const, text: 'The desktop request is invalid.' }],
          details: { ok: false },
          terminate: false,
        }
        return Promise.resolve(refusal)
      }
      let picture = Option.none<string>()
      const cancellation = signal === undefined ? new AbortController().signal : signal
      return runTool(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const outcome = yield* client.UseDesktop({
            action: request.success.action,
            summary: request.success.summary,
          })
          if (DesktopOutcome.isAnyOf(['Blocked', 'Unavailable'])(outcome))
            yield* warnFailure('use_desktop', outcome._tag)
          if (DesktopOutcome.guards.Completed(outcome)) picture = Option.some(outcome.view.picture)
          return desktopOutcome(outcome)
        }),
        { signal: cancellation, tool: 'use_desktop' },
      ).then((result) => pictureResult(result, picture))
    },
  }
}

/** Flue exposes image content through SandboxFactory.tools. This factory supplies a tool-only,
 * empty virtual namespace, not the guest filesystem: raw FS/shell cannot bypass Vivid's RPC Gate.
 * Flue resolves it once per submission; the acting Person stays fixed while deliveries join
 * that response (agents/vivid.ts). A later submission gets a newly attributed factory. */
export function desktopToolFactory(runTool: RunTool) {
  return {
    createSandbox: () => Promise.resolve(toolNamespace()),
    tools: () => [
      desktopModelTool(runTool),
      browseModelTool(runTool),
      personComputerModelTool(runTool),
    ],
  } satisfies SandboxFactory
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
