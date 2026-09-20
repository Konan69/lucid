# Communication

How Grok Bot's bots talk to each other, work in groups, reach other users, fork work, and reach the
user's own computer. From `~/refs/grok-bot-0.18-reconstructed/source`. This is the substrate for
Vivid-to-Vivid.

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
