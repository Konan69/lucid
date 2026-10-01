# One product: a person's Vivid and a team's Vivid are the same Vivid

**Status:** scope for the build that finishes the product, 1 October 2026. Evidence for every choice
is in [Reference mining](21-reference-mining.md). Where this document and an older one disagree, this
one wins until it is revised.

## The decision

There is one Vivid. A Person who signs up gets their own space and nothing else: the first screen
is still the Thread and nothing is configured. A **Company** exists only because someone created it
on purpose, by name; it is never made on a Person's behalf. Creating one, or accepting an
invitation to one, adds a second workspace beside the personal one. Inside it the same Vivid works
the same way, with shared Threads, shared knowledge and shared Connections beside what stays
private. There is no personal product and no team product, and no roster.

A session is always working in exactly one **workspace**: `Personal`, or `Company` with the role the
Person holds there. Switching is one call and every open screen follows it.

Vivid follows the nine Team Bot rules, applied to itself:

| Rule                      | In Vivid                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set up once               | A Company owner or admin adds shared Connections, rules, skills and Library files once; they reach every Person's Threads.                           |
| Conversations are private | A Thread is seen only by its audience. Nobody, including an owner, reads a Thread they are not in.                                                   |
| Acts as the asker         | A personal Connection is used only for the Person who owns it. A shared Connection is read-only for everyone.                                        |
| Two memories              | Notes with each Person are private. Company memory is shared and is written only when someone says the whole Company should know, and Vivid says so. |
| Shared work asks first    | In a shared Thread, Vivid asks a Person before using that Person's own Connection.                                                                   |
| Routines are personal     | A Routine belongs to the Person who set it up, runs as them and reports in their Thread.                                                             |
| Secrets stay secret       | Credential values never enter model context, a Thread, or a log.                                                                                     |
| Usage follows the asker   | A Run is attributed to the Person who started it.                                                                                                    |
| Admins control reach      | Admins invite and remove people, set Company rules and shared Connections, and read the audit record. They do not read private Threads.              |

## Domain model

Only what changes. Existing terms keep the meanings in `CLAUDE.md`.

```text
Person ── Workspace: Personal | Company(company, role)
Company ── Membership(role: owner | admin | member) ── Person      (created explicitly, never implied)

A workspace holds:
   ├── Thread            audience: Private | People(participants) | Company
   │     ├── Run         one admitted delivery; startedBy: Person | Routine | FollowUp
   │     ├── InputRequest   a question a Run could not answer alone
   │     └── Approval       authorization for one exact action, addressed to one Person
   ├── Project           a work container; a Thread may be filed in one
   ├── Task              belongs to a Thread; assignee: Member | Outsider(name) | Nobody
   ├── Routine           owned by a Person; trigger: Schedule | Webhook
   ├── Library           folders and items; shelf: Mine | Company
   ├── Connection        ownership: Personal(person) | Shared(company); backed by Executor
   ├── Rule              scope: Personal(person) | Company; decision: Allow | Ask | Never
   ├── Skill             a saved procedure; scope: Personal(person) | Company
   ├── Memory            scope: Person | Company | Thread; held in HelixDB
   ├── Computer          one per Person, theirs in every workspace
   └── AuditEntry        who asked, what was touched, what changed
```

Every product row carries `person_id`, the Person who owns it, and `company_id`, which is null for
a record in that Person's personal space and names the Company otherwise. Those two columns are the
only place the workspace is a nullable column; in code it is the `Workspace` union, and scope and
audience are tagged variants. A Person's own rules, skills, Connections, Library shelf and Computer
have no Company and follow them into every workspace; in a personal space a Thread is always
private, because there is nobody to share it with.

### Who may see what

One module, `apps/server/src/auth/access.ts`, turns a call into an **Actor** (the Person it acts
for, their workspace, and whether a Person or Vivid is calling) and supplies the conditions every
query is scoped with. Thread reach is decided in `threads/access.ts`. No handler re-derives either.

- **Thread:** the creator, the listed participants, or every Member when the audience is Company.
- **Task:** anyone who can see its Thread, plus its creator and its assignee.
- **Library:** the owner for Personal scope; every Member for Company scope.
- **Routine:** its owner only. Its results land in a Thread, which has its own audience.
- **Connection use:** the owner for Personal; every Member, read actions only, for Shared.
- **Memory read:** in a Private Thread, the Person's notes, Company memory, and the memory of every
  shared Thread that Person is in. In a shared Thread, that Thread's memory and Company memory only.
  A fact a participant could not otherwise see is not recalled into a room they share.
- **Audit:** owners and admins.

### Who is acting

A Run has exactly one acting Person. The application server is the only path to the runtime
(`/api/vivid/*`), so the server knows who sent every Message:

- In a **Private** Thread the Message is delivered as a user turn. The actor is the Thread's creator.
- In a **shared** Thread the Message is delivered as an attributed signal,
  `<message person="…" from="Ada Obi">`. Flue renders it to the model as a user turn, keeps the
  attribution in its own durable history, and exposes it to tools through `useDelivery()`. Clients
  render it as that Person's Message.
- A Routine Occurrence or a follow-up is delivered as a signal that names its owner.

The runtime passes the Thread and the acting Person on every product call. The server re-checks that
Person's live Membership and Thread access on each call; a removed Member's Run stops being able to
act at its next call.

## The trust loop

The runtime proposes; the server decides. Nothing consequential runs from model text.

1. A tool call reaches the server with the Thread and the acting Person.
2. `Access` rejects what that Person may not reach.
3. The action is classified `read`, `write` or `destructive`. Executor supplies the classification
   for Connection tools from the source (HTTP method, MCP hint).
4. Rules are applied. Company rules are required; a Person's own rules can only make behavior
   stricter. Never beats Ask beats Allow. With no matching rule, a read is allowed and anything else
   asks. If the rule check cannot run, ask.
5. **Ask** creates an **Approval**: the exact action, a digest of it, the Connection it will use, an
   expiry, and the Person who must decide. The turn ends. The Thread shows a card.
6. The Person chooses **Allow once**, **Always allow** (which writes a rule) or **Deny**. The claim is
   one conditional update, so two answers cannot both run the action. The server executes the stored
   action, not a new proposal, so the preview and the action cannot drift.
7. The outcome returns to the Thread as a signal and Vivid continues. A write whose result is
   uncertain is recorded as **outcome unknown** and is never retried silently.
8. Every step writes an **AuditEntry**.

An **Input request** uses the same suspension: a question with labelled options and a free answer,
addressed to a Person, answered once, returned as a signal.

Background work (a Routine with nobody present) may read. It may write only where a rule allows it;
otherwise it asks and waits.

## Connections: Executor

Executor is the Connection layer. It runs beside the server as one more local process, reached over
its authenticated HTTP API. Its key authorizes its whole installation, so it is never exposed to a
client or to the runtime; the server holds it and owns the permission model.

- A Vivid **Connection** maps to one Executor account plus the profile that selects it.
- The catalog of services, the live tool list, the read or write classification and credential
  storage come from Executor. Vivid stores the mapping and the ownership, never a credential.
- The model sees a small fixed tool set: `find_tools` and `use_tool`, plus `connect` to offer a
  service in the Thread. Fifty connected services cost the prompt what one does.
- Authorization happens in the browser and returns to the Thread, as it does today.

The hand-written Google providers are retired when the Executor path covers the same three services.

## Memory: HelixDB

HelixDB holds Vivid's memory: a graph of records, each with a vector and a full-text index, all
partitioned by Company.

- **Records:** fact, preference, person, organization, decision, workstream. Each has aliases and
  links to related records. A correction supersedes the old record and keeps it.
- **Three scopes:** a Person's notes, Company memory, and the memory of one shared Thread.
- **Written by a background pass, not by the answering model.** When a Run settles, the server
  extracts candidate records from that exchange, reconciles them against what exists (new, duplicate,
  extends, updates), and writes them to the narrowest scope the Thread allows.
- **Company memory needs intent.** A record becomes Company memory when a Person says the whole
  Company should know it. Vivid says when it has saved one.
- **Read at the start of a Run:** a one-page brief (who this Person is, how they like to work, what
  is in motion), then `recall` on demand. Recall fuses graph, vector and full-text results inside the
  scopes `Access` allows.
- **Memory is not evidence.** A current fact (a booking, a balance, a status) is confirmed through a
  Connection before Vivid acts on it.
- **Visible and correctable.** Settings shows what Vivid knows, by scope. A Person can correct or
  forget a record and download everything held about them.

## Realtime

Every read is a live query. Nothing on a screen is fetched and then left to go stale, and no
client polls.

- **The conversation** is Flue's durable stream, proxied by the server. Every participant in a
  shared Thread observes the same stream and sees the same tokens.
- **Everything else** is declared twice in `VividRpc` from the same payload and result: `ListThings`
  answers once, and `WatchThings` is a stream that sends the current result and then sends it again
  whenever it changes. Clients hold their `Watch` subscriptions over one WebSocket (`/api/live`);
  the runtime's tools use the plain form over HTTP (`/api/rpc`).
- **How a result changes.** A write names whose data moved (a Person, a Company, a Thread) on a
  PostgreSQL `LISTEN`/`NOTIFY` channel. Every live query watching that owner runs again, and a
  result equal to the last one is not sent. Writers in other processes (the schedulers, a second
  server) are heard the same way. The Actor is itself live: switching workspace or being removed
  from a Company re-scopes every open query without a reconnect.
- **Writes are optimistic.** A client applies its own change at once and the next result confirms
  or corrects it.
- **Presence** (who has a Thread open, who is typing) is held in memory with a short expiry.

## What a Person sees

The surface rule in [Principle](01-principle.md) holds: a Thread list, a Thread, a settings gear.

- **First run.** Sign up, then the Thread, in the Person's own space. Nothing else is asked.
  Suggestions on the empty screen come from that Person's own Tasks, Routines and Library.
- **Workspaces.** The switcher at the top of the sidebar lists the personal space and every Company
  the Person belongs to, and ends with **Create a company**: a name, and that is all. An invitation
  link shows who invited them and to what before they accept.
- **Sidebar.** Vivid, then Routines, Library and Projects, then Threads grouped by attention:
  **Needs you**, **Working**, then by day. A shared Thread shows the faces of the people in it. A
  search palette (⌘K) finds Threads, Messages, Library items, Tasks and Routines.
- **Thread.** The header carries the title and **Share**: add people by name, or share with the whole
  Company. In a shared Thread each Message shows who sent it, and Vivid shows who it is answering.
  Cards in the Thread: a question to answer, an action to approve, a service to connect, a draft to
  send, a Routine created, a Task created, a result to open.
- **Tasks.** There is no separate page of Tasks. What Vivid is tracking shows where it was agreed,
  as a card in its Thread, and anything that needs the Person reaches them as a notification and
  as a Thread under **Needs you**.
- **Library.** Two shelves: **Mine** and the Company's.
- **Settings.** General; **People** (invite, roles, remove); **Connections** (mine and shared);
  **Rules** (mine and the Company's); **What Vivid knows**; notifications. People, shared
  Connections and Company rules appear only in a Company workspace.
- **The Computer.** A panel beside the Thread shows the Person's own machine: its screen, what Vivid
  is doing on it, and a control to take the keyboard and pointer back.
- **Mobile** uses the same contracts and the same Thread, and pairs with a server by a code shown
  on a signed-in device, so a phone reaches a Vivid running on the Person's own machine.
- **Desktop** is the same web surface in a packaged app that remembers which server it talks to.

## Build order

Each step leaves a product that runs.

1. **Accounts and ownership.** Sign-up and sign-in on web; the personal space; explicit Company
   creation and workspace switching; owners on every product table; the Actor and its access
   conditions; Thread audience and participants; invitations and roles.
2. **The gateway and Runs.** `/api/vivid/*` behind the session; attributed delivery; Run records;
   settlement observed from Flue; attention states.
3. **Realtime.** Live queries for every read, the change bus, presence, optimistic writes.
4. **The trust loop.** Input requests, Approvals, rules, the audit record, and their cards.
5. **Connections on Executor.** The adapter, ownership, `find_tools` and `use_tool`, the connect card.
6. **Memory on HelixDB.** The store, the background pass, the brief, recall, the settings view.
7. **Scoped work.** Tasks with Member assignees, personal Routines with a webhook trigger, the two
   Library shelves, Projects from real data, skills.
8. **The Computer.** A machine per Person behind a provider boundary, with commands and a browser
   that pass through the trust loop.
9. **The surface.** Every screen on real data on web, mobile and desktop: the search palette,
   notifications, the empty states, device pairing and the packaged desktop build.

## Not in this build

- **A hosted machine provider.** The Computer runs on a local container provider behind the
  `Machine` boundary; a hosted provider needs an account this repository does not hold.
- **Voice.** The call work in `apps/web/src/call` stays as it is.
- **Chat channels** (Slack, mail-in). The Thread model above is what they will deliver into.
- **Ambient participation.** Vivid answers when addressed; it does not join rooms unasked.
- **Billing and usage limits.**
