# Watches

Model requirement: a real model with `EXPLABS_API_KEY` for the server memory/title model and a key for the chosen runtime model. Rehearsal cannot prove this journey.

## Drive the journey

Launch and Doctor on the devbox selected by `devbox-pick`, then run `verify feature watch` and `verify browser watch` with the same explicit run id. Cleanup that run afterwards.

Launch owns disposable PostgreSQL, Helix and Executor beta.23. Its private catalogue offers Verify Pulse, an authored Integration with one key-backed account, one declared event and one emitting mutation. Executor reads this catalogue through its supported `EXECUTOR_CATALOG_URL` setting. Vivid installs a dedicated app through ordinary Connect. Product source and curation stay unchanged.

The HTTP journey signs in with Launch's synthetic Person, finds Verify Pulse and completes Connect through public RPCs. It asks Vivid in a Thread to find events, create a Watch and post each pulse to Feed. The saved conversation must contain successful `find_events` and `watch` calls. The Watch must be Active before the provider operation is called directly on the disposable Executor.

WatchFeed supplies the delivery signal. WatchThread then proves the background Run completed. The provider receipt, stable background Thread, Run and Feed item must agree. The browser journey separately connects through Settings, sends the request through the composer, checks the delivered Feed card and reloads it, then clicks Disconnect in Settings.

## Prove removal

After the first occurrence, the fixture connects an independent account directly at Executor. This replaces its default account link. Vivid's real removal policy preserves apps with unrelated account links, so removing the Person's Integration leaves an actual emitter available. No event is emitted during this setup gap.

After real Remove, the fixture emits another event. Executor's supported `executor-host export` reads a quiesced copy of only this run's provider volume. The inspector uses Executor's pinned PGlite version, in memory. The private export and inspector stay in scratch and disappear at Cleanup. Evidence includes only the selected safe columns.

Require the Watch row to be gone through cascade deletion, its exact provider subscription to be absent or stopped, the second provider event to exist without a queued delivery, and no new Run. A fresh signed delivery for the removed Watch must answer 410. On the old product, the same journey records the Watch still Active and follows the unwanted second delivery to settlement before reporting failure.

## Evidence

The HTTP evidence is under `watch/`, browser evidence under `browser/watch/`. Each has its own verdict. `proof.json` records the first provider receipt, Watch id, background Run id, Feed card id and item. `provider-state.json` records the exact subscription, second event and deliveries. `post-removal.json` records every removal assertion. Browser snapshots and `feed.png` and `feed-reloaded.png` show the delivered card.

## Boundaries

Executor uses host networking and an explicit loopback HTTP policy. Vivid's `PUBLIC_URL` is the disposable web origin, which proxies the real callback. No public tunnel or production authority is needed. Launch verifies the selected alias against Boat's persistent `BOAT_ID`, rather than a replaceable VM hostname.

This recipe does not prove native clients, conversational list/stop or made-Integration reminders. Those need separate journeys.
