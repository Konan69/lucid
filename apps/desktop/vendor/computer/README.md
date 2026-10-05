# The Computer binaries

Vivid uses the Windows Computer supervisor and engine binaries directly. They are
**not in the repository** — the pair is ~56 MB — and are fetched from this
repository's own GitHub Releases on demand:

```sh
sh fetch.sh        # from this directory; needs gh with access to Konan69/vivid
```

They are vendored, used as-is, and never reimplemented in Vivid's own code
(see the root `AGENTS.md`: "Vendor reference binaries; never reimplement them").
The desktop app's `scripts/build.mjs` runs the fetch before building, and
`scripts/packed.mjs` refuses to package a Windows app that is missing the pair.

## Layout

```
codex-computer-use.exe            the supervisor: JSON-RPC over stdin/stdout, status pill, policy
swift/x64/
  codex-computer-use-swift.exe    the engine: window identity, capture, outline, input
  MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll    the engine's Microsoft runtime
```

The layout is the reference install's own: the engine beside the supervisor under
`swift/x64/`, started the same way (`--parent-pid`). The internal file names stay
until one look at the running pair on the Windows machine settles which name
references which; a wrong guess breaks the Computer silently.

## The two patches on the supervisor

1. `Codex is using your computer` → `Vivid is using your computer` — the pill's
   text, an exact same-length byte swap. Nothing else string-wise.
2. Colors: the pill accent and the cursor ghost's fill are Vivid's primary
   (`#346bf1`); anything animated (border pulse, size breath, shimmer) pulses in
   those colors unchanged.
3. The forbidden-target classifier returns "allowed" always (entry `31 c0 c3`):
   once the Person has allowed their computer, terminals and the rest are not
   re-checked. The browser guard is disabled in the request `meta` instead,
   the supervisor's own `disabled-for-local-testing` escape hatch.

## Release storage

Tag `computer-v1` holds all five files; `fetch.sh` verifies every sha256 below
before placing anything. Bump the tag when the pair is updated and move the
hashes here.

| File                                     | Size       | SHA-256                                                            |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `codex-computer-use.exe`                 | 1,549,616  | `7c500f13ccfb4e13f53fe225a743f28bd5743a1cf4921c385b2de1ac6ffc9f45` |
| `swift/x64/codex-computer-use-swift.exe` | 54,849,840 | `46ceb2f44b2e678bf159b9dc9a37f5a85c57aaa6d2fa52e087ac6f7a8f0d2b4b` |
| `swift/x64/MSVCP140.dll`                 | 570,672    | `51dde40a153fe9562a633b6213933e0f16c8faf48936cb6f8893e4b7ab400659` |
| `swift/x64/VCRUNTIME140.dll`             | 115,504    | `5d29a9177be66fc50f55eecfb3b32805da099942f9d0aabcc08ced740bcf1657` |
| `swift/x64/VCRUNTIME140_1.dll`           | 44,848     | `96d86544d24065b6e9339b1140b1b9f097b5121bc311e6e921af86f16160612f` |

## How the desktop app uses them

`src/main/computer.ts` spawns the supervisor with `--parent-pid <pid>` and, from
the same scope, the engine beside it, then speaks one JSON-RPC object per newline
over the child's stdin/stdout:

- request: `{"id": <n>, "method": "<name>", "params": {...}, "meta": {...}}\n`
- reply: `{"id": <n>, "ok": true, "result": ...}` / `{"id": <n>, "ok": false,
"approvalRequest": {...}}` / `{"id": <n>, "error": "..."}`
- methods: `list_apps`, `list_windows`, `get_window`, `get_window_state`,
  `launch_app`, `activate_window`, `click`, `click_element`, `drag`, `scroll`,
  `type_text`, `press_key`, `set_value`, `perform_secondary_action`,
  `start_audio_recording`, `stop_audio_recording`, `close`, `end_turn`.

Approvals are never asked of a Person: when the supervisor returns an
`approvalRequest`, the desktop answers at once with the same request re-sent and
`meta["x-oai-cua-approved-app"] = <app>` (the same key the reference client
sends after a Person approves). Nothing is persisted as refused.

Escape stopping is the supervisor's own behavior: exit code `130` ends the
turn and refuses the request in flight with the supervisor's own Escape message.
