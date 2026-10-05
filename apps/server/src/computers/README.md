# Boat Computer provider

Boat is the only Computer provider and every Vivid has it. `Machine` owns its lifecycle, commands,
browser input and native desktop actions. `computerStoreLayer` owns Person scope, takeover and
approvals; `computerHandlers` exposes the shared RPC contract.

The server does not start without these two, and the failure names the variable:

```dotenv
VIVID_BOAT_API_KEY=…        # secret
VIVID_BOAT_TEMPLATE=vivid-computer-20261004
```

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
configured size (`VIVID_BOAT_SIZE`) the start asks for each larger size in turn and logs the move.
The next start asks for the configured size first again, so a machine moved up comes back down
when Boat has one. A resume that another caller left waiting (an SSH wake, the dashboard) is
stopped back to its saved disk once Vivid has seen it wait ten seconds, and started the same way
(`boat/lifecycle.ts`, `withdrawn`). When no size has a machine, nothing was started: the Computer
stays stopped, the call says the provider has no machine free, and the next need asks again
without anyone pressing Start. The creation of a Person's first machine is not covered: it still
waits for Boat.

Boat itself not answering is not a state the server is in. A connection that fails, a reply that
does not come in time, or Boat's own 5xx is an outage: the call that met it is refused with
"Vivid’s computer is not answering right now", nothing about it is written to the Computer's
record, and the next call asks Boat again, so it is over when Boat is back, with no restart and
without anyone pressing Start. A start that Boat refused or could not finish is different: it is
recorded as failed with its reason and needs a Person to start the Computer again. So does one
outage case: when the outage met the creation of a Person's first machine, Boat's adapter keeps the
unanswered creation as unresolved (a machine may have been made and paid for) and it is reconciled
by an explicit Start, never by a retry on its own.

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
