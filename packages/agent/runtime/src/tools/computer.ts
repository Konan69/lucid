import { defineTool as durableTool } from '@earendil-works/pi-durable'
import { executeCall, executionResult, toolResult } from './tool.ts'
import { Type } from '@earendil-works/pi-ai'
import {
  Tool,
  BrowserAction,
  BrowseTarget,
  BrowseRequest,
  DesktopOutcome,
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
import { signInModelTool } from './signins.ts'
import { warnFailure } from './result.ts'
import * as v from 'valibot'
import { Scope, type RunScoped, type RunTool } from './scope.ts'
import { COMPUTER_HOME, computerSandbox, machineTools } from './sandbox.ts'
import { summary } from './inputs.ts'
import { browseOutcome, desktopOutcome } from './outcomes.ts'

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
    Schema.isPattern(/\S/u),
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
  summary: BrowseRequest.fields.summary
    .check(
      Schema.isPattern(/\S/u),
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

const browseDescription =
  'Open, read or interact with a browser page. Use Vivid’s own computer by default. Choose person for their signed-in sites, something only on their machine, or when they ask for a page on their computer or in their browser; their desktop app must be connected. computer is its own field beside action, never inside it: { computer: "person", action: { kind: "open", address } }. Screenshot returns a picture. If approval is requested, stop and wait.'

/** Native image tools retain the server's action schema but validate and describe display words
 * with the same Valibot summary as every defineTool input; no second wording or limit is owned here. */
const desktopInput = UseDesktopRequest.mapFields((fields) => ({
  action: fields.action,
  summary: fields.summary
    .check(
      Schema.isPattern(/\S/u),
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

/** Browse uses the same Pi native image path as use_desktop; screenshots never enter bounded JSON. */
export function browseModelTool(runTool: RunTool) {
  return durableTool({
    name: Tool.browse,
    description: browseDescription,
    parameters: browserParameters,
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    /** The same Effect schema owns decoding and model parameters; the server owns authority. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Pi input is untrusted; decode the shared browser model schema.
    execute(input, _api, context) {
      return executionResult(
        executeCall(
          (signal) => {
            const parsed = decodeBrowse(input)
            if (Result.isFailure(parsed))
              return Promise.resolve({
                content: [{ type: 'text' as const, text: 'The browser request is invalid.' }],
                details: { ok: false },
                terminate: false,
              })
            let picture = Option.none<string>()
            return runTool(
              browseProgram(parsed.success, (bytes) => {
                picture = Option.some(bytes)
              }),
              {
                signal,
                tool: 'browse',
              },
            ).then((result) => pictureResult(result, picture))
          },
          context,
          { name: 'browse' },
        ).then((result) => toolResult('browse', result)),
        context,
      )
    },
  })
}

/** Native AgentTool content preserves image bytes through Pi's model messages and attachment
 * store. Ordinary defineTool would stringify them, and settle would truncate them to 4,000 chars.
 * Only bounded human metadata uses runTool; picture bytes travel separately in this invocation.
 * Pi stores image blocks in the tool-result transcript separately from display details. */
export function desktopModelTool(runTool: RunTool) {
  return durableTool({
    name: Tool.use_desktop,
    description:
      'Look at the Computer or use its pointer and keyboard. Every completed action returns a picture. If approval is requested, stop and wait.',
    parameters: desktopParameters,
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    /** Decode before RPC; capture only a successful receipt, after the server Gate and takeover check. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi adapter inputs are unknown; decode the authoritative RPC schema before any execution.
    execute(input, _api, context) {
      return executionResult(
        executeCall(
          (signal) => {
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
            return runTool(
              Effect.gen(function* () {
                const { client } = yield* Scope
                const outcome = yield* client.UseDesktop({
                  action: request.success.action,
                  summary: request.success.summary,
                })
                if (DesktopOutcome.isAnyOf(['Blocked', 'Unavailable'])(outcome))
                  yield* warnFailure('use_desktop', outcome._tag)
                if (DesktopOutcome.guards.Completed(outcome))
                  picture = Option.some(outcome.view.picture)
                return desktopOutcome(outcome)
              }),
              { signal, tool: 'use_desktop' },
            ).then((result) => pictureResult(result, picture))
          },
          context,
          { name: 'use_desktop' },
        ).then((result) => toolResult('use_desktop', result)),
        context,
      )
    },
  })
}

/** The core registers these tools directly; Computer authority still belongs to the server. */
export function computerTools(runTool: RunTool, run: RunScoped) {
  return [...machineTools(computerSandbox(run, COMPUTER_HOME)), ...pictureTools(runTool)]
}

/** The tools whose results carry a picture. */
export function pictureTools(runTool: RunTool) {
  return [
    desktopModelTool(runTool),
    browseModelTool(runTool),
    personComputerModelTool(runTool),
    signInModelTool(runTool),
  ]
}
