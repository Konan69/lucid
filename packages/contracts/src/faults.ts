import { Schema } from 'effect'

/**
 * What a client says when a part of it failed to draw or an error reached the top of the app.
 *
 * A client catches such an error so the Person keeps a usable screen (`ui/Recover.tsx` on each
 * surface), which also means nobody else ever hears of it. This is the report it sends, so the
 * failure lands in the server's log, the one place that is read. It carries the error and where in
 * the tree it happened. It takes nothing from a Thread on purpose, but an error's own message is
 * whatever the code that threw it wrote, so a report is treated as possibly holding what was on
 * screen: it goes to the server's log and nowhere else.
 *
 * Every field is bounded, because the sender is a client that has just failed and the route takes
 * no session (a screen can break before anyone signs in). A client cuts each text to its limit
 * before sending (`cutFault`). The limits are counted in characters and the server caps the body
 * in bytes, at several times what these limits come to, so an honest report is not refused for
 * its size.
 */

/** The longest stack or component trace kept; enough for the frames that matter. */
const FAULT_TRACE_LIMIT = 8000
const FAULT_LINE_LIMIT = 2000
const FAULT_BUILD_LIMIT = 300

export const Fault = Schema.Struct({
  surface: Schema.Literals(['web', 'mobile']),
  /** The error's own message. */
  message: Schema.String.check(Schema.isMaxLength(FAULT_LINE_LIMIT)),
  /** The JavaScript stack. Null when the engine recorded none for the error. */
  stack: Schema.NullOr(Schema.String.check(Schema.isMaxLength(FAULT_TRACE_LIMIT))),
  /**
   * React's component stack for an error caught while drawing. Null for one caught outside
   * drawing, which has no component to name.
   */
  components: Schema.NullOr(Schema.String.check(Schema.isMaxLength(FAULT_TRACE_LIMIT))),
  /** Which build failed: platform, app version and running update on a phone, the browser on web. */
  build: Schema.String.check(Schema.isMaxLength(FAULT_BUILD_LIMIT)),
})
export type Fault = typeof Fault.Type

/**
 * Builds a report from a caught error, cut to the limits above. The caller makes sure it holds an
 * `Error`: React hands one to a boundary, and a global handler wraps any other thrown value.
 */
export const cutFault = (input: {
  readonly surface: Fault['surface']
  readonly thrown: Error
  readonly components: string | null
  readonly build: string
}): Fault =>
  Fault.make({
    surface: input.surface,
    message: input.thrown.message.slice(0, FAULT_LINE_LIMIT),
    stack: input.thrown.stack === undefined ? null : input.thrown.stack.slice(0, FAULT_TRACE_LIMIT),
    components: input.components === null ? null : input.components.slice(0, FAULT_TRACE_LIMIT),
    build: input.build.slice(0, FAULT_BUILD_LIMIT),
  })
