# The Person's name

Model requirement: a real model. Rehearsal cannot answer what the Person is called, so both recipes are blocked under it.

## Behaviour and entry points

A Person changes the name Vivid calls them in Settings, General, under You: the Name row opens a small form ([web](../../../../apps/web/src/screen/settings/Name.tsx), [phone](../../../../apps/mobile/src/screen/settings/Name.tsx)). Its open, saving and refused states are one machine shared by both surfaces ([naming.ts](../../../../packages/client/state/src/naming.ts)). Save calls `SetPersonName`, which writes the Better Auth user's name ([auth/person.ts](../../../../apps/server/src/auth/person.ts)); `Me` and `WatchMe` read the Person from that row each time.

At the start of every response the runtime reads `Me` as the acting Person and tells the model their name as one plain line ([context.ts](../../../../packages/agent/runtime/src/context.ts) `loadPerson`, `workingFor`).

## Run the recipes

After Launch and Doctor on the unchanged commit:

```sh
.agents/skills/verify-vivid/verify feature name flue-<id>
.agents/skills/verify-vivid/verify browser name flue-<id>
```

HTTP renames the disposable Person to Juniper Okafor through `SetPersonName`, reads `Me` back, then asks "what’s my name?" in a new Thread and requires the reply to say the new first name.

Browser opens Settings, General over an empty Thread, presses Change, types Marisol Achebe (a different name, so either recipe may run first on the shared account) and presses Save. It waits for the form to close and the dialog to show the new name, reads `Me`, reloads and checks the name again, then asks "what’s my name?" through the composer and waits for a Vivid bubble that says it. Snapshots and screenshots (`settings-before`, `name-form`, `settings-renamed`, `settings-reloaded`, `thread-answer`) and `scope.json` stay under `browser/name/`.

On Android, after `verify android provision <alias>` and Launch on the same host ([Android setup](../references/android.md)):

```sh
.agents/skills/verify-vivid/verify phone name flue-<id>
```

The phone recipe installs the commit's APK, signs in with email, opens Settings from the menu, presses Your name, types Tobenna Ruiz and presses Save. It waits for the sheet to close and the row to show the name, and reads `Me` back. It makes no model call. Screenshots (`settings-before`, `name-sheet`, `settings-renamed`) stay under `phone/`.

## Blocked subcases

- The iPhone's sheet needs the phone itself or a macOS runner.
- A shared Thread names whoever sent each message; that needs a disposable Company with two Persons.
- A provider-given name that is not one plain line is left out of the prompt; no provider sign-in is available here.
