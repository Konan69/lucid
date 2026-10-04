---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase, informed by the project's domain language and recorded decisions, and checked against what the installed SDKs already supply. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; recorded decisions are not re-litigated.

In Vivid the domain sources are `AGENTS.md` (Product language) and `docs/01-principle.md`, `docs/03-surface.md`, `docs/09-platform-architecture.md` and `docs/17-backend-stack-reference.md`. `CONTEXT.md` and an ADR directory are read when they exist and are created only by an explicit domain-modeling task.

The user's instructions win over this process. When they have already chosen the candidate or asked for the fix, skip the report and its closing question (step 3) and the grilling (step 4): run steps 1 and 2 for that candidate, give a short status, and do the work.

## Process

### 1. Explore

Read the domain sources above for the area you're touching first.

Then walk the codebase, searching with `rg` (`rg --files` to list, `rg` to match) and reading what it finds. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Inspect SDK replacements

Before a candidate proposes a new custom module, or keeps one, check whether an installed SDK already owns that job. Read the matching skill branch and the installed source it points to; for Effect that is `.agents/skills/effect/SKILL.md` and its Branch Chooser, with `.agents/skills/effect/references/CAPABILITIES.md` for durable work, waits, fanout, workers and persisted state. Apply the **deletion test** to the custom module against the SDK: if the SDK supplies the guarantee, the module is a pass-through.

Done when every such candidate records three things:

- **Evidence** — the SDK modules inspected, with file and symbol, and whether each fact is installed, released or unreleased
- **Guarantees** — which required guarantees the SDK supplies and which it does not
- **Remaining proof** — what is still unverified, and the real-seam test that would settle it

A candidate is adopted or rejected on those guarantees, never on the module's name.

### 3. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp directory so nothing lands in the repo. Resolve the temp dir from `$TMPDIR`, falling back to `/tmp` (or `%TEMP%` on Windows), and write to `<tmpdir>/architecture-review-<timestamp>.html` so each run gets a fresh file. Show it through the host's own preview when one exists (an in-app or offscreen preview), and tell the user the absolute path. A window opened with `xdg-open`, `open` or `start` belongs to the user's desktop: run those only when the user asks.

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for diagrams where a graph/flow/sequence reliably communicates the structure. Mix Mermaid with hand-crafted CSS/SVG visuals — use Mermaid when relationships are graph-shaped (call graphs, dependencies, sequences), and hand-built divs/SVG when you want something more editorial (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**. Be visual.

For each candidate, the same template as before, but rendered as a card:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **SDK inspection** — the evidence, guarantees and remaining proof from step 2, or "none applies" with the reason
- **Before / After diagram** — side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use the project's domain vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** If the domain defines "Routine," talk about "the Routine trigger module" — not "the FooBarHandler," and not "the Routine service."

**Decision conflicts**: if a candidate contradicts a recorded decision (`AGENTS.md`, the `docs/` references, or an ADR where one exists), only surface it when the friction is real enough to warrant revisiting the decision. Mark it clearly in the card (e.g. a warning callout: _"contradicts docs/09 — but worth reopening because…"_). Don't list every theoretical refactor a decision forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

### 4. Grilling loop

Once the user picks a candidate from the report, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept the domain sources lack, or sharpening a fuzzy term?** Use the Product language in `AGENTS.md`; when no term fits, name the gap and ask. A new domain term or a new `CONTEXT.md` is the user's decision.
- **User rejects the candidate with a load-bearing reason?** Offer to record it where the project keeps decisions, framed as: _"Want me to record this so future architecture reviews don't re-suggest it?"_ Only offer when a future explorer would need the reason to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).
