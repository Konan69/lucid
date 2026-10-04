# Upstream provenance

- Source: VCOS owner skill
- Source type: `owner`
- Path: `.agents/skills/improve-codebase-architecture` in the VCOS repository
- Merged commit: `7f38dca4730a480d4ab0481675c38f632a1d8922` (owner introduction commit)
- Merged at: `2026-09-19`

No discoverable external upstream exists.

## Vivid adaptations

`LANGUAGE.md`, `DEEPENING.md` and `HTML-REPORT.md` match the owner source. The rest differs:

- `SKILL.md`: step 2 "Inspect SDK replacements" checks each candidate against installed SDK source and the Effect skill's `references/CAPABILITIES.md`, and the report card carries its result.
- `SKILL.md`, `INTERFACE-DESIGN.md`: the domain sources are `AGENTS.md` (Product language) and the numbered `docs/` references. `CONTEXT.md` and ADRs are read when present, never required or created.
- `SKILL.md`: when the user has already chosen the candidate or the fix, the report and grilling are skipped; the report is shown through the host preview, and a desktop window opens only on request.
- `SKILL.md`: exploration searches with `rg`, per `AGENTS.md`.

A refresh from the owner source keeps these.
