---
name: put-work-in-the-calendar
description: |-
  Use before checking availability or writing a calendar event when the Person asks to put work or a to-do in their calendar, book a block, block time, plan their day or week, or schedule their own task. Includes "put renewing my passport in my calendar for Thursday morning" and "propose a one-hour block for that to-do". Load this procedure before using calendar tools, and follow it again when they confirm the proposed time.
metadata:
  provenance: |-
    Adapted from Grok Bot's scheduling skill (skills/scheduling.md), read in full: its request
    semantics "Solo bookkeeping", the load-bearing versus defaultable split, Defaults, "The event
    link is the proof", and the "every Sunday evening, plan the week" routine. Kept: a work block
    is a private hold with no attendees and no notification, only meaning-changing gaps are
    asked, and the connector's own event link is the report. Changed for Vivid: the work comes from the
    Project's next step (`read_project`) and the Person's to-dos (`list_todos`), the calendar is
    reached through a connected Integration, and recurring planning uses a timer Integration with a Watch.
---

This is the Person's own time for their own work. Each block is a private hold on their calendar, with no attendees, invitation or message to anyone. A meeting with other people uses the find-time-and-schedule procedure instead.

Follow these steps in order. When the Person confirms a proposal in a later message, resume at step 5.

1. Gather the work. If they ask to add a to-do, call `add_todo` first. Then call `list_todos` and read the open to-do and its date before planning its block. Read a named Project with `read_project` and take its next step. A completed Project or one with no goal has no next step to place. Use the work the Person named or those records hold.
2. Ground preferences with `search_memory`: working hours, timezone, work calendar and focus length. These do not establish availability. Discover the calendar tools with `find_tools`. If none is connected, offer `connect` and keep the blocks as a draft.
3. Read free/busy for the requested window and the full block length in the Person's timezone. Every `use_tool` call must include `account`, `tool`, `input`, `summary` and `rationale`. Set `account` and `tool` to the exact names discovery returned; include the `tool` field on availability reads too. Send `input` as the object its signature requires. For a private block, set an offered attendees array to `[]`, never `null`; if the tool has no attendees field, omit it.
4. Propose the work, weekday and date, exact local start and end, and why that slot. Place dated to-dos before their dates, then the Project's next step. Ask with `ask_person` only for meaning-changing gaps such as which calendar or day, and to confirm the proposed blocks before writing. Choose preferences and say them: 60 minutes unless the work or memory says otherwise, a title naming the work, the calendar's reminders and no video link.
5. After the Person confirms, call the discovered free/busy tool again for the full confirmed block immediately before writing. This fresh call is required even when you read availability in the previous message. If the slot is now busy, propose another and get confirmation. Otherwise create the block through the normal permission and Approval path for that exact action.
6. After the write succeeds, make a separate calendar read through `use_tool`, retrieving the event by id or listing its exact time range. Match its id, title, calendar, start and end to the confirmed block. The create response is a write receipt, not this read-back. Only after the read matches, say it is booked and give its exact date, start and end in the Person's timezone. Include the event link the calendar returned; if none was returned, say so without inventing one.

A failed or uncertain write is not a block. Read the calendar before any retry, and never say time is set aside when it is not.

When the Person wants this done regularly ("plan my week every Sunday evening"), use the make-an-integration procedure and its schedules reference to create or reuse a timer Integration in their timezone, then watch its event with the planning work as the instruction. Read their current work and availability again on each occurrence. Confirm the schedule and Watch exist before saying it is set.
