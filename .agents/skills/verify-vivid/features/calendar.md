# Put a to-do in the calendar

Model requirement: a real shipped model, the full Vivid prompt and native Person cell. Use the [Mail and Calendar behaviour runner](behaviour.md). Its scripted Calendar Integration proves plumbing only. It never reads or changes a real Google Calendar account. This recipe makes no browser or native presentation claim.

## Prepare the private world

Set `VIVID_VERIFY_WORLD` to a private directory outside the checkout. Write these three files there with mode 0600. Use a future weekday if 12 November 2026 has passed, updating the dates in all three files together.

`mail.json`:

```json
{"owner":{"name":"Verification Person","email":"calendar@example.test","timezone":"Africa/Lagos"},"threads":[]}
```

`calendar.json`:

```json
{"timezone":"Africa/Lagos","calendars":[{"name":"Personal"}],"events":[{"calendar":"Personal","title":"Busy","start":"2026-11-12T09:00:00+01:00","end":"2026-11-12T10:00:00+01:00"}]}
```

`scenarios.json`:

```json
[
  {
    "id": "calendar-block",
    "connected": ["Calendar"],
    "words": [
      "Add renew my passport to my to-do list, due 13 November 2026. Then propose a private one-hour block for that to-do on my Personal calendar on Thursday 12 November 2026, between 09:00 and 12:00 Africa/Lagos. No attendees, invitations or video call. Show me the proposed time before booking.",
      "Yes, book the free one-hour slot you proposed, on Personal, with no attendees or invitations. Read it back and tell me its exact time and the event link if the calendar returns one."
    ],
    "checks": {
      "replyIncludes": ["passport"],
      "replyExcludes": ["Routine"],
      "mailSent": 0,
      "calendarCreated": 1,
      "choice": false,
      "connect": false
    }
  }
]
```

## Drive and inspect

Run Launch and Doctor with this world, then `verify behaviour <run> --trials 1`, and Cleanup. On the shared PC, hold `~/.cache/vivid-pc-heavy.lock` across this sequence. Set `VIVID_VERIFY_HOST=pc`, `VIVID_VERIFY_KEY_FILE` and `VIVID_VERIFY_CHROME` as in the skill. Read the receipts before calling it passed. The behaviour command can exit successfully when a model behaviour check failed.

Inspect `behaviour/calendar-block/1/` under the run evidence directory. Require all of the following:

1. `trial.json` has `pass: true`. The history contains a successful `add_todo` for renew my passport and a subsequent `list_todos` returning that open to-do.
2. The first turn activates `put-work-in-the-calendar`, reads `free_busy`, and proposes a full hour after the busy event, without creating an event. The proposed start and end appear in the returned free slots.
3. In the confirmed turn, a fresh successful `free_busy` read precedes `create_event`. Its range covers the exact event, and its busy intervals do not overlap the chosen hour.
4. Exactly one `create_event` succeeds. `effects.json` contains exactly one calendar event with the named to-do, calendar `Personal`, duration 60 minutes, and times matching the confirmed proposal in Africa/Lagos. Its attendees are empty and `meet` is false. The scripted provider stores events only in this Person's connected app and sends no invitations.
5. The model reads the event after writing through `list_events`. Compare its id, title, calendar, start, end, attendees and meet fields with `effects.json`. The independent provider read in `effects.json` also has `readBack.pass: true` for that event id.
6. The reply reports the same local time. If the provider returns an event link, require that exact link in the reply. The scripted provider currently returns no event link or visibility field, so real-provider event links and privacy ACLs remain unproved. An invented link fails this recipe.

Save the inspected call order, exact event and comparison results as `calendar-review.json` beside the trial receipts. Record failed requirements individually. A passing generic behaviour score alone does not prove this recipe.

## Evidence and limits

Retain the run's head, tree status, model, host, Doctor, raw history, `effects.json`, `calendar-review.json` and Cleanup receipts. Keep private evidence outside commits. Report this as scripted Calendar plumbing, with the real account, event links and provider privacy ACLs unproved. Recurring timer delivery is covered separately by [Watches](watch.md) and [Check-ins](checkin.md); this journey proves one calendar block only.
