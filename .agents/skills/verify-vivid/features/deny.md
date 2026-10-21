# Deny an action

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Approval becomes Denied, a Decision Run settles and the external disposable system has no mutation.

## How to get to it (user POV)

Open a Thread with a real pending action from a disposable Integration. Deny it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature deny` after Launch and Doctor. Inspect `deny/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser deny`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked without a real pending action and a disposable Integration. Capture external state before and after the decision.
