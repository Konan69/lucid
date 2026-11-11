# Watches

Model requirement: a real model with `OPENROUTER_API_KEY` for the server memory/title model and a key for the chosen runtime model. Rehearsal cannot prove this journey.

## Drive the journey

Launch and Doctor on the devbox selected by `devbox-pick`, then run `verify feature watch` and `verify browser watch` with the same explicit run id. Cleanup that run afterwards.

Launch owns disposable PostgreSQL, Helix and Executor beta.23. Its private catalogue offers Verify Pulse, an authored Integration with one key-backed account, one declared event and one emitting mutation. Executor reads this catalogue through its supported `EXECUTOR_CATALOG_URL` setting. Vivid installs a dedicated app through ordinary Connect. Product source and curation stay unchanged.

The HTTP journey signs in with Launch's synthetic Person, finds Verify Pulse and completes Connect through public RPCs. It asks Vivid in a Thread to find events, create a Watch and post each pulse to Feed as a drawn card: the receipt in the card's display and no words beside it. The saved conversation must contain successful `find_events` and `watch` calls. The Watch must be Active before the provider operation is called directly on the disposable Executor.

WatchFeed supplies the delivery signal. WatchThread then proves the background Run completed. The provider receipt, stable background Thread, Run and Feed item must agree. The item's `words` must be null and its `display` must hold the receipt. The post must then tell the Person: WatchNotifications must carry a `posted` notice about the background Thread, titled as the card, with an empty body (a drawn card has no words to quote) and opening the Feed.

The browser journey separately connects through Settings and turns notifications on there (the [push](push.md) recipe's grant and Settings press), sends the request through the composer, and puts the app's tab behind a blank one just before the provider emits. Back on the app's tab, its service worker must be showing the `posted` notice, with the same notification id and a payload that opens the Feed. Headless Chrome draws no notification to press, so the press is not driven: the page is handed that payload as the worker hands it to a window it brings forward (`apps/web/src/worker/main.ts` `open`), and must go to the Feed by itself. There it checks the delivered Feed card shows no words under its title and reloads it, then clicks Disconnect in Settings.

## Prove the whole event and the card's cause

The pulse's words are longer than 4,000 characters and end with a code; the Watch is asked to draw the last word of the words in the card, so the card holds that code only when the whole event reached the model. The background Thread's history must hold the event as an `event` signal with `event: pulse.received` and the code in its text, which is what the Thread draws as "What Vivid saw". The Run's public origin must name the Watch's id and the event's id (the provider receipt).

The card's `provenance` must be `Recorded`: posted by the background Run, caused by that Run's Watch event (`FeedCause.Watch` with the Watch's id and name and the receipt), with that Run as its first evidence. A signed redelivery of the same event must answer 200, start no second Run and leave the provenance unchanged. After removal the card must still be on the Feed with the same provenance, though its Watch row is gone. The browser journey opens the card's Thread, waits for "What Vivid saw" and the end code, reloads and waits again.

## Prove removal

After the first occurrence, the fixture connects an independent account directly at Executor. This replaces its default account link. Vivid's real removal policy preserves apps with unrelated account links, so removing the Person's Integration leaves an actual emitter available. No event is emitted during this setup gap.

After real Remove, the fixture emits another event. Executor's supported `executor-host export` reads a quiesced copy of only this run's provider volume. The inspector uses Executor's pinned PGlite version, in memory. The private export and inspector stay in scratch and disappear at Cleanup. Evidence includes only the selected safe columns.

Require the Watch row to be gone through cascade deletion, its exact provider subscription to be absent or stopped, the second provider event to exist without a queued delivery, and no new Run. A fresh signed delivery for the removed Watch must answer 410. On the old product, the same journey records the Watch still Active and follows the unwanted second delivery to settlement before reporting failure.

## Prove dismissing and resuming the card

After removal the HTTP journey dismisses the delivered card as its X does (`DismissFeedItem`) and reads the Feed twice: both reads must show it Settled, and the background Thread must have no new Run. It then sends `ResumeFeedItem` for the card's work twice with the same Conversation id and key. Both answers must name that one Conversation, it must settle exactly one Run, hold exactly one `carry-on` hand-over carrying the card's title and a reply from Vivid, and the background Thread must still have no new Run. `dismiss-resume.json` records the reads, Run counts and Conversation. This proves the server path only; the phone swipe and the card press on web and phone need their own device and browser runs.

## Evidence

The HTTP evidence is under `watch/`, browser evidence under `browser/watch/`. Each has its own verdict. `proof.json` records the first provider receipt, the end code, Watch id, background Run id, Feed card id, item and the posted notice's id; `posted-notifications.json` holds the notice list that carried it. The browser's `notifications.json` holds what the worker showed. `redelivery.json` records the redelivery's status, Run count and card; `after-remove-card.json` the card after removal. `provider-state.json` records the exact subscription, second event and deliveries. `post-removal.json` records every removal assertion. Browser snapshots and `feed.png` and `feed-reloaded.png` show the delivered card; `thread-event.png` and `thread-event-reloaded.png` show its Thread's event row.

The HTTP journey also creates an Until Watch whose end condition is that a fresh provider read still declares `pulse.received` after its next event. Its background Run must call `find_events` before `finish_watching`. `completion/` retains the completed row, admitted Run, tool history and a subsequent signed callback answering 410. The browser journey retains its existing delivery and removal scope.

## Boundaries

Executor uses host networking and an explicit loopback HTTP policy. Vivid's `PUBLIC_URL` is the disposable web origin, which proxies the real callback. No public tunnel or production authority is needed. Launch verifies the selected alias against Boat's persistent `BOAT_ID`, rather than a replaceable VM hostname.

This recipe does not prove native clients, pressing a drawn system notification, conversational list/stop or made-Integration reminders. Those need separate journeys.
