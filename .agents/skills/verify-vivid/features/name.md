# The Person's name

Model requirement: a real model. Rehearsal cannot answer what the Person is called, so both recipes are blocked under it.

## Behaviour and entry points

A Person changes the name Vivid calls them in Settings, General, under You: the Name row opens a small form ([web](../../../../apps/web/src/screen/settings/Name.tsx), [phone](../../../../apps/mobile/src/screen/settings/Name.tsx)). Its open, saving and refused states are one machine shared by both surfaces ([naming.ts](../../../../packages/client/state/src/naming.ts)). Save calls `SetPersonName`, which writes the Better Auth user's name ([people/store.ts](../../../../apps/server/src/people/store.ts)); `Me` and `WatchMe` read the Person from that row each time.

At the start of every response the runtime reads `Me` as the acting Person and tells the model their name as one plain line ([context.ts](../../../../packages/agent/runtime/src/context.ts) `loadPerson`, `workingFor`).

## Run the recipes

After Launch and Doctor on the unchanged commit:

```sh
.agents/skills/verify-vivid/verify feature name flue-<id>
.agents/skills/verify-vivid/verify browser name flue-<id>
```

HTTP renames the disposable Person through `SetPersonName`, reads `Me` back, then asks "what’s my name?" in a new Thread and requires the reply to say the new first name.

Browser opens Settings, General over an empty Thread, presses Change, types the name and presses Save. It waits for the form to close and the dialog to show the new name, reads `Me`, reloads and checks the name again, then asks "what’s my name?" through the composer and waits for a Vivid bubble that says it. Snapshots and screenshots (`settings-before`, `name-form`, `settings-renamed`, `settings-reloaded`, `thread-answer`) and `scope.json` stay under `browser/name/`.

## Blocked subcases

- The phone's native sheet needs its own device run.
- A shared Thread names whoever sent each message; that needs a disposable Company with two Persons.
- A provider-given name that is not one plain line is left out of the prompt; no provider sign-in is available here.
