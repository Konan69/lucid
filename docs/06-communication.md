# Communication

2026-10-03: Historical Grok Bot communication research and Vivid proposal; current shared Threads supersede only the implementation context, while cross-Person Vivid-to-Vivid remains unbuilt in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

How Grok Bot's bots talk to each other, work in groups, reach other users, fork work, and reach the
user's own computer. From `~/refs/grok-bot-0.18-reconstructed/source`. This is the substrate for
Vivid-to-Vivid.

## Reaching the Person through Vivid

Vivid delivers its existing recipient-owned Notifications through its own app's push targets:
Web Push with VAPID for browsers (including a supporting desktop browser), and Expo push for
phones. Telegram is cancelled. A target belongs to one Person and one signed-in session; sign-out
deletes it through the session foreign key, and expired sessions are pruned. Existing Thread
heartbeats decide whether the Person is present anywhere in the app. Thread access is checked
again before quoting a Notification. Approval and Input decisions remain in the app.

Clients use the generated RPC client with their signed-in session:

- Web: call `GetPushKey()` → `{ publicKey }`, obtain permission and a service-worker subscription
  with that VAPID key, then `RegisterPushTarget({ destination: { _tag: "Browser", endpoint,
keys: { p256dh, auth } } })`. Use the subscription's unpadded base64url keys. Supported endpoint
  hosts are Google's FCM, Mozilla's push service, Apple's Web Push and Windows notification hosts;
  arbitrary endpoints are refused to prevent server-side requests to private addresses.
- Phone: obtain the app's Expo push token with the correct Expo project, then
  `RegisterPushTarget({ destination: { _tag: "Phone", token } })`. Basic Expo sends need no secret;
  the adapter follows the [Expo v2 API](https://docs.expo.dev/push-notifications/sending-notifications/).
- Registration returns `{ target: { id, destination, createdAt } }` (milliseconds).
  `ListPushTargets()` / `WatchPushTargets()` return `{ targets }` across that Person's live sessions.
  `RemovePushTarget({ id })` removes one. Supply no Person, Company or session identifier.
- A browser worker receives `{ notificationId, title, body, threadId }`; Expo delivers the same
  object in `data`, with `title` and `body` also at the notification level. Display the notification,
  then open `threadId` on a tap (or the notification list when null), checking current app access.
  Browser permission, service worker, click handling and native token/tap registration belong to
  the client owners and are not implemented by this backend lane.

Set `VIVID_PUSH_VAPID_PUBLIC`, `VIVID_PUSH_VAPID_PRIVATE` and `VIVID_PUSH_SUBJECT` (an HTTPS URL
or `mailto:` contact). All three are required: with one missing, a subject a push service would
refuse, or a private key that does not belong to the public key, the server does not start and
names the variable. Generate the pair once for an installation and keep it; replacing it
unsubscribes every browser and phone that subscribed with the old public key. Private keys and target credentials never
enter model context. Apply the generated product migration before restarting the server; restart
the runtime to mount the new tools and built-in skill. No new webhook or scheduler is needed.

The durable ledger commits one claim per Notification and target before contacting the provider,
stores only a payload hash and length, and never repeats an uncertain or interrupted claim.
This prevents duplicates across retries and restarts; a crash in that gap can lose a push, while
the Notification remains in the app. Provider acceptance does not prove device display. Gone
subscriptions are removed; a scoped worker also reads Expo's late device receipts.

`notify_person` creates a Notification and reports accepted, failed and uncertain target counts,
or explains presence, missing targets or unavailable push. Watches receive Integration app events
through Executor. Their findings reach the Person through the Feed. Real-device push and
the model's attention judgement remain unverified.

## Direct messages between bots

One tool, `SendToAgent`, with a target id, text, optional images, and a priority flag.

- **Asynchronous, like texting.** The call returns "Sent to Dami. This is asynchronous. If they reply
  it arrives later as a new message that wakes you. Don't wait on it now." The sender ends its turn.
- **Delivery is a wake.** The message is queued for the recipient and the recipient is revived on a
  hidden turn whose cue is `[agent]`, naming the sender. The recipient's user sees the message in
  their own chat. The recipient replies with another `SendToAgent`, which wakes the sender later.
- **Priority interrupts.** A priority message jumps the queue and interrupts the recipient's current
  non-user work. It never interrupts a turn the user is driving. Priority is 1:1 only.
- **Guardrails are in the prompt, not the code.** Message one teammate when it genuinely helps.
  Never relay the user's unfiltered words. Fan out to several teammates only when the user
  explicitly asked, otherwise propose it with one question widget and wait for yes. Never fan out
  "meanwhile" while waiting on the user. Stay silent on FYIs so two bots never ping-pong
  acknowledgements.
- **Discovery is file-based.** Every bot is a sibling folder under the agents root with a
  `profile.json`. Groups have a `group.json` with member ids. The bot can read them with Shell.
- **Bots can create bots.** `CreateAgent` and `UpdateAgent` exist. No bot can delete one, including
  itself. Only the user can, from the sidebar.
- **The user can broadcast.** An admin broadcast wakes every bot with a `[broadcast]` cue: "this is
  the owner speaking to all of you."

Source: `host/agents/agent-messaging.ts`, `host/extensions/transcript/agent-to-agent-messaging.ts`.

## Group rooms

A group is itself an agent record with a `group.json` listing up to six member bots. Groups cannot
contain groups.

- **A turn is a bounded round robin.** At most three rounds, ten member messages per turn, two
  messages per member per turn. Speaker order rotates each round. A round with no messages ends the
  turn.
- **Mentions pick the responders.** Since the last user message, `@name` or `@everyone` selects who
  speaks. No mentions means everyone.
- **"(pass)" is silence.** A member with nothing to add sends exactly that and it is dropped.
- **Members keep their tools** in a local group. They do the work first, then deliver with one
  message. Each member sees only messages since it last spoke.
- **Group turns show up in each member's own history**, tagged "[Group chat: name]". The 1:1 chat
  with the user stays private.

Source: `host/groups/group-chat.ts`, `host/extensions/transcript/group-chat-orchestrator.ts`,
`group-chat-glue.ts`, `shared-rooms.ts`.

## Cross-user rooms

This is the org mechanic. Sharing is a separate extension with its own relay.

- **A room is hosted by one user** and mirrored to others. Members are `{ kind: "agent" | "human",
authId, agentId, displayName }`. Remote agents are addressed as `sand-remote:<owner>/<agent>`.
- **Joining is by invite link and a join request** the host approves. Users can add or remove their
  own bots from a room, and leave.
- **The relay is HTTP polling**, every four seconds, against the backend, with acks and a
  thirty-second backoff on error. Events: room-join-request, room-post, room-entry, room-typing.
- **Remote turns are stricter.** In a cross-user room, tool calls and plain text are private scratch.
  Only a `SendMessage` is delivered to the room. Bots cannot DM a remote room directly.
- **Typing indicators and avatars** cross the relay too.

Source: `host/extensions/cross-user-sharing/*`, `host/groups/remote-room-store.ts`,
`shared/agents/sharing.ts`.

## Forks and subagents

- **Subagents are a Task tool.** A bot spawns a child with a description, a prompt, a subagent type,
  and a model. Children are ids prefixed `sand-subagent-`. The roster shows a parent as running
  while any child runs. Computer-use and browser-use are subagent types with their own box prompts.
- **Multitask mode forks the bot into an async subagent** so the parent stays responsive while a
  child works. Fork turns are marked `branched` in the transcript.
- **Fork desktops.** The shared box has one primary desktop and numbered fork windows. Each bot owns
  a window index, persisted in `/home/box/.sand-window-assignments.json`, with its own VNC stream.

Source: `shared/agents/subagents.ts`, `host/extensions/transcript/turn-runtime.ts`,
`host/box/shared-desktop-sand-box.ts`.

## The box and the user's computer

The system prompt draws a clean line the bot has to respect:

> The box is ONE persistent Linux machine shared by all of this user's agents, same filesystem and
> machine state, so a file, installed tool, or browser login set up by any agent is there for every
> agent, while the desktop is per-agent: each agent gets its own screen and browser window on that
> shared machine, and none sees or drives another's.

- `Read` and `Shell` run on the box. `ExternalRead` and `ExternalShell` run on the user's own
  computer through a local exec daemon on the laptop.
- The two are separate filesystems. `CopyToBox` and `CopyFromBox` move files across.
- "Anything that shouldn't run on the user's machine" goes on the box. The user's computer is for
  their files and local environment.

Source: `host/runner/prompt-collector-glue.ts`, `shared/agents/agent-tool-names.ts`,
`local-exec-daemon/`.

## What Vivid takes

- **Vivid-to-Vivid is exactly `SendToAgent` across users.** Asynchronous, wake-on-delivery, visible
  in both threads, reply is another send. Grok Bot only ships this within one user's bots and uses
  rooms for cross-user. Vivid makes the cross-user DM the primitive, with the same prompt
  guardrails, so "ask Dami's Vivid" is one message and the answer lands in the thread.
- **Rooms become threads with more than one Vivid in them.** The round robin, mentions, and
  "(pass)" are the right mechanics. Six members is a sane cap.
- **The relay is the org server.** Rooms, join requests, presence, and the audit trail live there.
  Polling every four seconds is fine to start.
- **One shared box per user, per-thread desktops** matches the computer doc: Vivid and its
  subagents share a machine, each fork gets a window.
- **The box-versus-your-computer split is worth keeping.** Vivid can reach the user's laptop for
  their files, and does everything else on its own machine.
