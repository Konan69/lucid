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
