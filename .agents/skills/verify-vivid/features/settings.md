# Settings and Integration purpose groups

Model requirement: none for the implemented journeys. Launch still requires provider keys and a real runtime model. The recipes use the disposable account, public catalog reads, and the actual Settings dialog. They make no model calls and start no external sign-in.

## Behaviour and entry points

Personal Settings places General, What Vivid knows, What Vivid is doing, Text Vivid, and Devices under You. People, Integrations, Rules, and Record belong under Your space. The [Settings screen](../../../../apps/web/src/screen/Settings.tsx) owns those groups.

The [Memory screen](../../../../apps/web/src/screen/settings/Memory.tsx) shows what the Person's cell remembers: the standing pages Vivid has written, then the newest lines, read through `GetMemoryIndex` each time Settings opens. The recipe compares the visible list with the current index and checks for obsolete Memory section headings. It does not check the content, recall, or privacy of model memory.

The [Integration catalog](../../../../apps/web/src/screen/settings/Connections.tsx) places Text Vivid channel tiles first, then popular services under purpose headings. A typed search filters the channel tiles by name and returns one Results group in the order `searchCatalog` ranks it ([curation.ts](../../../../apps/server/src/connections/curation.ts)): the exact name, then a priority service the query names by name or category, then other name words, then category and description. [purpose.ts](../../../../packages/client/state/src/purpose.ts) is shared with the phone. The shipped public RPC is `FindServices`, not `ListServices`.

## Run the recipes

After Launch and Doctor on the unchanged commit, run both recipes with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature settings pi-<id>
.agents/skills/verify-vivid/verify browser settings pi-<id>
```

HTTP reads the actual `GetMemoryIndex`. Earlier real-model journeys can populate it through learning. It reads popular services and a Gmail search through schema-validated `FindServices`. Gmail and Google Drive must be present in the popular answer. `ListConnections` must be unchanged, since earlier journeys on the same launch may have connected Verify Pulse.

Browser opens Settings over its existing empty Thread. This avoids Home's separate arrival journey. It checks the current listed descriptions, or the empty sentence when the index has no lines, before and after reload, and checks for obsolete section headings, then checks the Settings navigation groups. It clicks Integrations and compares the visible popular tiles to the real public catalog answer. Every service must appear once, in catalog order within its group. The visible purpose headings must follow the documented order. Gmail must be under Mail and calendar; Google Drive must be under Files and notes.

Typing Gmail in Search integrations must replace those groups with Results and the real search answer in order. The recipe waits for the actual result tiles, since the app retains the previous catalog while a request is pending. It captures `settings-navigation.json`, `popular-groups.json`, `search-groups.json`, public receipts, snapshots, and screenshots under `browser/settings/`. A final `ListConnections` confirms that browsing connected nothing.

Vivid authors its Google services locally in [google.ts](../../../../apps/server/src/connections/google.ts). [Executor's installed catalog](../../../../apps/server/src/connections/executor.ts) keeps them when its remote feed is unavailable. This lets the recipe check the two named purposes without external Integration credentials. No catalog fixture is installed.

## Blocked subcases

- Correct, Forget, standing pages, a populated list and Show older need memory written through the real product journey. The list recipe does not cover editing them.
- All eight purpose groups and an unclassified service under More need actual catalog entries for those cases. `scope.json` records the observed groups. A two-group result does not prove the rest of the mapping.
- Company navigation labels and permissions need a disposable Company with its real membership session.
- Connecting, naming accounts, sign-in failures, and authorization callbacks need disposable external authority and separate recipes.
- Phone and desktop native Settings need their own client runs. Shared source is not a device proof.

Root owns the live proof stack. These recipes remain unverified until its unchanged-head runs finish and cleanup evidence survives.
