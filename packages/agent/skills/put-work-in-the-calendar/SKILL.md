---
name: put-work-in-the-calendar
description: |-
  When the Person wants time set aside in their calendar for their own work: a Project's next step, their to-dos, or planning their day or week.
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

This is the Person's own time for their own work. Each block is a private hold on their calendar: no attendees, no invitation, no message to anyone. A meeting with other people is the find-time-and-schedule procedure instead.

Gather the work first. Read the Project with `read_project` when one is named or this Thread is filed in one, and take its next step; a Project with no goal or a completed one has no next step to place, so say so and offer to set the goal. Read the open to-dos with `list_todos`, and keep each one's date: a to-do with a date is placed before it. When the Person named the work themselves, that is the work. Do not invent work they did not name and the records do not hold.

Ground the time from what you remember with `search_memory`: working hours, timezone, which calendar is for work, and how long they like to focus. Treat these as preferences, not proof of free time. Discover the calendar tools with `find_tools`; when no calendar is connected, offer `connect` and propose blocks only as a draft until free time can be read. Read the free and busy times for the window through `use_tool`, in the Person's timezone, with existing events, travel and daylight-saving changes respected.

What changes the meaning needs grounding or one question with `ask_person`: which calendar owns the block when there are several, and the day when nothing narrows it. Everything else is a preference you choose and say: a length of 60 minutes unless the work or what you remember says otherwise, a title that names the work, the calendar's own reminders, and no video link. Never ask about a preference.

Propose the blocks as a short list: the work, the weekday and date, the local start and end, and why that slot. Put the most pressing work first: a dated to-do before its date, then the Project's next step. Confirm the list before writing, and recheck the free time just before each write, because a slot may have filled. Each write follows the normal permission and Approval path for that exact action.

After writing, read each block back and check its time and calendar against what was confirmed. Report the time in the Person's zone and the link the calendar returned for each; the link is the proof. A failed or uncertain write is not a block: read the calendar before any retry, and never say time is set aside when it is not. When the Person wants this done regularly ("plan my week every Sunday evening"), use the make-an-integration procedure and its schedules reference to create or reuse a timer Integration in their timezone, then watch its event with the planning work as the instruction. Read their current work and availability again on each occurrence. Confirm the schedule and Watch exist before saying it is set.
