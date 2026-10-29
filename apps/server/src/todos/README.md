# To-dos

A Person's own to-do list, in their current workspace: what they mean to do, which Vivid adds to and ticks off. Company membership does not grant access to another Person's list. `ownedHere` scopes every read and write; adding also requires access to its source Thread in that workspace.

`TodoStore` owns persistence and transitions. Done and Dropped are terminal. Ticking off a to-do already done answers with it unchanged, keeping the time it was first done; any other change to a closed to-do is a Conflict. Row locking serializes racing tick-offs. Every write that moves a to-do calls `changed(actor)` after commit. `ListTodos` and `WatchTodos` share one loader.

Open to-dos appear first, soonest date first with undated ones last. Closed ones follow, newest change first. State is schema-encoded JSON, timestamps are epoch milliseconds, and source Threads own cascading deletion.
