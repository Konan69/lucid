# Upstream provenance

- Source: `HelixDB/skills`
- Path: `skills/helix-memory-system`
- Base: unknown owner v3-era copy
- Merged commit: `199e5d03a18181fef535826e78de9922bd6fd9f1`
- Merged at: `2026-09-19`

## Merge notes

Replaced upstream-owned files with the current v3.0.2 skill. Current conflict/reload/replay guidance was merged. The owner's empty-result invariant is preserved by the stronger current wording: at-most-one is `null`, collection/fold/mutation empties are `[]`, and scalar `0`/`false` remain scalar. The shared error-handling link is adapted to a vendored local path. No owner conflict remained.
