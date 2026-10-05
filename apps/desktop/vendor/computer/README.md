# The Computer binaries

Vivid uses the Windows Computer supervisor and engine binaries directly. They are
vendored here unmodified except for one string patch (below), and are never
reimplemented in Vivid's own code (see the root `AGENTS.md`: "Vendor reference
binaries; never reimplement them").

## Files

| File                                                               | Size       | SHA-256 (first 16)              | What it is                                                                                            |
| ------------------------------------------------------------------ | ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `codex-computer-use.exe`                                           | 1,549,616  | `85e82a75724934b1`              | The supervisor. Serves JSON-RPC over stdin/stdout, draws the status pill, gates policy and approvals. |
| `swift/x64/codex-computer-use-swift.exe`                           | 54,849,840 | `46ceb2f44b2e678b`              | The engine. Windows identity, capture, accessibility outline, and input.                              |
| `swift/x64/MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | —          | see `swift/x64` manifest hashes | The VC runtime the engine loads.                                                                      |

The pair came from the Windows machine's own reference install (verified against
`~/codex-recon/helper/` and the install's `manifest.json` hashes), captured
2026-09-08. The layout mirrors the reference exactly — the engine beside the
supervisor under `swift/x64/`, with its runtime DLLs — because the reference's
own app starts both the same way (`--parent-pid`) and the pair finds each other
itself. The internal file names are kept until one look at the running pair on
the Windows machine settles which name references which; a wrong guess here
breaks the Computer silently.

## The one patch

`Codex is using your computer` → `Vivid is using your computer` at offset
`0x132af9`. Same length, byte-for-byte swap, nothing else in the file changes.
This is the status pill the supervisor draws while it uses the computer, and it
must say Vivid. Re-running the patch script against a fresh binary is safe: it
asserts the old string occurs exactly once and fails loudly otherwise.

## How the desktop app uses them

`src/main/computer.ts` spawns `codex-computer-use.exe --parent-pid <pid>` with
hidden windows and speaks one JSON-RPC object per newline over the child's
stdin/stdout:

- request: `{"id": <n>, "method": "<name>", "params": {...}, "meta": {...}}\n`
- reply: `{"id": <n>, "ok": true, "result": ...}` / `{"id": <n>, "ok": false,
"approvalRequest": {...}}` / `{"id": <n>, "error": "..."}`
- methods: `list_apps`, `list_windows`, `get_window`, `get_window_state`,
  `launch_app`, `activate_window`, `click`, `click_element`, `drag`, `scroll`,
  `type_text`, `press_key`, `set_value`, `perform_secondary_action`,
  `start_audio_recording`, `stop_audio_recording`, `close`, `end_turn`.

Approvals are never asked: when the supervisor returns an `approvalRequest`,
the desktop answers at once with the same request re-sent and
`meta["x-oai-cua-approved-app"] = <app>` (the same key the reference client
sends after a Person approves). Nothing is persisted as refused.

Escape stopping is the supervisor's own behavior: exit code `130` ends the
turn; the supervisor also drops an interrupt marker under
`~/.codex/cache/computer-use/interrupts/<conversation>/<turn>` and the transport
refuses further work for that turn.
