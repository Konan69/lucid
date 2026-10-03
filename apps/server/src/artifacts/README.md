# Artifacts

Owns durable Markdown documents and immutable version history within a Thread, as specified by
`packages/contracts/src/artifacts.ts` and docs/14.

- `tables.ts`: Thread-owned Artifact summaries and cascading, append-only versions. Titles are
  unique within a Thread using PostgreSQL `lower(title)`.
- `store.ts`: Thread access, atomic creation/revision, historical reads, removal and delivery Run
  attribution. Thread row locks serialize every mutation, including concurrent new titles.
- `handlers.ts`: RPC identity injection and live subscriptions on the Thread topic.
- `store.test.ts`: real PostgreSQL behavior, concurrency, attribution and access tests.

Every reader of a Thread may open and revise its documents. Removal additionally requires its
creator or an admin/owner membership in that Thread's Company; admin status grants no access to
private Threads. The active workspace does not override Thread access.

Vivid supplies a title and whole Markdown body. The server resolves the working Run from the
authenticated Thread, checks its acting Person and locks it until the write commits. No delivery
turn or model identifier is needed. Missing, ended or wrong-Person Runs write nothing. The current
Run reservation permits same-Person deliveries to join; multiple working Runs refuse the write
with `Conflict` rather than guessing attribution. Reusing a title revises its original document;
an identical newest body is a no-op. Write receipts expose `changed` only when a version was added.
Person revisions use compare-and-swap against `from`, with `ArtifactChanged` for stale editors.
First versions have no note; later versions retain optional notes and author snapshots.

Actual mutations publish the Thread topic after commit. No existing audit event describes a
local document revision, so this domain adds no audit record. Removing a Thread cascades through
its documents and every version. Person-facing Artifact surfaces are still unbuilt.

Private ordinary messages and shared attributed signals use the same server-side attribution.
Runtime reads preserve up to 48,000 characters of body. Longer reads include an explicit cut-body
notice with the full character count; stored bodies and version history remain complete.
