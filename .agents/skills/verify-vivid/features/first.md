# First message

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

A Person contribution and a streamed reply from the selected model persist through the Pi conversation feed. The browser reloads after observing nonempty streaming model text, then requires the same message identities and the completed reply before another reload. GetThread reports a Completed Run.

## How to get to it (user POV)

Sign in to the disposable account and open the Thread created by the public CreateThread RPC. Send Hello Vivid. Signup and New thread controls are separate, unproved entry points.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature first` after Launch and Doctor. Inspect `first/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser first`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Private Threads and an email account created through Better Auth are the default. A legitimate reply can include waiting questions above the composer. The composer remains and its placeholder changes to Reply. Verify the rendered reply without requiring the Message Vivid label. The first-arrival greeting is a separate entry point; use OpenFirstThread and verify its once-only receipt when changing arrival behavior.
