# Allow an action

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The saved digest-bound Approval succeeds, the external disposable system changes exactly once and a successor Decision Run settles.

## How to get to it (user POV)

Open a Thread with a real pending action from a disposable Integration. Review the oldest pending Approval above the composer and choose Allow. Always allow is a separate option with destructive-action and shared-Thread restrictions.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature approve` after Launch and Doctor, then run `verify browser approve`. Both commands currently return blocked before exercising the journey. Inspect `approve/verdict.json` and `browser/approve/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Both recipes are blocked regardless of model credentials. The proposed proof needs a connected disposable Integration and an implemented action recipe. Product Approvals can also address Browser or Desktop actions. Do not substitute a private Gate proposal and call that the Person journey. Controls live above the composer in screen/thread/Allow.tsx; history retains the outcome.
