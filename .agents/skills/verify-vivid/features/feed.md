# Feed

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Person sees work in every readable Thread they own, including ordinary Conversations. An empty Conversation stays out. Working Runs appear, questions and Approvals make items Waiting, and completed or stopped work appears in Handled. Waiting and Working items remain visible; Handled history is limited to 100 items from the last 24 hours.

A Conversation without a posted card has no persisted seen or Done state. Visibility must send no `MarkFeedCard` request for that derived item. Desktop Stop must publish Feed settlement even when later runtime settlement changes nothing.

## How to get to it (user POV)

Start an ordinary Thread and send a message. Open Feed to see its handled work, or open a waiting item to answer in its Thread.

## Driving it with verify-vivid

After Launch and Doctor, run `verify feature feed <run>` and `verify browser feed <run>` on the unchanged combined commit. Run `verify cleanup <run>` afterward. These recipes cover ordinary Conversations only. Real-model calls use the shipped gateway and durable history. Rehearsal remains plumbing-only.

The HTTP recipe checks empty Conversation exclusion and a real completed reply in Handled. Public `AskInput` with disposable runtime authority creates a question through its owning handler. `question-waiting.json` records the subscribed-before-write `WatchFeed` transition. This proves question projection, not model question generation. A separate real Run must be observed Working before public `ReportDeviceStop` stops it. `desktop-stop-settled.json`, `settlement.json`, and repeated-stop receipts prove settlement publication and stable repeat behavior. A Run that finishes before Stop fails the journey. No fixture Run or synthetic Feed row is written.

The browser recipe opens a real completed Conversation's question on Feed, opens its Thread, returns, and reloads. Screenshots and semantic DOM checks prove the waiting card survives. Chrome's public network events observe the actual live transport without replacing it. `rpc-traffic.json` must contain `WatchFeed` and no `MarkFeedCard` for the derived card after its visibility callbacks. The browser recipe owns and closes its CDP observer; the shared browser driver retains its existing process cleanup.

Neither recipe has been run for the recovery commit yet. A recipe implementation is not verification evidence. Record both verdicts, head, working-tree status, real model, host, and surviving evidence directory before claiming proof.

## Gotchas

These recipes never post a card: `Post` answers only a Background Thread with an acting Run. A posted card, drawn with no words, is proved by the [Watch recipe](watch.md). Posted-card actions, Done, retry, successful seen marks, and display Query/Mutation execution remain unproved. The ordinary-Thread recipe does not activate Watches or establish those paths. The device permission recipe is separate and unchanged.

Phone and desktop native controls require device runs. The HTTP desktop Stop report proves the server boundary, not the native Stop control. Database-backed Feed tests separately cover owner isolation, empty first Threads, old-history dating, and idempotent Stop announcements.

## Spoken contact hours

Run `verify feature pacing <run>` with a real model. The recipe in
[pacing recipe](../scripts/pacing.mjs) asks “Don't message me before 11 in the morning” without naming
any tool or field. GetSettings and history must show the model saved 660–1290 local
minutes. Memory remains prose. A Watch on the disposable Verify Pulse Integration
then produces one ordinary report and one urgent security alert through the real
background model and Post path.

The recipe chooses an IANA zone currently before eleven. With no browser present,
it runs the production pacer over the Launch-owned database at controlled future
local ten and eleven, after the quiet stretch. SQL connections keep their real
clock. At ten there is no ordinary notice; at eleven exactly one quiet `posted`
notice exists, including after a repeated pass. The actual urgent Post, while the
real clock is outside the window, must immediately owe one `needs-you` notice.
The real server consumes the persisted delivery queue. This proves notice creation
and pacing, not receipt on a physical phone or browser. The existing Feed browser
recipe remains the rendering proof; pacing has no new Settings control.

Retain `spoken-hours.json`, history, provider event receipts, clock receipts,
`outside-notices.json`, `inside-notices.json`, `urgent-outside-notices.json`, and the
pacing verdict. A recipe implementation without those receipts is unverified.
