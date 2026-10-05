# One product: a person's Vivid and a team's Vivid are the same Vivid

2026-10-03: This remains build scope and design intent; measured implementation status is in [docs/14](14-product-feature-set-and-grok-bot-parity.md) and domain READMEs. The extended Boat proof in [docs/04](04-computer.md) supersedes the browser-input refusal claim below; provider input now works, while app viewing and Thread-driven input remain unproven.

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
   │     ├── Run         one admitted delivery; startedBy: Person | Routine | Decision
   │     ├── InputRequest   a question a Run could not answer alone
   │     └── Approval       authorization for one exact action, addressed to one Person
   ├── Project           a work container; a Thread may be filed in one
   ├── Routine           owned by a Person; trigger: Once | Schedule | Webhook | Integration
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
- A Routine Occurrence is delivered as a signal that names its owner.

The runtime passes the Thread and the acting Person on every product call. The server re-checks that
Person's live Membership and Thread access on each call; a removed Member's Run stops being able to
act at its next call.

## The trust loop

The runtime proposes; the server decides. Nothing consequential runs from model text.

1. A tool call reaches the server with the Thread and the acting Person.
2. `Access` rejects what that Person may not reach.
3. The action is classified `read`, `write` or `destructive`. Executor supplies the classification
   for Connection tools from the source (HTTP method, MCP hint).
4. Hard rules are applied first. Company rules are required; a Person's own rules can only make
   behavior stricter. A **Never** rule refuses the action, and it cannot be approved in the Thread.
   A read with no rule against it runs.
5. Everything else that touches the Person's own accounts or browser, or is destructive, goes to
   **Review**. Undoable work on Vivid's own Computer runs without one. The reviewer is a separate
   typed decision made by the server (`approvals/review.ts`, Effect `Decision` answered by Jev), not
   the model doing the work, so Vivid never approves its own action. It is given the exact action
   (tool, complete arguments, summary, Integration) and what the acting Person said in the turn
   Vivid is working on, with their message before it as background only. Those words are read
   from the conversation history and attributed by the server's own record of who started each
   Run, never by a name or by what Vivid says was asked. A Routine contributes its instruction
   without the outside payload; a Thread Vivid opened itself contributes nothing; an answer counts
   only in a private Thread. The reviewer returns three measurements: how likely it is that the
   Person **asked** for this (or it is a necessary step of what they asked), how likely the action
   goes **beyond** the request (a recipient, account or amount they did not name), and its
   **consequence**: contained, reaches other people or spends money, or cannot be undone. The
   server decides from those (`approvals/policy.ts`):
   - An action the Person asked for, and that stays inside what they asked, runs, including a
     send, a payment or a delete. That is how "I told it to do this" becomes "it did it" without
     the working model vouching for itself.
   - An action Vivid chose on its own runs when it is contained, and asks when it reaches other
     people, spends money or cannot be undone.
   - An **ask first** rule always asks. An **allow automatically** rule lets an undoable action run
     without a review; a destructive one is still reviewed. Neither bypasses a Never rule.
   - The reviewer has ten seconds and one attempt. If it fails, times out, has no request to judge
     against, or the arguments are too long to show whole, the action asks; it is never run
     unreviewed and never silently dropped.
6. **Ask** creates an **Approval**: the exact action, a digest of it, the Connection it will use, an
   expiry, and the Person who must decide. The turn ends. The Thread shows a card.
7. The Person chooses **Allow once**, **Always allow** or **Deny**. Always allow adds the reviewer's
   proposed rule to that Person's allow instructions (the newest twenty are kept). The claim is
   one conditional update, so two answers cannot both run the action. The server executes the stored
   action, not a new proposal, so the preview and the action cannot drift.
8. The outcome returns to the Thread as a signal and Vivid continues. A write whose result is
   uncertain is recorded as **outcome unknown** and is never retried silently.
9. Every allowed, blocked, approved and denied action writes an **AuditEntry**. The reviewer's
   measurements are logged as numbers only; putting them in the AuditEntry is not built yet.

The mechanism is Grok Bot's Auto-review (0.30 `source/host/extensions/auto-review/`,
`source/packages/agent/smart-mode-classifier-context.ts`, and the approval card in
`frontend/src-0.30/views/send-message-auto-review-approval-card.tsx`): an independent classifier call
returning allow or block with a proposed allow rule, the same context limits, the same ten-second
single attempt, and the same three answers. Two things differ. Grok Bot's classifier
returns allow or block; Vivid's returns measurements and the server decides, so the thresholds and
the precedence are code, not prompt. Grok Bot rejects the action when the classifier fails; Vivid
asks, because a refused action the Person wanted is worse than a question. And Grok Bot's
classifier runs on its vendor's backend, whose prompt and model are not in the shipped app; Vivid's
decision wording is ours and is judged by the live evaluation `approvals/review.live.test.ts`. The
proposed rule and **Always allow** from the reviewer are not built: the typed decision answers
measurements, and Jev does not write text.

An **Input request** uses the same suspension: a question with labelled options and a free answer,
addressed to a Person, answered once, returned as a signal.

Background work (a Routine with nobody present) goes through the same review. The Routine's own
instruction is trusted context for the reviewer, so a Routine does what it was set up to do without
asking. Nobody being present never grants anything: when the reviewer says ask, the Approval waits
for the Person, and an Approval that expires unanswered is a refusal.

The **Computer** is Vivid's own machine, and work on it is contained there: a command or a browser
step is not an action in anyone's account. So with no matching rule it runs without asking. A
rule can still forbid it or make it ask, and if the rule check cannot run, it asks. Every command
is written to the audit record; browser steps are shown on the Computer's screen and are not
recorded one by one. Anything done through a Connection, from the Computer or not, is a Connection
action and follows the steps above.

## What the model is shown

The model never sees an identifier and never supplies one. Everything it reads can be repeated to
the people in a shared Thread, or steered by what someone writes, so nothing in front of it is a
handle on a record.

- **Who and where is injected, not said.** The server sends each delivery to the runtime with its
  scope beside it: the Person Vivid acts for, and the Library folder the work is confined to when
  there is one (a Routine's own). The conversation itself carries only the speaker's name and the
  delivery's turn number. Tools receive the scope through a Layer; the model cannot read it or
  change it. After a restart the runtime asks the server for the scope of a turn, with its own
  credential and for no Person.
- **Things are named, not numbered.** A Routine is its name, a skill its name, a Connection its
  account ("Gmail (Work)"), a memory its words. What the model was shown is what it can say back,
  and code resolves the name to the record under the acting Person's access. Two things with the
  same name are told apart in the list, in a stable order.
- **Every tool result is a view.** Each record a tool returns is projected, field by field, into
  what a person would be told about it. A test builds every view from records whose identifiers
  are recognisable markers and fails if one reaches the model.
- **The outside world's data is not Vivid's.** An email address is how a person is reached, and a
  provider's own record ids are what its tools take back, so a Connection tool's output passes
  through as the provider gave it.
- **One exception, and why.** The cards for an Approval, a question and a service to connect are
  drawn by the clients from the tool result in the conversation, so those three results still
  carry the reference the card needs. Flue has no way to send a client data the model does not
  also read.
- **One response is for one Person.** In a shared Thread, a message from someone else while Vivid
  is still answering is not joined into that response; it is refused with a sentence, and sent
  again when the answer is done. Otherwise the rest of one Person's request would run with
  another's accounts.

Memory follows the same rule on its own path: the background pass that learns from an exchange and
writes the brief is shown words and names only, and points back at a known memory by a handle that
exists for that one call.

## Connections: Executor

Executor is the Connection layer. It runs beside the server as one more local process, reached over
its authenticated HTTP API. Its key authorizes its whole installation, so it is never exposed to a
client or to the runtime; the server holds it and owns the permission model.

- A Vivid **Connection** maps to one Executor account plus the profile that selects it.
- The catalog of services, the live tool list, the read or write classification and credential
  storage come from Executor. Vivid stores the mapping and the ownership, never a credential.
- The model sees a small fixed tool set: `find_tools` and `use_tool`, plus `connect` to offer a
  service in the Thread. Fifty connected services cost the prompt what one does. A tool is named by
  the account and tool it was shown under, and the server resolves that pair exactly.
- Authorization happens in the browser and returns to the Thread, as it does today.

The hand-written Google providers are retired when the Executor path covers the same three services.

### Google Integrations: operator setup

Vivid provisions an operator-owned Google web client through Executor v2's supported
`POST /v1/account-connections/oauth/start` input, `client: { clientId, clientSecret }`.
Executor encrypts it in `executor_oauth_clients`, keyed by owner, provider, method, callback,
issuer and scopes (`packages/sdk/src/implementation/oauth.ts`, `resolveSetup` and `beginOAuth`).
A dashboard registration alone cannot configure a Person's distinct owner and callback.
Vivid stores account/profile references and the pending OAuth state, never Google grants.

The installation setting is **VIVID_EXECUTOR_GOOGLE_CONFIG**. It names a private, owner-readable
JSON file with **client.clientId**, **client.clientSecret**, and **apps**, whose entries contain
**service**, **name**, **app**, and **provider**. Both client fields are decoded as `Redacted`;
configuration errors never include the supplied values. The app/provider identities must come
from successful native Executor deployments, never a guessed catalog name. Installed services
remain available to `FindServices` when the public catalog feed is unavailable. The Executor
transport must retain each catalog entry's **domain**: service **mark** is the logo image
address `https://integrations.sh/logo/<registrable domain>`, without a size parameter. Missing
or nonregistrable domains produce no logo. Empty searches list Google Workspace, Gmail,
Calendar, Drive, Microsoft 365, Outlook, Slack and Notion first; typed searches retain name
relevance ranking. An absent installation does not advertise Google as ready.

Operator steps:

1. Reuse the installation's existing **Executor Local** Google Cloud **Web application** client.
   On a legacy personal Executor, its client ID is in SQLite **oauth_client.client_id**, selected
   by **slug** and **owner**; **client_secret_item_id** references the value in the file credential
   store **auth.json**. The setup helper's **server-control/auth.json** is API authentication,
   not the Google client store. Copy only that named client, file-to-file or process-to-process.
   Never copy account access/refresh grants, print either client field, or commit this file.
2. Convert the existing native Google specifications with Executor v2's OpenAPI generator and
   install through **POST /v1/apps/deploy**. Keep native API hosts, paths, operations and scopes.
   For multi-host specifications, generate each origin separately and combine the normalized
   operation records. Set the provider's **googleOAuth2** method to Google discovery with
   **discover**, **scopes**, **resource** and **tokenEndpointAuthMethod**; use the published
   issuer, the reviewed native scopes, no OAuth resource parameter, and confidential-client
   POST authentication. The imported default unauthenticated client method cannot use this
   web client's secret. Write the returned app/provider identities into **apps**.
3. Set **VIVID_EXECUTOR_GOOGLE_CONFIG** in the application server's launch environment. The night
   launch already sources `artifacts/night/executor/env`; the provisioning file is private and
   ignored under that directory. The currently configured services are Gmail, Calendar, Drive,
   Docs, Sheets and Tasks. Slides, Contacts and combined Workspace are not installed: the
   native v2 generator rejects their **allowReserved** path parameters. Preserve that failure
   until an importer can retain those semantics; do not drop operations to claim full coverage.
4. In **Google Cloud > APIs & Services > Credentials > Executor Local > Authorized redirect
   URIs**, add the exact Vivid callback. On the current night stack (**PUBLIC_URL** uses the
   local web origin) it is `http://localhost:5178/api/connections/google/return`. On a deployed
   server with **PUBLIC_URL** `https://<domain>`, it is
   `https://<domain>/api/connections/google/return`. Google requires exact matching, including
   hostname, port and path. Keep the personal Executor's existing callback. Vivid does not use
   the Executor dashboard's `/api/oauth/callback` for this flow.
5. Permit the local callback in Executor with **EXECUTOR_URL_ALLOW_HTTP_ORIGINS**, restricted to
   the exact night web origin; keep **EXECUTOR_URL_ALLOW_LOOPBACK_HTTP** disabled. This is a
   private-origin exception, so the night server must set **VIVID_EXECUTOR_PUBLIC_ONLY** false
   after sourcing its launch files before restarting. That disables public-address imports
   rather than asserting an egress guarantee the sidecar no longer provides. For an HTTPS-only
   deployed installation, remove the local HTTP exception and verify the public-only guarantee
   before enabling address imports. Restart both the night Executor and application server
   to read their new environment; neither process watches these files.
6. Keep the required Google APIs enabled and configure Google Auth Platform **Branding**,
   **Audience**, **Data Access**, and **Test users**. Run the opt-in
   `apps/server/src/connections/google.live.test.ts` suite with **VIVID_LIVE_GOOGLE** and the
   Executor configuration settings. It checks catalog discovery, a separate owner per service,
   matching client identity without printing it, the callback, state and scopes. Its proof
   callback uses an HTTPS example origin so it can run before the night HTTP-policy restart.
   Then finish consent as an allowed test user and verify a real read. Authorization URL
   generation alone does not prove Google registration, token exchange, refresh or API access.

The fixed callback resolves the authenticated initiating Person's exact stored OAuth state before
completing that Connection. Executor independently verifies request identity, state, PKCE and the
callback URL. Unknown, duplicate or expired state cannot select another Person's Connection.
Existing non-Google providers keep their Connection-addressed callback.

Executor's authorization builder does not request Google's **access_type** offline mode
(`packages/sdk/src/implementation/oauth-protocol.ts`, `authorize`). Refresh-token availability
and durable background access remain unverified and need separate support; existing personal
Executor account grants are not reused.

Google references: [web-server OAuth and exact redirect matching](https://developers.google.com/identity/protocols/oauth2/web-server),
[published OAuth metadata](https://accounts.google.com/.well-known/openid-configuration).

### Integrations added by address

A Person can hand Vivid the address of an MCP server or an OpenAPI document and Vivid adds it as an
Integration. An address someone typed is untrusted, so two things stand between it and the
network Vivid runs in:

1. **Vivid checks first.** The address must be `http` or `https` with no credentials in it. Every
   DNS answer and every redirect is checked at connection time, and anything loopback, private,
   link-local or otherwise not public is refused. A documentation page is followed to its
   specification under the same check.
2. **Executor must be public-only too.** Executor fetches the checked address again from its own
   process, and Vivid cannot constrain that second fetch. So adding by address is off until the
   operator has run Executor with loopback access disabled
   (`EXECUTOR_URL_ALLOW_LOOPBACK_HTTP=false`) and no private-origin exceptions, on a network where
   it cannot reach internal services, and has then declared it with
   `VIVID_EXECUTOR_PUBLIC_ONLY=true`. Without that declaration Vivid tells the Person that this
   Vivid is not set up to add a server by address, and adds nothing.

What can be added is what Executor can import. An MCP server, and an OpenAPI document that asks
for no sign-in, a key, or OAuth's authorization-code flow, are added and usable at once or after
the Person signs in. A document that signs in only by a method Executor's import does not know
(OAuth's implicit flow is one) is refused, and Vivid says it cannot add that service rather than
adding something that would fail on first use.

The declaration is a promise about the deployment, not something Vivid can verify. An address that
answers publicly when Vivid checks it and privately when Executor fetches it is stopped only by
Executor's own egress, which is why the second step is not optional.

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
  Suggestions on the empty screen come from that Person's own Routines and Library.
- **Workspaces.** The switcher at the top of the sidebar lists the personal space and every Company
  the Person belongs to, and ends with **Create a company**: a name, and that is all. An invitation
  link shows who invited them and to what before they accept.
- **Sidebar.** Vivid, then Routines, Projects, Library, Skills and Integrations, then Threads
  grouped by attention:
  **Needs you**, **Working**, then by day. A shared Thread shows the faces of the people in it. A
  search palette (⌘K) finds Threads, Messages, Library items and Routines.
- **Thread.** The header carries Vivid's face, the title, a line saying how Vivid is doing ("Here
  with you", "Working on it…", "Waiting for you"), and **Share**: add people by name, or share
  with the whole Company. A button opens what is around Vivid: its computers, its integrations and
  what it lately did here. In a shared Thread each Message shows who sent it, and Vivid shows who it is answering.
  Cards in the Thread: a question to answer, an action to approve, a service to connect, a draft to
  send, a Routine created, a result to open.
- **Reminders.** Anything to do once at a time is a one-off Routine. Its Occurrence reports in
  its private Thread, and the Routine disables itself after firing. Commitments stay in the Thread
  where they were agreed; anything needing the Person reaches them through notifications and
  **Needs you**.
- **Library.** Two shelves: **Mine** and the Company's.
- **Skills.** What Vivid knows how to do: a starter set that ships with it, and what the Person or
  their Company has taught it. Trying one starts a Thread and asks for it in words.
- **Settings.** General; **People** (invite, roles, remove); **Integrations** (mine and shared);
  **Rules** (mine and the Company's); **What Vivid knows**; notifications. People, shared
  Integrations and Company rules appear only in a Company workspace.
- **The Computer.** A panel beside the Thread, laid out like a browser window: tabs across the top,
  a toolbar that says who has the keyboard, and the machine's screen. It can be widened to work
  in. In the desktop app the same strip holds pages the Person opens beside the Thread, each a
  browser view the app owns; a link in a reply opens there instead of leaving the app.
- **Mobile** uses the same contracts and the same Thread, and pairs with a server by a code shown
  on a signed-in device, so a phone reaches a Vivid running on the Person's own machine.
- **Desktop** is the same web surface in a packaged app that remembers which server it talks to.

## How it looks

Vivid is a character the Person works with, and the surface is built so that reads at a glance.

- **A warm canvas.** Paper in light, charcoal in dark; ink and hairlines are tinted the same way.
  Nothing on the page is a neutral grey.
- **Two typefaces, shipped with the app.** Geist for everything read and operated. Bricolage
  Grotesque for what Vivid says at size: the greeting, a page's opening line, its own name.
- **One filled shape in a Thread.** What the Person said is in Vivid's colour; everything else is
  the surface. Words that did not arrive are a dashed outline, never a faded copy.
- **Vivid's face where work happens.** In the Thread's header with its standing, beside each
  reply, on the first screen and the welcome. One identity, with moods; there is no roster.
- **Waiting is shown, not announced.** A reply that starts within a second shows nothing. A longer
  one gets an orb beside the step it is on, and a light travels the composer's edge. A request
  waiting on the Person breathes at its edge until they answer. Each respects reduced motion and
  runs only while there is something to wait for; nothing animates at rest.
- **The word is Integration.** People see "Integration" for what the code calls a Connection.

## What Vivid can do on its own

- **Connect what it needs.** Asked to do something that needs a service, Vivid finds it among the
  Person's integrations or the catalogue, and can add one from an address (an MCP server, an
  OpenAPI spec, a docs page that links one). Signing in or entering a key happens on a card in the
  Thread; a key goes straight to the integration and never into the Thread or the model.
- **Use a computer.** `browse` drives the browser by what a page says (with tabs, scrolling,
  history and waiting); `use_desktop` works any window by looking at the screen and using the
  pointer and keys; `run_command` is a shell. The Computer wakes when work needs it and stops
  when idle. The machine is Boat's (see [The Computer](04-computer.md)); a local container stands
  in for it offline.
- **Write a program.** `run_code` runs JavaScript Vivid wrote over the tools it already has. The
  program runs on the Person's Computer, with that machine's files, network and Node, and holds no
  credentials; every call it makes for the Person is authorised on the server as the acting Person
  and passes the same Gate, and an Approval ends the program.
- **Read the web.** `read_page` reads one public page without a Computer.
- **Follow procedures.** A starter set of skills ships with Vivid; a saved one of the same name
  replaces it for whoever saved it.
- **React to events.** A Routine can start on something happening in an integration ("when a new
  email arrives from Dami"), found by polling behind one seam until native delivery has a public
  address to call.

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
7. **Scoped work.** Personal Routines with one-off, schedule, webhook and Integration triggers, the two
   Library shelves, Projects from real data, skills.
8. **The Computer.** A machine per Person behind a provider boundary, with commands and a browser
   that pass through the trust loop.
9. **The surface.** Every screen on real data on web, mobile and desktop: the search palette,
   notifications, the empty states, signing in on each app and the packaged desktop build.

## Not in this build

- **Browser input on the hosted machine.** The Boat provider is proven against real Boat for
  creating, looking, opening a page, files, archive and resume (3 October 2026). Clicking and
  typing inside the guest's browser is refused by the guest driver, and the viewer has not been
  opened inside the app.
- **Voice.** No calls in this build, and the page loads nothing for them.
- **Chat channels** (Slack, mail-in). The Thread model above is what they will deliver into.
- **Ambient participation.** Vivid answers when addressed; it does not join rooms unasked.
- **To-do lists and project management.** Decided 3 October 2026: Tasks, as work Vivid tracked
  and followed up, are deleted. They will be designed again as two things. A Person gets a to-do
  list of their own. A Company or team gets product and project management: owned work with a
  state, inside a Project. Nothing of either is built; a reminder is a one-off Routine.
- **Billing and usage limits.**
