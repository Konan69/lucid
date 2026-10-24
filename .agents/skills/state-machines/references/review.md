# Reviewing a machine

Give this to the reviewer with the diff. Each finding cites file and line, names the rule, and shows the smallest correction. A deliberate ownership choice that is not wrong is a question, not a finding.

## Per state

- What data does it own, and is every field true for the whole time it is active? Is any field also held somewhere else (a component, a store, another state)?
- Which events does it take? For each event it does not take, is refusing right?
- What work does it own, what starts it, and what does leaving the state do to it? Does every reachable outcome (`onDone`, each typed failure, stream end) go somewhere a screen can word?
- Can a late outcome or a stale event (another attempt id, a closed form) change it? How is that declined?

## Per event

- Is it named for what was asked or what happened, not for a setter?
- Does it carry the facts the machine cannot know (attempt id, time, idempotency key), and nothing it already knows?
- Is its transition pure: no clock, randomness, id, service call or await?

## Boundaries (from the library's machine-review.md)

| Layer | Owns |
| --- | --- |
| Machine | State, transitions, workflow decisions, effect lifetimes, service execution |
| Atoms | Selection, projections, keyed lookup |
| Component | Rendering, turning a press into a domain event |
| Registry | One deliberate ownership boundary, or none |

Search the components, hooks and adapters for service calls, `Effect.run*`, promises, browser APIs, timers and chains of `send` calls; anything that coordinates the workflow there belongs in the machine. Search for a composite `Atom.family` that returns `{ state, send }` around a machine, `useMemo` around family lookup, and a `machineAtoms.make` inside a component with no stable owner.

## Vivid rules

- One exhaustive `.match` per screen over what the machine exposes; no `if`/`else` over state names.
- The control is disabled from the machine's reading and the machine refuses the event too. Only a documented gesture reservation lives outside.
- The machine imports nothing from React, the DOM or React Native; apps import `@vivid/state`, not the library.
- The old `useState`, flags and callbacks are gone on every surface, and the lint ceiling equals the measured count.
- No pure state tests were added; the proof is a verify-vivid run (and a database-backed test when the server is involved).
- Server guarantees (idempotency keys, attempt checks, transactions) are unchanged.
