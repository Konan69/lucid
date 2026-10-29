# Waiting on

One record per thing owed to a Person, in their current workspace. Company membership does not grant access to another Person's list. `ownedHere` scopes every read and write; tracking also requires access to its source Thread in that workspace.

`OwedStore` owns persistence and transitions. A nudge increments the count and records its sending time. Resolved and Dropped are terminal. Row locking serializes transitions so racing nudges retain both increments. Every write calls `changed(actor)` after commit. `ListOwed` and `WatchOwed` share one loader.

Open and Nudged records appear first, soonest deadline first with undated work last. Closed records follow, newest change first. State is schema-encoded JSON, timestamps are epoch milliseconds, and source Threads own cascading deletion.
