# Computer

## Thesis

From a public thread, 31 August 2026, answering the question of where an assistant's work should run:

> Agents are more useful when they model our local env, not a "sandbox" for code execution. Most
> products today are built around ephemeral agent sandboxes.
>
> My arg is the agent, state, and exec env should be on the same box. How it's previously been
> thought about is "provide a sandbox when the agent needs compute". Not: my agent process lives
> inside the compute env, which is what local dev is, and which has been productive thus far.
>
> Persistence should feel like the default, and I want it to feel like my own local box.

Restated for Vivid: the mistake is bringing pieces of a computer. Per-tool sandboxes give a false
sense of isolation. Capability comes from giving the agent a whole machine. Safety comes from that
machine being separate, pausable, and watchable, and from permissions being about what the agent
may do, not which fragments it may touch.

## What Grok Bot's box is

From the reconstruction under `~/refs/grok-bot-0.18-reconstructed/source`.

- **A persistent Linux desktop per user**, which the code calls the "forever box". XFCE, Thunar,
  Chrome, a terminal, one home at `/home/box`. Reached over VNC. A remote pod by default, or a local
  Docker container.
- **Computer use is native X11.** Display detection with xrandr, scaled to a fixed frame width,
  shell via execFile inside the box. Not a browser harness.
- **It lives forever, not per task.** Hibernate and wake. Image updates recreate the pod with data
  preserved. Reset recreates without data. A disk-pressure guard.
- **State syncs to an object store every two minutes.** Transcripts, skills, workflows, the search
  index, settings, the workspace, and the **Chrome profile**: cookies, login data, local storage,
  IndexedDB, staged every fifteen minutes. Logins survive recreates.
- **Internet egress exits through the user's own laptop.** The desktop client attaches to the box
  over a websocket, receives open-connection frames, and dials out itself. The bot browses from the
  user's IP with the user's sessions. Private and reserved ranges are blocked so it cannot reach the
  LAN.
- **Hand-off and hand-back.** "Teach a task" gives the user the desktop; the pending request resumes
  when they hand it back.
- **Safety is at the machine boundary.** A privacy mode that disables storage, a backend access
  gate, a client pause switch. Nothing per tool.

Source pointers: `host/box`, `host/extensions/forever-box`, `host/extensions/box-store-sync`,
`electron-main/box`, `shared/node/egress-tunnel`, `packages/local-exec/computer-use`.

## The mapping

|                  | Grok Bot box                           | Vivid                                                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------ |
| Host             | Firecracker pod, or local Docker       | A rented machine behind one owned boundary (see below) |
| Sleep and wake   | Hibernate, wake on use                 | Same shape, reimplemented                              |
| Identity         | Chrome profile                         | Chrome profile, from Grok Bot                          |
| Isolation        | One shared desktop, one window per bot | Both: one forever desktop, thread machines behind it   |
| Screen           | XFCE over VNC, X11 computer use        | From Grok Bot                                          |
| Network identity | The user's laptop via egress tunnel    | From Grok Bot                                          |
| Human takeover   | Teach a task, hand back                | From Grok Bot                                          |

Vivid owns the lifecycle and the state, not the hosts: what is synced, when a machine is created,
stopped and rebuilt. The machine itself is rented (see "Buy the machine" below). Grok Bot
contributes the desktop, the browser identity, the egress tunnel, the hand-off, and the state-sync
design. Task machines remain the isolation story for long jobs.

## Persistence is state sync, not the machine

**Corrected 20 Sep 2026.** This section used to argue "QEMU or a cloud VM with suspend, not
Firecracker", on the grounds that Firecracker suits ephemeral per-request instances. Reading Grok
Bot's source showed that framing was wrong: Grok Bot runs its cloud box **on Firecracker** and still
feels persistent, because persistence does not live in the VM.

What the source shows (`host/extensions/box-store-sync`, `host/extensions/forever-box`, the
`anyrun.v1` pod contract):

- **The home directory is the product.** Every two minutes a cycle packs and uploads, under a
  manifest, to an object store: `/home/box` minus regenerable junk (caches, package stores, build
  output); each agent's data as a consistent SQLite snapshot (5 s debounce); the Chrome session and
  auth state (every 15 minutes or on change).
- **A new machine is hydrated** from that store. The file count is verified and a completion marker
  is written before the machine is trusted.
- **The machine is disposable.** `recreateInBox({ preserveData: true })` flushes pending uploads,
  then destroys and recreates the pod. A daily image check does this automatically to ship updates.
  "Forever box" means forever _data_ on a replaceable machine.
- **The Firecracker snapshot is a start-up cache**, not the record. A pod starts from a node-local
  memory snapshot when one exists and from a remote root-filesystem checkpoint otherwise. Losing the
  snapshot loses nothing but seconds.

Two consequences for Vivid:

1. **Cost.** One shared machine per Person (not per Thread, not per Run), created on use and
   destroyed when idle. An idle Person costs bucket storage, not a VM. Hibernating a VM is the
   middle option; keeping no VM is cheaper still.
2. **Order of work.** Build the state sync first. Once the home directory, browser profile and
   SQLite snapshots round-trip through a bucket, the machine can be the cheapest one available,
   because it can always be rebuilt. The hypervisor stops being an architectural decision.

### Three places work runs

Grok Bot has three execution environments, and Vivid keeps the same split:

| Where                   | What it is                                                                         | Used for                                              |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The Computer            | One shared Linux desktop per Person; every Thread's work gets its own window       | Default for everything                                |
| The Person's own device | A local exec daemon, permission-checked per action, with explicit copy in and out  | Files, networks and sign-ins that only exist there    |
| A task machine          | A separate machine started per task from a saved environment, polled to completion | Long or risky jobs that must not disturb the Computer |

### Buy the machine, do not build the fleet

Running Firecracker ourselves means owning hosts, snapshot storage, networking, image distribution
and capacity. That is a company, not a feature. With state sync in place the machine is a commodity,
so rent it.

**Decision (20 Sep 2026): boat.dev, behind one owned boundary. Native provider built 2 Oct 2026.**
The provider claims below come from Boat’s docs; the real guest proof and its limits follow:

|                 | boat.dev                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------- |
| Machine         | Persistent Ubuntu VM, 4 vCPU / 8 GB default, Docker and the usual toolchains inside         |
| Desktop         | "60fps virtual desktop"                                                                     |
| Stop and resume | Stop snapshots the disk and pauses billing; resume "in a few seconds"                       |
| Fork            | Disk-level fork from a snapshot                                                             |
| Running price   | $0.036/hour for the default size ($20/month buys about 555 hours)                           |
| Idle price      | None while stopped; 50 GB of files included                                                 |
| Interface       | HTTP API, TypeScript and Python SDKs                                                        |
| Limits          | 1 hour default lifetime, overridable; EU regions only; cloud only; hypervisor not disclosed |

It has the desktop Vivid needs, costs nothing while stopped, and has a TypeScript SDK. Its
weaknesses are that it is new, EU-only, and resumes from disk rather than memory, so running
processes do not survive a stop. State sync makes all three tolerable: a stop is already
survivable, and the provider is replaceable. Self-run Firecracker is a later cost optimisation at
fleet scale, not a starting point.

`Machine` is the owned `Context.Service`: ensure, status, stop, exec, browse, desktop, and the
local provider's RFB connection. Select Boat with `VIVID_COMPUTER_PROVIDER=boat`; configure its
Redacted API key (`VIVID_BOAT_API_KEY`), size and lifetime through Effect Config. Name the paying
organization with `VIVID_BOAT_ORG` whenever the key's account belongs to one; leave it unset for an
account that belongs to none, and Boat bills that account. The key needs these actions:
`sandbox.create`, `sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`, `exec`, `file.read`,
`file.write`, `desktop`, `snapshot.read`, `snapshot.write` and `account.read`. Boat's
`full-sandbox` preset leaves out `sandbox.create`, and a key made with it is refused at the first
machine (`api_key_action_forbidden`), so name the actions. Resume also requires its own
`sandbox.resume` action; `sandbox.update` does not cover it:
`boat api-key create <name> --actions sandbox.create,sandbox.read,…`. One durable
binding and creation intent per Person precedes allocation. Restart recovers the same identity;
stop waits for disk archival and ensure resumes that snapshot. An unresolved creation intent
past the replay window fails explicitly rather than buying a second machine.

Vivid uses Boat's shipped desktop and installed `google-chrome-stable`, with the existing
guest profile and `--force-renderer-accessibility`. Observed default images vary: one included
Cua Driver 0.23.2 on the wrong desktop session bus, another omitted the driver entirely.
The adapter therefore installs the official SHA-256-pinned 0.23.2 binary in the guest's
persistent home and runs its public daemon in the X11-attested desktop panel's session.
Only Vivid's guest unit and socket are owned; vendor services are untouched. Cold setup needs
access to the official GitHub release. Standard permissions and the existing-profile grant
remain explicit. A new daemon invocation discards cached browser refs and consent sessions.
No nested desktop image is installed. Browser and desktop actions call the driver's CLI
through Boat's command API and its private daemon socket. Private action JSON is uploaded to a
temporary private directory and redirected to stdin; full-size PNGs return through the file API. The provider
returns the readable browser state and tabs, or a PNG with pointer and focused-window title.
Chrome attachment goes through the native existing-profile permission gate; a denied or missing
capability is a failure, never a substitute browser profile. Tool arguments follow the real
driver describes; success shapes are decoded at ingress. Exit-zero error JSON retains its
typed refusal code and discards potentially private detail text before reaching a Person.

Running state distinguishes `screen: Relay` (offline Docker) from `screen: Viewer` (Boat's
short-lived token-gated streaming page). `GetComputer` issues fresh viewer authority. Clients
must refresh it before expiry and use a sandboxed frame. The API key remains server-only.
Desktop actions use the same Gate and takeover recheck as browser actions: Look, Move, Scroll
and Wait are reads; Click, Drag, Type and Press follow the existing write policy. The runtime's
`use_desktop` returns real image content through Flue's public sandbox-tool API, alongside
bounded human-readable metadata. Docker remains an offline stand-in and explicitly refuses
desktop actions; it supports the expanded browser action vocabulary.

Fake HTTP integration tests exercise durable allocation recovery, restart/resume, gated viewer
issuance, native tools, response decoding, private input transport and uncertain-command handling.
They reject undeclared driver arguments with exit-zero `invalid_arguments`, return actual
0.23.2 desktop/window/action shapes, and require the prepared session for later browser reads.
Runtime tests verify PNG bytes survive the text budget. On 2026-10-03, the opt-in live test
passed against a real default Boat machine with a scoped key, isolated PostgreSQL and a
30-minute lifetime. It created the machine (1.65s), issued a token-gated viewer (0.45s), fetched
a real PNG and cursor (4.24s), launched/attached Chrome and opened/read Example Domain
(16.05s), then read again (5.98s). It wrote a file, archived the disk (20.64s), resumed the
same provider identity (2.85s), recovered the exact file, issued new viewer authority (1.81s)
and looked again (3.52s). Automatic cleanup requested deletion (0.18s). Total suite wall time
was 61.95s. Run with `VIVID_TEST_BOAT_LIVE=1`, `VIVID_TEST_DATABASE_URL` and the server-only
key; cleanup additionally needs `sandbox.delete` and Boat's exact-id delete confirmation header.
The proof's original key lacked `sandbox.resume`; the successful run used a temporary key
with that action. A stalled pooled TLS connection was also observed during an earlier run.
Boat requests now close their HTTP connections, without retrying uncertain commands; private
guest cleanup and live deletion have independent interruptible deadlines.

Viewer issuance is proven; embedding and interactive viewing in clients are untested here.
Signed-in cookies/profile retention, browser writes, tab manipulation, desktop mutations and
provider recovery under concurrent servers are not proven by this live suite. Linux trusted
browser clicks refused with `browser_input_trust_unavailable` in direct probing; the adapter
preserves that code rather than substituting synthetic DOM events. Driver mutation receipts
attest delivery, not the intended effect; fresh state follows every action. Client support for
the screen union belongs to its own lane. Flue placement and external state sync remain planned.

## Runtime on the Computer: planned

**Status: native browser and desktop backend built; runtime placement and external state sync planned.**
The browser and desktop now share Boat’s shipped guest. Running Vivid’s Flue runtime inside that
guest remains a separate step. The intended shape follows.

The Computer is not a harness the agent calls out to. It is the machine the agent already lives on
— `CONTEXT.md`: "the persistent private machine Vivid operates: filesystem, processes, browser
identity, and desktop. Its ordinary POSIX disk is live truth." A harness hands the agent fragments
and asks it to reassemble a workspace each time. This does the opposite: one machine, always there,
with the agent's process inside it.

The browser is part of that machine, not a tool bolted beside it. It runs as a real, signed-in
profile on the Computer's desktop — the same browser a person would use, with the same cookies and
sessions, reachable for human takeover.

### What follows from that

- **Some connectors stop being OAuth.** If the agent drives a profile already signed into Gmail, the
  credential is a live browser session on the Computer, not a refresh token in our database. That is
  a better trust model and it removes rows from `vivid_credentials` rather than encrypting them.
- **Egress belongs to the person.** Traffic leaves through the user's own connection, so the sites
  the agent uses see the user's usual network identity rather than a datacentre IP.
- **Takeover is a first-class state,** not an error path. A person can watch the screen, take the
  keyboard, finish the step, and hand it back — Grok Bot's "teach a task" shape.
- **Safety is lifecycle, not fragmentation.** The machine is separate, pausable, and watchable.
  Permissions govern what the agent may _do_ (`Capability`, `Grant`), not which fragments of a
  computer it may touch.

### Deliberately unresolved

- Where the machine runs by default — the user's own cloud account, Vivid-operated, or the Electron
  desktop hosting it locally. Alchemy makes several targets reachable; the default is a product
  decision, not a technical one.
- How the browser profile is seeded and kept in sync without shipping the user's cookies through us.
- Whether per-thread machines are containers on one host or something stronger.

### Ordering

`docs/09-platform-architecture.md` sets the sequence and it still holds: run one real agent loop,
prove durability across a restart, _then_ give it the real machine. The Computer lands on a backend
whose auth and scoping are already verified — not beside one.
