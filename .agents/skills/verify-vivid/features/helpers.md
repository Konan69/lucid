# Helpers

Model requirement: needs a real model. Rehearsal cannot start a helper.

## Sub-features

Vivid splits a request into helpers that work at the same time (`spawn_run`). Each helper is a bounded Run with a fixed kind of tools, its own conversation and a budget. Its result comes back to the Thread as a `child-result` delivery, once, and Vivid answers from the results. A Person can stop one helper from its row; Vivid hears it was stopped. Thread Stop stops every helper first.

## How to get to it (user POV)

Ask for work with independent parts, such as comparing several pages. Under the step that started them the reply shows "2 helpers took parts of this" and one row per helper with its brief and state. A row opens to its answer. While a helper works its row has its own Stop. The Thread stays Working in the list while any helper works.

## Driving it with verify-vivid

After Launch and Doctor on the unchanged commit:

```sh
.agents/skills/verify-vivid/verify feature helpers pi-<id>
.agents/skills/verify-vivid/verify browser helpers pi-<id>
.agents/skills/verify-vivid/verify feature helperstop pi-<id>
.agents/skills/verify-vivid/verify browser helperstop pi-<id>
```

`helpers` asks the real model, in a Person's words, to have two helpers read two public RFC pages at once and compare them. Public `WatchThread` publications are retained until every helper and Run has ended and the newest Run is a `ChildResult` one. The recipe requires two or more Completed helpers, a publication with two of them Working at once, a runtime receipt on every `vivid_child_runs` row, `GetChildRun` answers with text and measured usage, exactly one `child-result` delivery per helper in history, and a final answer that uses the pages. Browser sends through the composer, waits for the rows, requires a Done row per helper before and after reload, and opens one row to its answer.

`helperstop` asks for one quick helper and one slow one (four long RFCs). Once the slow one is Working it is stopped: HTTP through public `CancelChildRun`, browser with its own row's Stop. It must end Stopped by a Person while its sibling completes, `GetChildRun` must say Stopped, and history must hold one `child-result` delivery for it saying it was stopped by a person.

Evidence: `helpers/`, `helperstop/`, `browser/helpers/` and `browser/helperstop/` retain the WatchThread publications (`*-seen.json`), the SQL rows, the opened results, history, screenshots and the verdict.

## Blocked subcases

- Executor and ComputerUse helpers: blocked: no proof-owned Computer. ReadOnly reads the Computer's files: blocked for the same reason. The Researcher kind is the one proved.
- `wait_runs`, `check_run` and `cancel_run` by Vivid itself are not asked for here; the DB-backed suite `apps/server/src/runs/store.test.ts` covers a Vivid stop staying quiet.
- Thread Stop with helpers at work, restart and cell owner moves across spawn, report and stop are not driven.
- Phone and desktop native rows need their own device runs.

## Gotchas

The model decides whether to split the work. A run where it reads the pages itself fails the journey; it is not a pass. Overlap is read from WatchThread publications, not from elapsed time. The slow helper in `helperstop` is the one whose brief names RFC 9110; a model that merges both tasks into one helper fails the journey.
