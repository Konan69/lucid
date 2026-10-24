# Client state

Shared view logic and live state, so web, mobile and desktop decide the same things the same way
and each only draws. No JSX or platform API. Most modules are pure functions over contract values;
`live.ts` owns the shared live cache, scoped RPC subscriptions, resubscription, and optimistic
writes through the supplied client. Client lifecycles belong to Effect Machine; behavior is
proved through integration tests and live runs.

- `threads.ts`: how Threads are grouped and what a Thread's standing line says.
- `seen.ts`: bounded Thread read reporting while a foreground screen reads its query.
- `purpose.ts`: the Integration catalog's shared grouping and order.
- `steps.ts`, `activity.ts`: turning tool calls into the step lines and activity a Person reads.
- `shown.ts`: reading a `show` tool call into a card, and the helpers cards share.
- `approvals.ts`, `projects.ts`: per-domain wording and derivations.
- `library.ts` (`library`): the Library's shelves, levels, reads and upload answer; each surface
  sends the bytes with its own platform API.
- `drafts.ts`, `link.ts`, `signin.ts`, `when.ts`, `live.ts`: unsent text, links, sign-in pages,
  times as a Person reads them, and live-state helpers.

`packages/client/rpc` supplies schema-derived HTTP and WebSocket clients. Each app's `data/`
directory wires its queries and mutations to this package's live registry and optimistic-write lifecycle.
