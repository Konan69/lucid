# Project state

Model requirement: needs a real model. Rehearsal cannot prove it.

## Sub-features

A Project knows what done means, where it stands and the next step (`ProjectWork`, `packages/contracts/src/projects.ts`). A new Project, and every Project made before this existed, is `Unspecified` and draws no goal. Vivid records the work from conversation through `update_project`: `Define` sets the objective and next step, `Progress` adds a dated line and the next step after it, and `Complete` marks it done with a proof the server cites from the Run's own messages (the Person saying so, or Vivid's reply holding what it observed). Every change compares the revision Vivid read (`ProjectChanged` on a mismatch). There is no form: the Project page on web and phone reads the work under "Where it stands" as Goal, Latest (with its date) and Next, or Goal and Done with a link to the Thread holding the proof.

## How to get to it (user POV)

Make a Project called "Site launch". In any Thread, say: "We're launching the site, that's my Site launch project. It's done when the domain resolves." Later say: "Update on Site launch: I bought the domain this morning and pointed it at the host." Open the Project from the sidebar. "Where it stands" shows the goal, that line with its date, and the next step.

## Driving it with verify-vivid

After Launch and Doctor, run `verify feature projects <run>` and `verify browser projects <run>` on the unchanged commit, then `verify cleanup <run>`.

The HTTP recipe ([projects.mjs](../scripts/projects.mjs)) makes the Project with `CreateProject` and checks it is `Unspecified`. It sends the two sentences above and then "Good news on Site launch: the domain resolves now." through the public Thread transport, waits for each Run's WatchThread settlement, requires a successful `update_project` call in each Run, and reads `ListProjects` after each: `Active` with an objective about the domain and a next step; then a progress line about the domain or host, dated after the message and attributed to Vivid, with the objective unchanged; then `Completed` with a proof whose source is a message this Thread holds.

The browser recipe ([projectsbrowser.mjs](../scripts/projectsbrowser.mjs)) makes the Project the same way, types the first two sentences into the composer and presses Send, opens `/projects/<id>`, waits for "Where it stands", reads its Goal, Latest and Next lines from the page and compares them with the listed Project, reloads, and reads the same lines again.

## Evidence

HTTP under `projects/`: `created.json`, `define-calls.json`, `defined.json`, `progress-calls.json`, `progressed.json`, `done-calls.json`, `done.json`, `scope.json`. Browser under `browser/projects/`: `thread.png`, `project.png`, `reloaded.png`, `drawn.json` and the snapshots.

## Gotchas

The model may ask what the Project is before recording it, or record the goal and the progress in one call; the journey then fails on the missing call or state, which is a behaviour finding, not a flake. Company Projects, a Member who cannot open the proof Thread, the Done line and its link on the page, and the phone and desktop pages are not driven by these recipes; the phone needs its own emulator run.
