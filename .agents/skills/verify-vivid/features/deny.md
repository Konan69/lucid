# Deny an action

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Approval becomes Denied, a Decision Run settles and the external disposable system has no mutation.

## How to get to it (user POV)

Open a Thread with a real pending action from a disposable Integration. Choose Don’t allow above the composer. History retains the denial after the decision.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature deny` after Launch and Doctor, then run `verify browser deny`. Both commands currently return blocked before exercising the journey. Inspect `deny/verdict.json` and `browser/deny/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Both recipes are blocked. The proposed proof needs a real pending action from a disposable Integration and an implemented recipe. Product Approvals can also address Browser or Desktop actions. Capture external state before and after the decision.
