# Mail and Calendar behaviour

Model requirement: a real shipped model. Rehearsal is refused. This suite measures model behaviour through the real Person chat path. A failed metric is a result, not permission to change product source.

## Run

Set `VIVID_VERIFY_WORLD` to a private directory on the selected devbox before Launch. It holds `mail.json`, `calendar.json` and `scenarios.json`, each mode 0600. The directory must be outside the checkout. Launch generates Mail and Calendar app sources in memory and offers them through Executor's real catalogue. Without the setting, only the existing Verify Pulse app is offered. Connect uses FindServices, BeginConnection and CompleteConnection, including the secure code step.

Run Launch and Doctor, then `verify behaviour <run> --trials 1`. Every trial signs up its own Person, so no memory, Connection or sent mail carries from one trial to the next. Increase `--trials N` for repeated measurements. `--scenarios file` selects another private scenario file. Cleanup the run afterwards. No browser recipe or screenshots are needed for this history and provider-state measurement. It does not prove how the display looks on any client.

Every trial removes earlier Mail and Calendar connections through public RPCs, connects the scenario's services, creates a fresh Thread, sends each Person contribution with `wire.mjs` chat, waits on WatchThread, and saves raw history. Mail and Calendar writes persist in the copied app's SQLite database. Provider-side read tools inspect sent messages and created events. A later thread/event read must return each write unchanged. Sends stay inside this disposable app; they do not send internet email or change a production calendar.

## Private input format

`mail.json` contains `owner` with `name`, `email`, `timezone`, and `threads`. Each thread has `id`, `subject`, `labels`, and `messages`. Each message has `from`, `to`, `date`, `body`, and optional attachment filenames in `attachments`.

`calendar.json` contains `timezone`, `calendars` with `name`, and `events`. Each event has `calendar`, `title`, ISO datetime `start` and `end`, and optional `meet` and `attendees`.

`scenarios.json` is an array. Scenario ids must be unique lowercase words with optional hyphens. `connected` lists `Mail`, `Calendar`, both, or neither. `words` holds successive Person messages in the same trial Thread. Use the Person's words, never tool names. All check fields are required. Patterns use JavaScript regular expressions, case insensitive.

```json
[
  {
    "id": "inbox",
    "connected": ["Mail"],
    "words": ["Anything I need to deal with in my email?"],
    "checks": {
      "replyIncludes": [],
      "replyExcludes": [],
      "mailSent": 0,
      "calendarCreated": 0,
      "choice": false,
      "connect": false
    }
  }
]
```

## Scores and evidence

Each trial writes `behaviour/<scenario>/<trial>/trial.json`. Its raw history, chat receipts and read-back effects stay beside it. `behaviour/run.json` contains all trials, exact head, tree status, model, host and rates. `behaviour/summary.md` compares scenario rates across provenance, display, wiring, tools, effects, Connect, expectations and total passes. Infrastructure failures stay in every denominator and make the command fail. Behaviour failures are reported as measured failures while the command completes.

- Provenance is deterministic. It checks email addresses, phone numbers, money with a currency symbol or code, parsed dates and clock times, and reference ids such as invoice numbers. Comparison uses normalized keys, including integer cents, phone digits, ISO calendar dates, UTC clock seconds and canonical reference ids. Numeric dates use day/month/year; missing years and timezone offsets use the captured run date and the world's calendar timezone, never the host clock or timezone. The private world supplies known people from mail From/To/Cc identities and calendar titles/attendees. Person messages and preceding tool results also establish identities. Names are checked only in `To …` strings on Button/Caption/Title/Text components and in sent-mail recipients or event attendees. Capitalization in ordinary prose is never a name check. Mutation receipts cannot support their own inputs. Each unsupported value records its category and location. No model runs during scoring.
- Display uses `createParser(spec.schema, spec.root)` with the shipped `parts.json`, initializes OpenUI state and evaluates the initial drawing. It records parser errors, incomplete programs, unresolved references and display counts per assistant message.
- Wiring checks Pressable choices share one state variable, use `@Set`, bind selected state, and have an answer Button whose `@ToAssistant` carries that variable. `choice: true` also requires at least one such choice. It does not click controls or prove their runtime dispatch.
- Tools counts calls, input validation refusals, unknown tools, error outputs and nested `ok: false`, plus reply characters and elapsed seconds. Those seconds include admission and settlement, not provider latency alone.
- Effects reads committed sends/events independently and compares their counts with the private expectations. It also checks explicit sent/booked claims have a corresponding effect and reads each effect back through a normal thread/event read. It does not infer an effect from a success sentence.
- Connect records an actual `connection-request` tool output, its position and displays drawn before it. A scenario expecting Connect passes only when a card is offered before any work display. Private reply patterns cover the scenario's specific content and claims.

Evidence never copies the world files or generated app sources. Raw chat history and effect readbacks contain private values the model saw or wrote. Keep the whole evidence directory private. Console summaries contain only scenario ids and numeric rates. Do not paste private history into a PR or commit it.

## Boundaries

This is a private Mail/Calendar world for one disposable Person, not a Gmail or Google Calendar transport test. It proves public Connect, real-model tool usage, stored effects and history scoring. Native presentation, provider delivery and interactive display execution need their own recipes. The parent owns the independent gate at the final head.
