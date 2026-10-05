# Durable

Read the installed Pi Durable and AI SDK sources before changing their boundaries. Verify pinned APIs. Keep the bridge small. Use public extension points. Never patch Pi internals or SDK methods.

`@vivid/durable` is the Promise entry. `@vivid/durable/core` is the Effect entry being built. Verify the package exports before importing it. Both entries must share contracts and behaviour. Keep React and React Native UI out of this package.

Pi owns the transcript, inbox, submissions, tasks and replay policy. Never mirror Pi state into another store. The host chooses and authorizes the conversation. Ignore the client's supplied history. Decode wire input at ingress. Validate emitted chunks against the pinned AI SDK schema.

Watch before submitting. Do not lose events between admission and attachment. Stream only the run answering that submission. Queued follow-ups get their own run and assistant message. Repeated request ids must not create another submission.

A hold's wait is volatile. Its settlement is durable. Register the wake before reading the settlement. The client stream parks; the run does not end. A decision must work without a client and after restart. A denied call never executes, and its reason reaches the model. The first settlement wins. Return detached settlement values. Reject answers for calls that are not waiting. Scope settlements to the actual call so reused ids cannot inherit approval.

Pi decides whether interrupted tools replay. The stored and current policies must both be safe to rerun. Unsafe interruption reaches the model as an error. Safe replay is not an exactly-once guarantee for external side effects.

Reconnecting combines durable state with later events. It must produce one assistant message per run without duplicated text. Retry must discard failed partial parts. Person answers and approvals must work with the SDK's stock automatic-send predicates.

Use the faux provider and fresh SQLite databases. Never use real credentials or shared app data. Register cleanup before the first write. Wait on streams, promises or durable state. Never sleep or poll in tests. Test this package through `src/index.ts`. Do not mock the seam under test. Cite the upstream file and test name above every ported case. Keep confirmed gaps as `it.fails` with a one-sentence explanation; remove the marker when the fix makes the assertion pass.

Use one-word filenames, ESM, top-level imports and type-only imports. Avoid `any` and non-null assertions. Comment non-obvious ordering and failure behaviour. Pin any added dependency exactly. Keep optional platform dependencies out of core imports.

From this package, run `pnpm exec vitest run` and `pnpm exec tsc --noEmit`. To focus the ports, run `pnpm exec vitest run src/conformance`. From the repository root, run `pnpm exec oxfmt --check packages/agent/durable`. Run every changed case. Pi storage conformance uses the published runner; there is no package-supplied environment adapter. Flue's portable ordering and replay expectations are adapted, not its store interface. These Node consumer tests do not establish React Native transport conformance.
