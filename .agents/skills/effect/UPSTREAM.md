# Upstream provenance

- Source: `kitlangton/skills`
- Path: `skills/effect`
- Base: `30dee8607214c893dd89f6eee65c669ef3dce8c9`
- Merged commit: `22c35cb7fd29f931789253fc3c8eb142f2863a8a`
- Merged at: `2026-09-19`

## Owner customizations kept

- Vivid routing and product/runtime guidance in `SKILL.md` and `references/VIVID.md`.
- Vivid branding and standard-library guidance in `references/STANDARD_LIBRARY.md`.
- Official-module discovery for durable work, waits, fanout, workers and persisted state in `references/CAPABILITIES.md`, with its routing lines in `SKILL.md`. Owner-written; upstream has no counterpart.
- `Schema.TaggedError`, which agrees with current upstream and the project-pinned API.

## Refresh changes and conflicts

Merged upstream scheduling metadata/`setInputType` corrections and precise `Stream.paginate` element/termination semantics. Version facts are looked up, never recorded here: `AGENTS.md` owns the pin and the installed package source is the reference. Owner Vivid guidance won wherever generic upstream integration wording would replace repository-specific boundaries.
