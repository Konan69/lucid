# Boat Computer provider

Boat is the only Computer provider and every Vivid has it. `Machine` owns its lifecycle, commands,
browser input and native desktop actions. `computerStoreLayer` owns Person scope, takeover and
approvals; `computerHandlers` exposes the shared RPC contract.

The server does not start without these two, and the failure names the variable:

```dotenv
VIVID_BOAT_API_KEY=…        # secret
VIVID_BOAT_TEMPLATE=vivid-computer-20261004
```

The server reaches a Computer's shell and files over SSH, and no SSH key is a setting. Each
connection makes its own key pair in memory, has Boat let the public half in on that one machine,
and drops the pair when the connection ends; the first thing a new connection does is remove the
key lines of earlier connections from the machine (`ssh/link.ts`, `ssh/links.ts`).

There is no provider selector and no "no provider" server. Optional, each with a default or a real
choice behind it: `VIVID_BOAT_ORG` (omit it for the key's own wallet; set it to the paying
organization when the key's account belongs to one), `VIVID_BOAT_SIZE` (`default`),
`VIVID_BOAT_LIFETIME_SECONDS` (3600; 0 disables automatic archive), and `VIVID_BOAT_MACHINE`, which
names one existing machine for the installation to use instead of creating one for each Person:
the first Person to start a Computer keeps it and other accounts are refused.

A machine is one account's, and the machine itself says whose. The binding table allows one
account for a machine, but a table belongs to one server, and two servers could each bind the same
existing machine without seeing the other. So every wake first settles the holder on the machine's
own disk (`~/.vivid/holder`, `boat/holder.ts`), in the same command that opens the desktop: the
first binding to wake a machine becomes its holder, and any other binding, from this server or
another, is refused with "already in use by another account" before anything is opened. A
process that meets a machine already running that it did not wake itself (after a restart, or
with a row no wake made) asks the same question once before it runs a command, takes a desktop or
browser step, shows the screen or stops the machine. A refused server gives its binding up. The
whole question is asked under a lock on the machine, so two servers that reach it in the same
instant cannot both become its holder. A record that is damaged or cannot be read settles nothing:
the call fails, nobody takes the machine and nobody loses a binding, and an operator looks. The
record is kept across archive and resume. Giving a machine to another account is an operator's
act, in this order: stop the machine, remove the old binding in the table that holds it, remove
the file on the machine.

Three limits. An archived machine cannot be asked, so a server it then refuses has already woken
it, and leaves it running for Boat's own archive timer (or, with `VIVID_BOAT_LIFETIME_SECONDS=0`,
until its holder stops it). A machine between states takes no command,
so a stop sent to one is not checked. And a copy of the holder's database is the holder, because
the record names a binding and a copied table has the same binding.
`held.live.test.ts` (`VIVID_LIVE_MACHINE_HELD=1`) runs the refusal against a real machine.

So `VIVID_BOAT_MACHINE` belongs in one environment only. A local or test stack must not name a
machine another server's account holds: it would be refused at the first wake, having woken it.

A start never waits for Boat to find a machine. Boat accepts a resume when it has no machine of
that size and lets it wait, with no error to read: on 5 October 2026 the installation's machine sat
in `provisioning` for two hours that way. So every start is a resume that may not wait (`failFast`,
`boat/transport.ts`): Boat answers in about two seconds, and when it has no machine of the
configured size (`VIVID_BOAT_SIZE`), or the machine's disk has outgrown that size, the start asks
for each larger size in turn and logs the move. The next start asks for the configured size first
again, so a machine moved up comes back down when Boat has one. A resume that another caller left
waiting (an SSH wake, the dashboard) is stopped back to its saved disk once it has waited ten
seconds, counted from when Vivid first saw it, and started the same way within the same start
(`boat/lifecycle.ts`, `withdrawn`). A machine between states cannot be asked who holds it, so this
stop, like the wake of an archived machine, is made before the holder is settled. When no size
takes the machine, nothing was started: the Computer stays stopped, the action that needed it is
refused with "its provider has no machine free right now", and the next need asks Boat again
without anyone pressing Start. Two things are not covered: the creation of a Person's first
machine still waits for Boat, and a Person who presses Start when no size is free sees the
Computer return to stopped without that reason.

Boat's other answers to a start are read from its error body (`boat/transport.ts`, `started`),
each seen on 7 October 2026. `resume_failed` with "needs … GiB of disk but the largest … machine
holds …" is a size the Computer's data no longer fits, and the start moves to the next size; the
last one, `xlarge`, is refused with `machine_class_plan_required` on Boat's smaller plans. When no
size the plan allows can hold the Computer the start fails `MachineOutgrown`, and the Person is
told what cures it: files removed, or the provider plan upgraded. `rate_limited` is the account's
25 starts an hour being spent: the start stops asking and says to try again in a few minutes.

A machine Boat calls running does not take commands yet: for about 35 seconds its command endpoint
answers 502. The first command Vivid sends a woken machine (the holder claim, the snapshot rules
and the desktop launcher, one command) is therefore sent again every two seconds for up to 75
seconds (`boat/holder.ts`, `asked`). It is Vivid's own and says the same thing each time. A machine
that never takes it is an outage. The snapshot rules are a `.boxignore` in the Computer's home
directory, written when there is none: Boat captures every file each minute, counts a hard link as
a full copy, and starts a machine only on a size that holds everything captured, so download
caches are kept out of the snapshots.

Boat itself not answering is not a state the server is in. A connection that fails, a reply that
does not come in time, or Boat's own 5xx is an outage: the call that met it is refused with
"Vivid’s computer is not answering right now", nothing about it is written to the Computer's
record, and the next call asks Boat again, so it is over when Boat is back, with no restart and
without anyone pressing Start. A start that Boat refused or could not finish is different: it is
recorded as failed with its reason. The record says what the last start met, never that Vivid
stopped trying: the next action starts the Computer again (`store.ts`, `prepare`). Until 6 October
2026 a failed start waited for a Person to press Start, and one start that met Boat's 502 refused
every action for the rest of that day. The exception is a failure that asking again cannot cure
(`machine.ts`, `isStanding`: the Computer has outgrown every machine, another account holds it,
the credentials are refused, a creation is unresolved). For ten minutes after one of those the
action is refused with the recorded reason and Boat is not asked, because every start counts
against the account's hourly limit; a Person's Start still tries at once. An unresolved creation
is safe to start again: the adapter replays its one intent under the same idempotency key for 23
hours and refuses after that, so a second machine is never made.

A Person's read of the Computer asks two more things of a machine that runs: whether this binding
holds it, and its screen. Failing either says nothing about whether the machine runs, so it is
told on that read and never recorded as the Computer's state (`store.ts`, `get`). A machine found
running that the record did not have running counts its idle time from that moment.

A Person's Computer runs nothing but Vivid's product. Gates, builds and test suites run on the
build machine; `scripts/gate/cloud.mjs` refuses a host that resolves to the Computer.

## Egress

A Person signs in to sites at home, and the Computer is in a datacentre; a sign-in used from a
datacentre address is what sites revoke. With egress on (`Settings.egress`, off until the Person
turns it on; issue 61 removes the choice), the Computer's browser sends its traffic out through
the Person's own computer, so sites see the address they signed in from.

```
Computer's Chrome --proxy--> proxy.mjs on the Computer (loopback 8791)
                                 | one stream per connection, loopback 8790
server: SSH channel to 8790 <----+        (`ssh/link.ts` `tunnel`, `egress/relay.ts`)
   |  WebSocket /api/computer/egress, the desktop app's own session (`egress/route.ts`)
desktop app: resolves the name, dials the site, carries the bytes (`apps/desktop/src/main/egress.ts`)
```

The frames are Grok Bot's (`packages/contracts/src/egress.ts`), with two kinds added. `End`: a
stream's two directions end apart, so a browser that has sent its whole request still gets the
answer, however long the site takes; nothing here times a quiet stream out, and a site that has
vanished is found by TCP keep-alive on the socket the desktop app dialled. `Grant`: each
direction of each stream has a window, so a slow site or a browser that is not reading slows
that one connection. Grok Bot's desktop app dials its machine's hosted port; a Computer here has no
port a home network can be sure of reaching, so the desktop app dials the server and the server
joins it to the Computer over the SSH connection it already holds. Nothing on the Computer
listens beyond loopback.

- The desktop app holds its socket open whenever someone is signed in. The server parks it until
  egress is on and the Computer's record says running, then starts the proxy on the Computer
  (`egress/guest.ts`, any number of times, and at the same moment) and joins the two. It never
  wakes a Computer for this.
- A Person has one way out at a time: the first desktop app of theirs whose socket this server
  holds. A second app signed in as the same Person is kept and waits, joined to nothing, and
  becomes the way out only when the first's socket goes. Nothing is sent to tell it so: its
  socket stays open, which is all an app needs in order not to dial again. Which computer a
  Person would rather use is not chosen anywhere yet (issue 61); this rule needs no setting.
- One socket is one join. When a join ends for any reason (egress turned off, the Computer
  stopped, the channel closed, a frame that is not one), the server closes the app's socket. The
  app ends every connection it had made and dials again, with an empty table. Nothing of an old
  join can then be read as part of a new one (`egress/relay.ts`).
- A socket whose app went without closing it (a computer that sleeps, a network that drops) is
  found and ended. Every fifteen seconds the server pings each egress socket it holds, joined or
  parked or waiting its turn, and sends one text message beside the ping, which is what a
  desktop app can see of it. A socket on which nothing has arrived for forty-five seconds is
  terminated (`egress/route.ts`, `watched`): its place in the Person's line goes, and the next
  app of theirs becomes the way out. The app keeps the same rule toward the server and dials
  again. The numbers are the SSH connection's to the Computer, the tunnel's other leg, and are
  in the contract (`EGRESS_PING_MILLIS`).
- The app dials again two seconds after a socket that had stayed open for thirty seconds. A
  socket that never opens, or is closed sooner than that, makes the next wait twice as long, up
  to thirty seconds, so a join that ends as soon as it is made does not run the start command
  on the Computer every two seconds.
- When a hold ends the server closes the socket and waits until its connection is gone, so
  nothing is written to it afterwards. An app that does not answer the close within five
  seconds has the connection ended under it (`egress/route.ts`, `closed`); the server's
  shutdown waits that long for such a socket and no longer.
- The app's socket is upgraded at a WebSocket boundary of its own (`egress/route.ts`) that
  takes no message longer than a frame and closes with 1009 at the piece that crosses it. The
  server's other sockets keep their own limit.
- A browser's way out is decided when it starts: a step that has to start Chrome gives it the
  proxy only when egress is on (`boat/browser.ts`). A Chrome that was already running, or one the
  Person started from the launcher, goes out directly until it is started again.
- The proxy dials from the Computer itself while no desktop app is joined, so the browser never
  loses the internet because nobody is at home. Turning egress off un-joins; the same Chrome
  then goes out directly.
- The desktop app refuses a target inside its own networks (`apps/desktop/src/main/reserved.ts`)
  after resolving the name, and dials the address it checked. For IPv6 it dials only what a
  public host can have, which is stricter than the reference.
- Every hop holds a bounded amount (the contract's "How much a hop may hold"). A frame is at
  most one mebibyte. Each direction of a stream has a window of 256 KiB, yamux's: the sender
  stops reading that stream's own socket when the window is used, and the receiver grants more,
  half a window at a time, only as the stream's own socket takes what was written. So an upload
  of any size to a slow site arrives whole at the site's pace, and the other streams go on. The
  server holds nothing for any one stream and passes grants through. A grant is for bytes that
  were sent: one that would give a sender more than the window to send (said twice, or made
  up) ends that stream with a close and nothing else. The older bounds remain
  for a far end that ignores the window: a stream holding 32 MiB, or a link 96 MiB in all, is
  closed.
- A site that hangs up in the middle of a plain HTTP answer ends the browser's request: the
  proxy drops the browser's connection, which is how a browser learns an answer is not whole.
- The status (`WatchEgress`) is this server process's reading of the sockets it holds; with more
  than one server process, a Person whose desktop app is held by another reads "waiting" here.

Who is trusted. The two ports on the Computer (8790, where the tunnel attaches, and 8791, the
browser's proxy) are on loopback and ask for nothing. Any program running on the Computer can
therefore send traffic out through the Person's home address by using 8791, and can attach to
8790 in the server's place, which takes the tunnel from the server and lets that program read
and answer what the browser sends through the proxy (inside HTTPS it sees only where a
connection goes, not what is said). This is inside the trust the Computer already has: the only
thing that runs there is Vivid's own Run, which already drives that same browser and can open
any page with the Person's sign-ins. A secret for the tunnel was considered and not built: the
start command would have to leave it on the Computer for the proxy to read, in the same account
every program of a Run uses, so it would stop nothing that can reach the port. It would matter
only if a Computer ran programs as a second account, which it does not. What does not rest on
the Computer is the Person's own network: the desktop app decides what may be dialled, after
resolving the name itself, and a program on the Computer cannot widen that.

`egress/address.live.test.ts` (`VIVID_LIVE_EGRESS=1`) opens an address-echo page on a real
Computer with a real desktop app attached, with egress on and with it off, and compares the
addresses in the receipts the Computer's browser left, not what Vivid said about them.

Boat supplies the real desktop, Chrome and native input driver. Running state carries a short-lived,
token-gated Viewer address; provider keys never enter client state or model context. Browser and
desktop writes pass the same Gate and takeover checks. Uncertain commands are never retried.
Durable bindings reconcile creation, archive and resume without creating replacement machines.

`infra/computer/apps.json` is the sole release app set. `prepare.py` installs and verifies it once,
configures the native Xfce launcher with browser, terminal and files pinned, and publishes a Boat
named snapshot. New Computers restore that template; no first-use package install is performed.
`GetComputerApps` probes the running machine's catalogue. Only observed plain app names enter
response context; absent machines and failed probes make no installed-app claim.

Opt-in live proofs use `VIVID_TEST_BOAT_LIVE=1` and `VIVID_LIVE_THREAD_COMPUTER=1`, respectively.
Database authority must come from `VIVID_TEST_DATABASE_URL` for an isolated disposable database.
Fixture cleanup registers before creation and deletes only its captured provider id using Boat's
exact-id confirmation header. Owner machines are never fixtures: do not run either proof with
`VIVID_BOAT_MACHINE` set, because the bound machine would then be the adopted one.
