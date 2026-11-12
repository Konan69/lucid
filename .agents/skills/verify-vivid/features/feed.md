# Feed

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Person sees work in every readable Thread they own, including ordinary Conversations. An empty Conversation stays out. Working Runs appear, questions and Approvals make items Waiting, and completed or stopped work appears in Handled. Waiting and Working items remain visible; Handled history is limited to 100 items from the last 24 hours.

A Conversation without a posted card has no persisted seen state; putting it away writes a dismissal (`DismissFeedItem`), which these recipes do not drive. Visibility must send no `MarkFeedCard` request for that derived item. Desktop Stop must publish Feed settlement even when later runtime settlement changes nothing.

## How to get to it (user POV)

Start an ordinary Thread and send a message. Open Feed to see its handled work, or open a waiting item to answer in its Thread.

## Driving it with verify-vivid

After Launch and Doctor, run `verify feature feed <run>` and `verify browser feed <run>` on the unchanged combined commit. Run `verify cleanup <run>` afterward. These recipes cover ordinary Conversations only. Real-model calls use the shipped gateway and durable history. Rehearsal remains plumbing-only.

The HTTP recipe checks empty Conversation exclusion and a real completed reply in Handled. Public `AskInput` with disposable runtime authority creates a question through its owning handler. `question-waiting.json` records the subscribed-before-write `WatchFeed` transition. This proves question projection, not model question generation. A separate real Run must be observed Working before public `ReportDeviceStop` stops it. `desktop-stop-settled.json`, `settlement.json`, and repeated-stop receipts prove settlement publication and stable repeat behavior. A Run that finishes before Stop fails the journey. No fixture Run or synthetic Feed row is written.

The browser recipe opens a real completed Conversation's question on Feed, opens its Thread, returns, and reloads. Screenshots and semantic DOM checks prove the waiting card survives. Chrome's public network events observe the actual live transport without replacing it. `rpc-traffic.json` must contain `WatchFeed` and no `MarkFeedCard` for the derived card after its visibility callbacks. The browser recipe owns and closes its CDP observer; the shared browser driver retains its existing process cleanup.

Neither recipe has been run for the recovery commit yet. A recipe implementation is not verification evidence. Record both verdicts, head, working-tree status, real model, host, and surviving evidence directory before claiming proof.

## Gotchas

These recipes never post a card. Any Thread the Person owns with an acting Run may `Post`, a Conversation as well (`apps/server/src/feed/handlers.ts`); a card posted from a Conversation is unproved. A posted card, drawn with no words, is proved by the [Watch recipe](watch.md). Its last steps also prove, over HTTP, a posted card's silent dismissal, the new Conversation a press on it starts, an answer that opens a chat, and a Conversation that opens in place. That a dismissal stays away over a question already waiting is covered by the database-backed Feed test. Posted-card actions, Done, retry, successful seen marks, and display Query/Mutation execution remain unproved. The ordinary-Thread recipe does not activate Watches or establish those paths. The device permission recipe is separate and unchanged.

Phone and desktop native controls require device runs, including the phone's list/stack toggle, two-way swipe and a chat's own card over its composer. The HTTP desktop Stop report proves the server boundary, not the native Stop control. Database-backed Feed tests separately cover owner isolation, empty first Threads, old-history dating, and idempotent Stop announcements.
