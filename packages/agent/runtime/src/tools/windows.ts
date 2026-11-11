import { defineTool as durableTool } from '@earendil-works/pi-durable'
import { executeCall, executionResult, toolResult } from './tool.ts'
import { Type } from '@earendil-works/pi-ai'
import {
  Tool,
  UseWindowRequest,
  WindowAction,
  WindowOutcome,
  WindowPoint,
  WindowResult,
} from '@vivid/contracts'
import { Effect, Match, Option, Result, Schema, Struct } from 'effect'
import * as v from 'valibot'
import { summary } from './inputs.ts'
import { windowOutcome } from './outcomes.ts'
import { pictureResult } from './picture.ts'
import { warnFailure } from './result.ts'
import { Scope, type RunTool } from './scope.ts'
import { quiet, refused } from './views.ts'

/** Model words retain the contract constraints while opaque IDs remain computer-supplied. */
const action = <Fields extends Schema.Struct.Fields, const Kind extends string>(
  fields: Fields,
  kind: Kind,
) => Schema.Struct({ ...Struct.omit(fields, ['_tag']), kind: Schema.Literal(kind) })

const input = Schema.Struct({
  summary: UseWindowRequest.fields.summary
    .check(
      Schema.isPattern(/\S/u),
      Schema.makeFilter((value) => v.is(summary, value)),
    )
    .annotate({ description: v.getDescription(summary) }),
  action: Schema.Union([
    action(WindowAction.cases.ListApps.fields, 'list_apps'),
    action(WindowAction.cases.ListWindows.fields, 'list_windows'),
    action(WindowAction.cases.Open.fields, 'open'),
    action(WindowAction.cases.Look.fields, 'look'),
    action(WindowAction.cases.Press.fields, 'press'),
    action(WindowAction.cases.Choose.fields, 'choose'),
    action(WindowAction.cases.Fill.fields, 'fill'),
    action(
      { ...Struct.omit(WindowAction.cases.Click.fields, ['at']), ...WindowPoint.fields },
      'click',
    ),
    action(WindowAction.cases.Type.fields, 'type'),
    action(WindowAction.cases.Keys.fields, 'keys'),
    action(
      { ...Struct.omit(WindowAction.cases.Scroll.fields, ['at']), ...WindowPoint.fields },
      'scroll',
    ),
    action(WindowAction.cases.Close.fields, 'close'),
  ]),
})
const decode = Schema.decodeUnknownResult(input)
const document = Schema.toJsonSchemaDocument(input)
// TypeBox's public JSON Schema bridge documents parameters; Effect still decodes actual input.
const parameters = Type.Unsafe<typeof input.Encoded>(
  Object.assign({}, document.schema, { $defs: document.definitions }),
)

/** One exhaustive translation owns the model vocabulary, including flat picture coordinates. */
const windowAction = (step: typeof input.Type.action): WindowAction =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive('kind')({
      list_apps: () => WindowAction.cases.ListApps.make({}),
      list_windows: () => WindowAction.cases.ListWindows.make({}),
      open: ({ app }) => WindowAction.cases.Open.make({ app }),
      look: ({ window }) => WindowAction.cases.Look.make({ window }),
      press: ({ window, look, element }) =>
        WindowAction.cases.Press.make({ window, look, element }),
      choose: ({ window, look, element }) =>
        WindowAction.cases.Choose.make({ window, look, element }),
      fill: ({ window, look, element, text }) =>
        WindowAction.cases.Fill.make({ window, look, element, text }),
      click: ({ window, look, x, y, button, times }) =>
        WindowAction.cases.Click.make({ window, look, at: { x, y }, button, times }),
      type: ({ window, text }) => WindowAction.cases.Type.make({ window, text }),
      keys: ({ window, keys }) => WindowAction.cases.Keys.make({ window, keys }),
      scroll: ({ window, look, x, y, direction, notches }) =>
        WindowAction.cases.Scroll.make({ window, look, at: { x, y }, direction, notches }),
      close: ({ window }) => WindowAction.cases.Close.make({ window }),
    }),
  )

const personComputerDescription =
  'Work in any app on the person’s own Windows computer through the Vivid desktop app, including terminals. For a web page on their computer, use browse with computer person instead. Start with list_windows or list_apps, then look at a window before acting. Prefer a numbered element from the look (press, choose, fill) over click. The computer must be allowed, connected and advertise apps support; an active Run is required. If the person stopped it, stop.'

/** The server owns Run and Device admission; only decoded completed results supply native images. */
const program = Effect.fn('ComputerTool.person')(function* (
  data: typeof input.Type,
  picture: (bytes: string) => void,
) {
  const outcome = yield* (yield* Scope).client.UseWindow({
    summary: data.summary,
    action: windowAction(data.action),
  })
  if (!WindowOutcome.guards.Completed(outcome))
    yield* warnFailure('use_person_computer', outcome._tag)
  if (
    WindowOutcome.guards.Completed(outcome) &&
    WindowResult.isAnyOf(['Seen', 'Typed', 'Closing'])(outcome.result)
  )
    picture(outcome.result.view.picture)
  return { ...windowOutcome(outcome), computer: 'person' as const }
})

/** Same native Pi image adapter as use_desktop; window pictures never enter bounded JSON. */
export function personComputerModelTool(runTool: RunTool) {
  return durableTool({
    name: Tool.use_person_computer,
    description: personComputerDescription,
    parameters,
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    /** The Pi boundary supplies unknown input and cancellation; decode before making any RPC. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Pi tool input is untrusted; Effect owns its ingress schema.
    execute(value, _api, context) {
      return executionResult(
        executeCall(
          (signal) => {
            const parsed = decode(value)
            if (Result.isFailure(parsed))
              return Promise.resolve(
                pictureResult(
                  {
                    output: refused('The app request is invalid.', quiet),
                    terminate: false,
                  },
                  Option.none(),
                ),
              )
            let picture = Option.none<string>()
            return runTool(
              program(parsed.success, (bytes) => {
                picture = Option.some(bytes)
              }),
              {
                signal,
                tool: 'use_person_computer',
              },
            ).then((result) => pictureResult(result, picture))
          },
          context,
          { name: 'use_person_computer' },
        ).then((result) => toolResult('use_person_computer', result)),
        context,
      )
    },
  })
}
