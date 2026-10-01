# Reference mining: what the category ships, and what Vivid takes

**Mined:** 1 October 2026. **Scope:** every reference saved in the seven weeks to that date, read at
the source rather than at the headline: the full conversation behind each saved post, the linked
article, the repository, the shipped strings and the official documentation.

This document is the evidence base for [One product](22-one-product.md). It records what each
reference does, where the proof is, and what Vivid adapts. Borrowed mechanisms take Vivid's names
before they land (see "Borrowed code takes Vivid's names" in `CLAUDE.md`).

## What was read

| Source                         | Volume                                                               | Where it is kept (ignored)                |
| ------------------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| Saved posts                    | 245 posts, each with quoted post, links and article text             | `artifacts/references/raw/recent-*`       |
| Full conversations             | 204 threads: parent chain, author's whole thread, replies with links | `artifacts/references/raw/threads/`       |
| Grok Bot 0.39 shipped strings  | 2,473 user-facing strings across five catalogues                     | `artifacts/references/raw/grokbot-0.39-*` |
| Grok Bot documentation         | 15 pages, including Team Bots and Teams and enterprises              | `artifacts/references/raw/web/grokbot-*`  |
| Product and architecture posts | Muse security, Team Bots, Dots, Manus 2.0, ChatGPT Work, Instinct    | `artifacts/references/raw/web/`           |
| Source checkouts               | 10 repositories cloned at depth 1                                    | `refs/`                                   |

## The category in one paragraph

Between August and October 2026 one product shape shipped five times: Grok Bot, Meta Muse, Instinct,
OpenAI Dots and Manus Cue. Each is a named assistant with a face, reached through one conversation,
that owns a persistent cloud computer, connects to a person's accounts, asks before consequential
actions, runs work on a schedule or when something happens, and remembers. In the last week of
September the category turned multiplayer: Grok Bot shipped Team Bots, Company Brain was open
sourced, and the Multiplayer AI Manifesto set out what shared work with an assistant requires. Vivid
is that product for ordinary work, with the personal assistant and the team capabilities in one
place rather than in two products.

## The references

### Grok Bot — the closest reference

Sources: `refs/grok-bot-0.30`, the 0.39 reconstruction, <https://docs.x.ai/grok-bot/overview> and its
fourteen sibling pages, [docs/06](06-communication.md), [docs/16](16-grok-bot-auth-and-design-evidence.md),
[docs/18](18-grok-bot-machine-and-product-surface.md).

Everything Grok Bot 0.39 shows a person, grouped by what it lets them do:

| Area           | What ships                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation   | Attach (six files, 25 MB each), dictate, voice call with transcript, reply to a message, reactions, find in chat, queue while working, "Stop now", drafts kept per conversation, sent-while-offline with resend                                              |
| Results        | File, image, link and tool-result cards with previews for PDF, spreadsheet, document, video and diagram; "Download all"; a details pane with Files, Links and Routines                                                                                       |
| Drafts         | An editable email or Slack draft card: recipients, subject, body, then **Send** or **Discard**; "The send was interrupted — check your mailbox to see whether it went out"                                                                                   |
| Approvals      | **Allow once**, **Always allow**, **Deny**, for commands, connected-service tools, cookie imports and card payments; "Your answer didn't reach the server, so nothing was authorized"                                                                        |
| Auto-review    | Natural-language rules, "When Grok Bot wants to … it should Ask first / Allow automatically / Never allow"; Ask first wins a conflict; team rules are locked and personal rules can only be stricter                                                         |
| Secrets        | A masked secret request: "Stored securely, never shown to your Bot"; fill-into-page without revealing the value                                                                                                                                              |
| Connections    | A marketplace of plugins; a plugin bundles connectors and skills; OAuth in the browser; per-tool enable and disable; several accounts per service, each with a label ("work", "personal"); "Disabled by team admin"                                          |
| Routines       | On a schedule, on a webhook, or on an event (Slack message or reaction, GitHub PR and CI events, Linear, PagerDuty, Sentry, Teams); test run; run history (20 kept); pause and resume; five-minute minimum; "I paused all your routines while you were away" |
| Skills         | "Save the process we just used as a skill"; `/` references a skill; a private skill library; publish a skill to the team; teach a task by recording the screen                                                                                               |
| Attention      | Three states: **Needs attention** (question, approval, handoff), **Unread activity**, **Working**; notify when it finishes or needs input; notification sound; errors listed above the composer                                                              |
| Navigation     | Search palette across messages, files, links and routines; pin, hide, sections, mark unread; back and forward through visit history                                                                                                                          |
| Computer       | One persistent machine per account, a screen per conversation; watch, take over for a password or CAPTCHA, hand back; update, reset, recover; import browser cookies; route traffic through the person's own desktop                                         |
| Local computer | Separate from the cloud machine; **Ask every time**, **Always allow**, **Never allow**; a team ceiling                                                                                                                                                       |
| Sharing        | A shared room joined by link and approved by the host; "You can send messages. Only the owner can manage approvals and other controls"; typing and working indicators; share as a template (public or team only)                                             |
| Settings       | Account and several saved accounts, appearance, language, time zone, notifications, microphone, usage and billing, updates                                                                                                                                   |

**Team Bots** (28 September 2026, <https://docs.x.ai/grok-bot/team-bots>) is the reference for one
product serving a person and a team. Its rules, verbatim in substance:

1. **Set up once, everyone uses it.** The owner adds plugins, secrets, skills and files; they reach
   every teammate's conversation.
2. **Every conversation stays private.** Each teammate has their own chat. The owner cannot read a
   teammate's chat and a teammate cannot read the owner's.
3. **It acts as the person asking.** A plugin that signs in with an account uses the account of
   whoever is talking. One person's access is never lent to another. A plugin configured with a key
   uses the Bot's own credential, the same for everyone.
4. **Two memories.** Team memory is read by every teammate's conversation and written only when
   someone says the whole team should have it, and the Bot says when it does. Notes with each person
   are private to that person.
5. **Shared conversations ask first.** In a channel or group chat the Bot asks before using one of a
   person's own connectors: **Allow once**, **Always allow for this Bot**, **Always allow for all
   Team Bots**, **Skip**. A one-to-one chat does not ask.
6. **Routines are personal.** A routine belongs to whoever set it up, runs as them, reports in their
   chat, and only they can see or change it.
7. **Secrets are redacted.** The Bot uses a secret by name; the value is replaced with `[REDACTED]`
   in command output, file reads and plugin calls. Up to 25, scoped read-only keys recommended.
8. **Usage follows the asker.** A teammate's messages count against the teammate, not the owner.
9. **Admins control reach, not content.** Who gets the Bot by default, team rules, connector policy,
   audit log of creation, publication, skill changes and account links.

**Vivid takes:** all nine rules, applied to Vivid itself rather than to a roster of Bots, and the
conversation, results, approval, routine, skill and attention mechanics above. **Vivid leaves:** the
roster, the marketplace as a destination, per-Bot settings and the model picker.

### Meta Muse — the trust model

Source: <https://security.muse.ai/>, the 25 September post by its engineering lead, and the thread
that opened `/opt`.

- The harness and the workspace run in an isolated cell; the security services run outside it. A
  separate authority, not the assistant, decides whether a connector action or a network request may
  happen.
- The assistant never sees a real credential. It holds a surrogate; the real value is inserted at the
  network boundary after the action is authorized.
- Approvals are capabilities, not conversational suggestions: bound to one connector, destination and
  use, and offered as one-time, session, task, time-bounded or perpetual.
- Read and write access are separated wherever the service allows it. The mail connector filters
  one-time codes, password resets and magic links before the assistant can read them.
- Content from outside is labelled untrusted before it reaches the model.
- Purchases always ask, with the exact amount and merchant.
- The person can browse the machine's files from the Library tab and download everything it holds.

**Vivid takes:** the application server as the only authority (the runtime proposes, the server
decides), credentials that never enter model context, approval scopes as a closed set, read and write
separated per Connection, and "download what Vivid holds about me". **Vivid leaves:** the kernel
taint tracking and the in-VM cell, which belong to a machine Vivid does not provision yet.

### Instinct and Poke — memory

Sources: <https://supermemory.ai/blog/reverse-engineering-instinct-memory/>, the "Inside Instinct"
article, the "how instinct works under the hood" thread, the Poke storage case study.

- What the answering model always receives: an identity profile, a **memory one-pager** of about
  4,000 tokens (life context, autonomy calibration, communication style), the open tasks, and a
  compaction recap.
- Memory is a set of linked records: people, organizations, facts, preferences, decisions, daily and
  weekly timelines, active and completed workstreams. Each record has an id, a type, **aliases** so
  keyword lookup finds it, and links to related records.
- **The main assistant does not write memory.** A background pass reconciles: it moves temporary
  detail into workstreams, shortens durable records, generalizes examples into traits, and replaces a
  wrong fact with a dated correction. History is kept, not overwritten.
- **Observations are separate from memory.** Mail, meetings and documents are queryable evidence with
  their origin attached. Memory interprets; a live Connection confirms the current state before
  action. "Which airport do I prefer" is memory; "when does my flight leave" needs the booking.
- The agent loop runs on the server; the sandbox only executes. Credentials are requested by
  reference.
- Weak points found by the teardown: multi-hop recall across sessions, implicit personalization, and
  no procedural memory.

**Vivid takes:** the one-pager, linked records with aliases, the background reconciler, dated
corrections, and the split between memory and live evidence. HelixDB replaces files and keyword
matching with a graph plus vector plus full-text index, which answers the multi-hop weakness.

### Company Brain and the Multiplayer AI Manifesto — working in a group

Sources: `refs/company-brain` (Apache-2.0), <https://supermemory.ai/blog/open-sourcing-company-brain/>,
<https://multiplayer-ai.com>, the "annoying bits of Slack agents" thread, the Open Session launch.

- **Memory is written to the narrowest room and read with the asker's access.** A public channel
  reads organization memory. A private channel reads its own memory plus the organization's. A direct
  message reads the person's memory, the organization's, and every private room that person belongs
  to. A record a person could not otherwise see does not exist for them.
- **Tool access follows the person.** Reads use the person's own connection when they have one,
  otherwise the organization's. Writes run only through the person's own connection, so an action is
  attributed to a real person. Organization connections are read-only for everyone.
- **Deciding whether to speak** is a scored decision, not a yes or no: answer, investigate first,
  acknowledge with a reaction, or pass. An explicit mention always answers. "Investigate, then stay
  silent if there is nothing useful" is a valid outcome.
- **Messages that arrive mid-run** go through a gate: ignore, append as context, replace the request,
  or stop. Appended messages are drained before the next model step.
- **An approval suspends the same turn** with a checkpoint and resumes it; the assistant that proposed
  the action is the one that completes it.
- **A step budget is enforced:** warn near the limit, then remove tools and force an answer.
- The manifesto's five principles: never copy and paste (everyone involved talks to the same
  session); work with the door open; continuously improve (a correction becomes a skill); people are
  not routers; nothing starts from scratch (every piece of work has a session that can be resumed).
- Its privacy rule for a shared session: an answer drawn from one person's private source is not
  repeated to another. "That came from Claire's inbox, which isn't shared with you."
- Its governance rule: a year later, answer which assistant ran, who asked, what data it touched and
  what it changed.
- The Slack-agent list of what a team assistant must know: who is speaking, the date and time, what
  is pending approval, when it is being addressed, an explicit stop, and that the preview matches the
  action.
- Open Session: presence faces on a row, "ask a teammate for a review" puts the session in their
  sidebar, walkthroughs of finished work.

**Vivid takes:** the room-scoped memory graph, reads fall back and writes stay personal, the
mid-run gate, the suspended approval, the budget, the privacy rule, the audit questions, and
presence. **Vivid leaves:** ambient participation in channels it was not asked into; Vivid answers
when addressed.

### OpenAI Dots, Manus Cue, ChatGPT Work — the rest of the field

Sources: launch coverage of 29 September, `refs/open-dot`, `refs/open-dots`,
<https://manus.im/blog/introducing-manus-2-0>, <https://www.shloked.com/chatgpt-work>.

- Dots: background work on connected apps is **read-only** until the person is present; custom rules
  allow, ask or block; some tasks (changing a password) always stay with the person.
- Open Dot implements the rule check in fifty lines: a small model returns which of the person's
  rules apply to a concrete pending action; never beats ask beats allow; if the checker fails, ask.
  Its tool definition carries the label shown while running, the plain-language description matched
  against rules, the default decision, and the detail for the approval card.
- Open Dot's feature list is the category checklist in one page: a logged-in browser with takeover, a
  password vault, connectors that read freely and ask before writing, rules, a voice call that keeps
  working after hang-up and lands in the chat, schedules that post to their own chat, triggers on app
  events, several assistants passing work, memory and saved skills.
- Cue: each assistant has its own email address, phone number, wallet and computer.
- ChatGPT Work: a thread is a task with a working directory; the Library is the canonical home of
  files and lives outside the machine; memory is a profile maintained outside the agent; the new-task
  screen offers **personalized suggestions** computed from calendar, mail and memory; scheduled tasks
  either start fresh each run or wake an existing conversation.

**Vivid takes:** read-only background work, the rule checker and its tool metadata, suggestions on
the empty screen computed from the person's own context, and both kinds of scheduled work.

### OpenBot — conversation structure

Source: `refs/openbot` (MIT), `docs/internals/openbot.md` in that checkout.

- A project has one **main chat** and child chats one level deep. A child's work is the parent's to
  direct; requests from elsewhere reach the main chat, never a child.
- **Messages that arrive while a run is active are grouped** into the next run, each in its own
  addressed block, rather than queued as one run each.
- Knowledge lives beside chats with its own identity; a link from knowledge to a project guides
  retrieval and never grants access.
- Standing instructions and knowledge are revisioned; a stale writer must reload and merge.
- **Everything a person can do in the interface, the assistant can do through a tool, and both call
  the same operation.** There is no second copy of the validation.
- Each top-level chat owns one screen on the shared machine, created on demand.

**Vivid takes:** Project main Thread with child Threads, grouped delivery, one operation behind both
the interface and the tool, and revisioned instructions.

### Executor — Connections

Sources: the Executor v2 checkout (MIT), <https://executor.sh>.

- One shape for every integration: a name, an input, an output. MCP servers, OpenAPI documents and
  GraphQL endpoints all become tools.
- **One tool in the prompt.** The model sees `execute`, searches for what it needs, and calls it.
  Fifty connected services cost the prompt the same as one.
- Policy comes from the source: a GET differs from a DELETE, an MCP tool declares whether it is
  destructive. Safe calls run; the rest ask.
- Credentials are attached on the host at call time and never enter the sandbox or the model.
- Accounts are reusable and labelled; one service can have several ("work", "personal").
- Hosted policy separates a **personal account** from a **shared account**, and permission to manage
  an app from permission to use its credentials.
- Three ways in: the in-process SDK, an authenticated HTTP API, and an MCP endpoint. The local
  server's key authorizes the whole installation; a product that embeds it owns the permission
  model. The remote SDK constructor is a stub.
- Approvals in the SDK are stored, expire after fifteen minutes, are claimed once, and are bound to
  the exact invocation. An interrupted MCP program is not resumable after a restart.

**Vivid takes:** Executor as the Connection layer behind the application server, reached over its
HTTP API, with Vivid's own authority deciding who may use which account in which Thread.

### Harness engineering — how the runtime should behave

Sources: the Cursor token-efficiency guide, the "20x faster" comparison, the list of 53 production
harness bugs, the asynchronous-tool harness, the Durable Object memory post.

- Keep a small fixed set of tools in the prompt and make the rest discoverable. Tool descriptions
  describe; they do not command.
- Keep the prompt prefix byte-identical between turns: stable tool order, nothing volatile before the
  cache boundary, the date at day granularity.
- Write large tool output to a file and return a pointer; never truncate silently.
- Independent checks run in parallel. A procedure discovered once is saved as a skill; in the
  comparison that removed more than 80% of tool calls.
- From the bug list, the failures that apply to Vivid: a crash mid tool call leaves a dangling call; a
  cut stream reported as a successful empty turn; two parallel approvals waking one turn and running
  the action twice; a stop overwritten by a stale write; a parent waiting forever on a child that
  died; a malformed deny rule failing open; no completion signal, so the agent polls.
- Schema objects built at module scope are heap, not types. Keep them lazy in a memory-bound runtime.

## What the references agree on

1. The conversation is the product. Everything else is reached from it or shown beside it.
2. The assistant proposes; a separate authority decides. Credentials never reach the model.
3. A person's own accounts are never used on another person's behalf. Shared work asks.
4. Memory has a private part and a shared part, is written by a background pass, and is read with
   the asker's access.
5. Repeated work is said once and becomes a routine or a skill. Routines belong to a person.
6. Three attention states are enough: needs you, unread, working.
7. Shared work needs to know who is speaking, needs a real stop, and needs an audit trail.
