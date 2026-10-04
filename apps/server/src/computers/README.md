# Boat Computer provider

Boat is the only Computer provider. `Machine` owns its lifecycle, commands, browser input and
native desktop actions. `computerStoreLayer` owns Person scope, takeover and approvals;
`computerHandlers` exposes the shared RPC contract. No provider configured means `Unavailable`.

Configure the local server with server-only credentials and a prepared template:

```dotenv
VIVID_COMPUTER_PROVIDER=boat
VIVID_BOAT_TEMPLATE=vivid-computer-20261004
VIVID_BOAT_SIZE=default
```

`VIVID_BOAT_API_KEY` is required and stays secret. `VIVID_BOAT_ORG` is optional: omit it for the
key's personal wallet; set it to the paying organization when using an organization wallet.
`VIVID_BOAT_LIFETIME_SECONDS` is optional and defaults to 3600; 0 disables automatic archive.

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
exact-id confirmation header. Owner machines are never fixtures.
