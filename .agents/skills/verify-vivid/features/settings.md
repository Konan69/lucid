# Settings and Integration purpose groups

Model requirement: none for the implemented journeys. Launch still requires provider keys and a real runtime model. The recipes use an unused disposable account, public catalog reads, and the actual Settings dialog. They make no model calls and start no external sign-in.

## Behaviour and entry points

Personal Settings places General, What Vivid knows, Text Vivid, and Devices under You. People, Integrations, Rules, and Record belong under Your space. The [Settings screen](../../../../apps/web/src/screen/Settings.tsx) owns those groups.

The empty [Memory screen](../../../../apps/web/src/screen/settings/Memory.tsx) calls the summary saved knowledge and says that Vivid's own notes are not shown. This checks truthful empty copy, not the content, recall, or privacy of model memory.

The [Integration catalog](../../../../apps/web/src/screen/settings/Connections.tsx) places popular services under purpose headings. A typed search returns one Results group in catalog order. [purpose.ts](../../../../packages/client/state/src/purpose.ts) is shared with the phone. The shipped public RPC is `FindServices`, not `ListServices`.

## Run the recipes

After Launch and Doctor on the unchanged commit, run both recipes with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature settings flue-<id>
.agents/skills/verify-vivid/verify browser settings flue-<id>
```

HTTP requires `ListMemory` to return no facts and an empty brief. It reads popular services and a Gmail search through schema-validated `FindServices`. Gmail and Google Drive must be present in the popular answer. `ListConnections` must remain empty.

Browser opens Settings over its existing empty Thread. This avoids Home's separate arrival journey. It checks the empty knowledge copy before and after reload, then checks the Settings navigation groups. It clicks Integrations and compares the visible popular tiles to the real public catalog answer. Every service must appear once, in catalog order within its group. The visible purpose headings must follow the documented order. Gmail must be under Mail and calendar; Google Drive must be under Files and notes.

Typing Gmail in Search integrations must replace those groups with Results and the real search answer in order. The recipe waits for the actual result tiles, since the app retains the previous catalog while a request is pending. It captures `settings-navigation.json`, `popular-groups.json`, `search-groups.json`, public receipts, snapshots, and screenshots under `browser/settings/`. A final `ListConnections` confirms that browsing connected nothing.

Vivid authors its Google services locally in [google.ts](../../../../apps/server/src/connections/google.ts). [Executor's installed catalog](../../../../apps/server/src/connections/executor.ts) keeps them when its remote feed is unavailable. This lets the recipe check the two named purposes without external Integration credentials. No catalog fixture is installed.

## Blocked subcases

- Correct, Forget, and a populated brief need owned facts created through their real product journey. The empty recipe does not cover them.
- All eight purpose groups and an unclassified service under More need actual catalog entries for those cases. `scope.json` records the observed groups. A two-group result does not prove the rest of the mapping.
- Company navigation labels and permissions need a disposable Company with its real membership session.
- Connecting, naming accounts, sign-in failures, and authorization callbacks need disposable external authority and separate recipes.
- Phone and desktop native Settings need their own client runs. Shared source is not a device proof.

Root owns the live proof stack. These recipes remain unverified until its unchanged-head runs finish and cleanup evidence survives.
