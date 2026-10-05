# Computer

2026-10-03: The Boat implementation and real-service proof below supersede the earlier Grok Bot mapping; runtime placement, external state sync, egress through a Person’s device and takeover remain planned. Provider prices/specifications record the earlier research, not a fresh quote; current status is in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

2026-10-04: Boat is the only Computer provider; the local Docker desktop stand-in and its image are removed.

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
account that belongs to none, and Boat bills that account. The owner chose this recommended scope:
`sandbox.create`, `sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`, `sandbox.fork`,
`sandbox.delete`, `exec`, `file.read`, `file.write`, `desktop`, `ssh`, `host`, `snapshot.read`,
`snapshot.write`, `account.read`. It covers machine operations and read-only account diagnostics,
with no account-changing authority: no `environment.*`, no `account.admin`, no `agent.prompt`,
and never `*`. Vivid's provider uses `sandbox.create`, `sandbox.read`, `sandbox.stop`,
`sandbox.resume`, `exec`, `file.read`, `file.write` and `desktop` today. The live proof additionally
uses `sandbox.delete` for cleanup; operator limits/usage diagnostics use `account.read`.
`sandbox.update`, `sandbox.fork`, `ssh`, `host`, `snapshot.read` and `snapshot.write` are available
for machine work but have no direct provider calls today; stop/resume own their disk snapshot
through their respective actions. Boat's
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
The CLI's projected action refusals instead expose `effect: refused` and a route, omitting
the original code; these also fail explicitly, even through a permissive JSON decoder.

### Browser input on Linux

`browser_input_trust_unavailable` means this driver cannot deliver the requested browser input
while keeping Chrome in the background. In Cua Driver 0.23.2, Linux standalone Chrome clicks
are refused because trusted CDP mouse input activates the native window. This is an unconditional
platform restriction, not a missing permission, launch flag, or preparation step. The
[version-matched Linux source](https://github.com/trycua/cua/blob/cua-driver-rs-v0.23.2/libs/cua-driver/rust/crates/platform-linux/src/browser_platform.rs)
defines the restriction. The full refusal text remains in the daemon response's content;
the CLI projects it to `effect: refused`, route `trusted_input`, and escalation `route_unavailable`.

`browser_prepare` authorizes the existing profile and enables/attests its loopback DevTools
endpoint. On the real guest it opened Chrome's fixed setup page, toggled remote debugging and
closed that page, preserving the profile and process. X11 and AT-SPI permissions were healthy;
Chrome kept its existing user-data directory and exposed port 9222. Preparation enabled page
inspection and navigation, but the trusted click still refused afterward. Neither driver help
nor tool descriptions offer a flag to override Linux's background-input restriction.

Vivid therefore sends clicks through the driver's foreground desktop `click` tool, on the same
browser window the Person can watch. A fresh semantic page read first proves one accessible
control; a fresh window screenshot and AT-SPI snapshot then supply its enabled web-content
bounds. Screen bounds become window-local screenshot coordinates, accounting for capture
scaling. Missing, ambiguous, disabled or off-window targets fail before input. The Person or
Vivid must scroll an off-window target into view before clicking. Browser chrome with the same
label cannot become the page target. No DOM events are synthesized, and fresh browser state
always follows input. A sole tab in an exactly bound window proves selection even during a
native-title update; multiple tabs still require explicit active-tab proof.

Typing uses `browser_type` with `replace: true`: unlike clicks, this trusted CDP text route
worked on the real image. Vivid independently reads the exact field value afterward and fails
an unconfirmed replacement, without retrying input. Clearing may read back as the driver's
null empty value. Driver delivery receipts alone never establish the intended result.

Running state uses `screen: Viewer` (Boat's short-lived token-gated streaming page). `GetComputer` issues fresh viewer authority. Clients
must refresh it before expiry and use a sandboxed frame. The API key remains server-only.
Desktop actions use the same Gate and takeover recheck as browser actions: Look, Move, Scroll
and Wait are reads; Click, Drag, Type and Press follow the existing write policy. The runtime's
`use_desktop` returns real image content through Flue's public sandbox-tool API, alongside
bounded human-readable metadata. Boat supports browser and native desktop actions.

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

The extended live proof passed on 2026-10-03 with the owner-chosen recommended scope above.
It opened Example Domain (8.31s), read again (2.75s), scrolled its current “Learn more” link
into view (4.37s), and clicked through to IANA's Example Domains page (5.74s), asserting the
URL actually changed. It opened Selenium's public web form (5.27s), typed a known value
into “Text input” and read it back (4.60s), replaced it and read back the exact replacement
(5.25s), then cleared and read back the empty value (5.49s). Archive/resume and exact disk-marker
retention also passed; cleanup accepted deletion (0.14s). Total suite wall time was 68.15s.
Only one live suite was executed for this extension; a preceding launcher failed before
finding the checkout or creating a machine. Strict fake tests cover the Linux click refusal,
scaled fresh-window coordinates, same-label browser chrome, missing bounds, failed text
replacement, snapshot-bound refs, and selection during native-title lag. Raw describes, full
refusal content, preparation receipts, doctor/permissions, process/endpoint evidence and a
visible form screenshot were retained in the ignored review artifacts.

Viewer issuance is proven; embedding and interactive viewing in clients are untested here.
Signed-in cookies/profile retention, tab manipulation and provider recovery under concurrent
servers are not proven by this live suite. Driver mutation receipts
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

## The Person's own browser

The Person target means the retained pages in their signed-in desktop app, not the rest of their
computer. Existing requests still default to Vivid's cloud Computer. A Person target never falls
back to that Computer. Without a live device subscription it fails `NoDeviceConnected`.

Shared target/device contracts and the server's authenticated request/receipt channel are built.
Real PostgreSQL tests with a fake device prove selected-subscription delivery, receipt authority,
expiry and uncertain disconnects without replay. This added server/desktop hop is a forced
deviation from the reference's local model loop; its answer deadline is separate from native budgets.

The native port is blocked. The recovered browser service creates target tokens and sends them
with CDP input, but the corresponding enforcement receiver and Person-input attribution are not
recovered. The exploratory Electron proof opened/read a page, then its CDP click answered Stopped.
The guessed matcher/driver was removed. The public Person route fails closed even with a live
subscriber; neither `on: 'yours'` nor expanded runtime abilities ship.

`packages/contracts/src/browsers.ts` reserves access-request scopes, control status and Run Stop.
These are not implemented grants or working Stop handlers. App/site access remains separate from
an action Approval. Setup/execute, native budgets, grant persistence and Run stop markers still
need their reference ports. Existing `pages.stop(tab)` stops loading only.

Reference: browser `browser-service.mjs::ai/ec/tc/JA/Rs/wB/mJ/Dne/a7e`, main
`executeCdpForBrowserUse/Yte/turnEnded`, and Windows `helper_transport.js::request/D/F/U`.
The missing input-token receiver must be recovered before desktop control can ship.

**4 October 2026 — stage 1 browser decision.** The desktop app executes Person-computer
browser actions using T3 Code desktop’s mechanism: `webContents.debugger` CDP. T3’s
expected-input matching and human-control epochs were deliberately NOT ported: the owner decided
the same day that touching the page does not interrupt Vivid; only the explicit Stop does.
The Codex token receiver was never recovered; that token blocker no longer gates stage 1.

### Permission for the Person’s browser

**4 October 2026 — owner decision: “I don't need approval for writing my browser”.** Click,
Type, Press and CloseTab on the Person’s computer follow the same table as a write through the
Person’s own Integration: with no review a write runs; with review, the Person asked for it or
it is contained runs, and unasked and reaching other people asks. A destructive action, an Ask
rule, a Never rule and anything personal in a Thread others can see still ask or refuse. The
risk, stated plainly: Vivid acts as the Person on every site they are signed in to, without
asking. What stops it is a rule, the Stop on the page, and removing the computer in Settings.
Earlier the same day these writes always asked; that rule is gone and must not be put back by
a later review without the owner. Only the Person whose computer it is may decide an Approval
for an action on it.

Personal browser reads and screenshots ask before their contents enter a shared Thread. Private
Threads keep reads unasked. Open, OpenTab, Back and Forward remain reads by explicit policy; a
credentialed GET can still have side effects. The desktop refuses private-network addresses and
the Person retains an explicit Stop.

A pending Approval is deduplicated by its original workspace, Thread and action digest, retaining
the first proposing Run. A Run sending its own action must still be Working. An action the
Person approved is sent for that exact Run when it is Working or Completed, because raising an
Approval ends the Run's turn; a stopped or failed Run sends nothing, and that is reported as
not sent. Only a sent action without a known result is OutcomeUnknown.
Page metadata carries an optional branded PNG attachment, omitted when genuinely absent.
Each encoded PNG is capped at 8 MiB before device-answer and history retention.

## The Person's own computer: apps

Allowing a Device once lets Vivid work in any app on that Person's Windows computer, including terminals, through the Vivid desktop app. Nothing is asked after that: no per-app Approval, extra switch or app restrictions. A notice stays visible while Vivid works; Escape or Stop ends the Run. When that Run settles, the server tells its connected Device to end the notice. An offline Device simply misses that signal. Dispatch uses the existing 30-second deadline and content-free ledger and is never replayed after a lost answer. Presence and links live in one process, so the server must run as a single replica.
