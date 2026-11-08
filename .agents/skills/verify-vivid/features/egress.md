# Computer browser egress

Model requirement for native component checks is none. Full product verification needs a real runtime model and connected disposable Computer and desktop authorities.

## Native proxy component proof

`apps/server/src/computers/egress/proxy.test.ts` launches the shipped `proxy.mjs` CLI on ephemeral loopback ports. It drives real TCP connections with production frame codecs. Cases cover direct routing, CONNECT, HTTP upgrade, half-close, refusal, windows, malformed lengths, fragmented headers and bodies, and coalesced frames.

The link-budget case uses paused real TCP browser connections. Each connection receives a burst below its stream budget, and their combined sent bytes exceed the link budget. The case observes a stream closing. Kernel buffering consumes an unknown portion of the sent bytes, so this case does not prove the exact 96 MiB logical boundary or acceptance at that boundary.

The isolated budget probe was retired under the user's ban on unit tests and mocks. It imported production functions into a constructed tunnel with a `PassThrough` socket instead of driving the native TCP path. Its IPC schemas, exact-boundary test, production exports, and import guard are removed. The exact logical boundary remains unproved.

Run this focused component check on the selected Cloudbox devbox through the gate's disposable database workflow.

```sh
pnpm gate focused apps/server/src/computers/egress/proxy.test.ts --host <selected-devbox>
```

The existing `apps/desktop/src/main/egress.test.ts` additionally drives the real desktop exit client against this CLI. Its middle leg connects locally instead of using the authenticated server WebSocket and SSH relay. Neither suite proves complete product egress or a performance improvement. Record the exact head, working-tree status, host, command result, evidence path, and cleanup result for any component proof.

## Full product journey

The web control is Settings > General > Send Vivid's browsing through your computer. Public `GetEgress` and `WatchEgress` report its state. The desktop uses the authenticated `EGRESS_PATH` WebSocket. The server relays frames through SSH to the Computer's loopback tunnel port. The Computer's browser uses its loopback HTTP proxy.

A full recipe must use a synthetic Person, a disposable Computer provisioned through public product operations, and a signed-in desktop exit client with that Person's allowed egress authority. The disposable server needs credentials and network access for its Boat provider and SSH path. An owned destination must record requests from the desktop's network. Drive browsing through Vivid's real browser tool and verify the destination's receipt, Settings status, stream isolation, and direct browsing after detach. Record web, phone, and desktop coverage separately.

## Blocked verification

Full HTTP and browser journeys are blocked. The current verify-vivid launch deliberately leaves Boat unconfigured and supplies no connected Computer authority, as documented in `../references/boundaries.md`. Its dispatcher has no egress HTTP or browser recipe. This mapping adds no dispatcher or passing verdict.

The prerequisite is an explicitly connected disposable Boat Computer plus a disposable signed-in desktop exit authority, reachable through the launched server's public authentication and relay. Add a recipe using those authorities before `verify feature egress` or `verify browser egress` can verify this feature. Launch, Doctor, native component results, and a Settings screenshot alone cannot establish full egress. Never use a Person's production Computer for proof infrastructure.
