# To-dos

Model requirement: needs a real model. Rehearsal cannot prove it.

## Sub-features

The Person has their own to-do list (`Todo`, `packages/contracts/src/todos.ts`), which Vivid adds to when they ask or clearly commit to something, and ticks off on evidence it was done. A to-do starts Open and closes as Done or Dropped; ticking off one already done answers with it unchanged. The Feed lists open to-dos under "To do", below "Waiting on", soonest date first. Each row says what to do and, when there is a date, when it is due. A row opens the Thread it was added in. Its check (web hover, focus or touch; phone hold menu) ticks it off; the menu also removes it from the list. A closed row folds away at once and leaves the list for good.

## How to get to it (user POV)

In any Thread, say "Add renew my passport to my list." Open Feed. The row is under "To do". Say "I renewed it." in the same Thread, or press the row's check, or hold it on the phone and choose Done.

## Driving it with verify-vivid

After Launch and Doctor, run `verify feature todos <run>` and `verify browser todos <run>` on the unchanged commit, then `verify cleanup <run>`.

The HTTP recipe ([todos.mjs](../scripts/todos.mjs)) sends "Add renew my passport to my list." through the public Thread transport, waits for WatchThread settlement, requires exactly one successful `add_todo` call in that Run, and reads `ListTodos` for exactly one open passport to-do naming that Thread. It then sends "I renewed it." in the same Thread, requires exactly one successful `complete_todo` call in the second Run, and reads the same to-do back as Done.

The browser recipe ([todosbrowser.mjs](../scripts/todosbrowser.mjs)) types the add sentence into the composer and presses Send, opens `/feed`, waits for "To do" and the row, and captures `feed.png`. Back in the Thread it sends "I renewed it." and reads the passport to-do as Done, then sends "Also add book the dentist to my list.". On `/feed` it checks the passport row is gone and the dentist row is shown, presses the row's "Done: book the dentist" check, waits for the row to fold, reloads, checks the row is absent, and reads that to-do as Done.

## Evidence

HTTP under `todos/`: `add_todo-calls.json`, `complete_todo-calls.json`, `listed.json`, `completed.json`, `scope.json`. Browser under `browser/todos/`: `thread.png`, `feed.png`, `ticked.png`, `feed-second.png`, `pressed.png`, `reloaded.png` and their snapshots.

## Gotchas

Calendar placement has a separate [work-block recipe](calendar.md) using the disposable Calendar Integration. Remove from list through the menu, and the phone's hold menu, are not driven by these recipes; the phone needs its own emulator run. The model may ask a follow-up instead of adding at once, or answer "I renewed it." without ticking off; the journey then fails on the missing tool call, which is a real behaviour finding, not a flake. Both recipes use the same Person: a passport to-do left open by a failed HTTP journey is the one the browser journey adds again (the same words open on the list are one to-do), so the browser recipe then finds no passport in its own Thread. Run the pair after a fresh Launch.
