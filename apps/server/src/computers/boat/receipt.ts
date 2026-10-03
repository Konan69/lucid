import { Schema } from 'effect'

/** Cua 0.23.2's public action truth replaces legacy status/verified fields. A receipt reports
 * delivery, not the user's intended postcondition; callers take fresh desktop/page state.
 * Source: cua-driver-core/src/action_record.rs public_result and tool.rs action output schema. */
export const InputRoute = Schema.Literals([
  'accessibility',
  'synthetic_events',
  'global_input',
  'system_api',
  'dom',
  'trusted_input',
])
export const ActionReceipt = Schema.Struct({
  effect: Schema.Literals(['confirmed', 'partial', 'unverifiable', 'suspected_noop']),
  route: InputRoute,
  delivery: Schema.Struct({
    mode: Schema.Literals(['background', 'foreground', 'not_applicable', 'unknown']),
  }),
})

/** Navigation is a distinct receipt: it invalidates page refs and acknowledges the requested URL. */
export const NavigationReceipt = Schema.Struct({
  status: Schema.Literal('ok'),
  target_id: Schema.String,
  tab_id: Schema.String,
  url: Schema.String,
  refs_invalidated: Schema.Literal(true),
})
