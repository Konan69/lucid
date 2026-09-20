# Upstream provenance

- Source: `HelixDB/skills`
- Path: `skills/helix-cli`
- Base: unknown; owner copy was v3-era with later live-instance notes
- Merged commit: `199e5d03a18181fef535826e78de9922bd6fd9f1`
- Merged at: `2026-09-19`

## Merge notes

Replaced upstream-owned files with current v4.0.1 WorkOS/broker CLI guidance and imported `agents/openai.yaml`. Preserved the owner's dated 2026-08-30 CLI v3.1.1 live-instance observations as an explicitly legacy, unverified compatibility note.

No owner wording was discarded: the dated observations remain authoritative for the legacy CLI v3.1.1 environment in which they were verified. Current upstream defines the separate v4.0.1/v0.0.5 default—`/v2/query`, WorkOS sessions, and no `push`, `sync`, or global workspace selection—so the apparent conflict is resolved by explicit version scope. The shared error-handling link is adapted to the vendored file under `helix-query-json-dynamic`.
