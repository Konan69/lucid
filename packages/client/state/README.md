# Client state

The pure view logic every surface shares, so web, mobile and desktop decide the same things the
same way and each only draws. No JSX, no requests, no platform API: every module is a function
over contract values, with tests beside it.

- `threads.ts`, `lanes.ts`: how Threads are grouped and what a Thread's standing line says.
- `steps.ts`, `activity.ts`: turning tool calls into the step lines and activity a Person reads.
- `shown.ts`: reading a `show` tool call into a card, and the helpers cards share.
- `approvals.ts`, `routines.ts`, `projects.ts`, `resource.ts`: per-domain wording and derivations.
- `drafts.ts`, `link.ts`, `signin.ts`, `when.ts`, `live.ts`: unsent text, links, sign-in pages,
  times as a Person reads them, and live-state helpers.

The data layer itself (cache, live updates, optimistic writes) is `packages/client/rpc` plus each
app's `data/` directory.
