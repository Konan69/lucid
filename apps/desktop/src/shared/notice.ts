import * as Schema from 'effect/Schema'

/** Main sends the notice its state on this channel; nothing else is ever sent on it. */
export const NOTICE_STATE_CHANNEL = 'vivid:notice:state'
/** The notice asks for its state once it has drawn, and says Stop was pressed. */
export const NOTICE_INVOKE_CHANNEL = 'vivid:notice:invoke'
/** The one global the notice's own preload exposes. */
export const NOTICE_NAMESPACE = 'vividNotice'

/**
 * What the notice says while Vivid works on the Person's computer.
 *
 * The notice is up for a whole turn, which is one Run's work in apps
 * (`apps/desktop/native/windows/README.md`, "show its notice for the whole turn").
 * `Working` is before Vivid has looked at any window, when there is no app to name yet; it is a
 * different thing to say from `WorkingIn`, not the same state with a blank name. `Stopping` is
 * the moment between the Person pressing Stop and the helper letting go.
 */
export const NoticeState = Schema.TaggedUnion({
  Hidden: {},
  Working: {},
  WorkingIn: { app: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)) },
  Stopping: {},
})
export type NoticeState = typeof NoticeState.Type

/** What the notice may ask of main: its state now, or to stop Vivid. Nothing else. */
export const NoticeRequest = Schema.TaggedUnion({ State: {}, Stop: {} })
export type NoticeRequest = typeof NoticeRequest.Type

/** The whole surface the notice page has: it can watch its state and stop Vivid. */
export interface VividNoticeBridge {
  /** Calls back with the state now and on every change. Returns how to stop listening. */
  readonly watch: (listener: (state: NoticeState) => void) => () => void
  /** The Person pressed Stop. */
  readonly stop: () => void
}
