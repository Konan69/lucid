# Client state

Shared view logic and live state, so web, mobile and desktop decide the same things the same way
and each only draws. No JSX or platform API. Most modules are pure functions over contract values;
`live.ts` owns the shared live cache, scoped RPC subscriptions, resubscription, and optimistic
writes through the supplied client. Tests sit beside the behavior they prove.

- `threads.ts`, `lanes.ts`: how Threads are grouped and what a Thread's standing line says.
- `steps.ts`, `activity.ts`: turning tool calls into the step lines and activity a Person reads.
- `shown.ts`: reading a `show` tool call into a card, and the helpers cards share.
- `approvals.ts`, `routines.ts`, `projects.ts`, `resource.ts`: per-domain wording and derivations.
  Routine fields retain a one-off trigger in `once: Option<OneOff>` (`at`, `timezone`);
  `describeTrigger` says its local date and time, and `triggerOf` preserves the instant when
  editing its name or instructions. The selectable trigger kinds remain Schedule and Webhook.
- `drafts.ts`, `link.ts`, `signin.ts`, `when.ts`, `live.ts`: unsent text, links, sign-in pages,
  times as a Person reads them, and live-state helpers.

`packages/client/rpc` supplies schema-derived HTTP and WebSocket clients. Each app's `data/`
directory wires its queries and mutations to this package's live registry and optimistic-write lifecycle.
