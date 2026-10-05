# Windows Computer helper

Vivid's native console helper speaks JSON lines over stdio and draws no window.
`Notice.Show()`/`Hide()` stay empty; desktop main draws and owns the notice. Run
unelevated in the Person's own interactive Windows session. Elevated helper startup
fails; elevated or unverifiable targets are refused before activation or input. Element actions also verify the UIA element
process image and integrity; a hosted child never inherits its HWND host
process's permission.

## Build and ownership

```powershell
.\build.ps1 -Output "$env:USERPROFILE\Vivid\build"
```

The script uses the in-box Framework64 v4.0.30319 `csc.exe`, installed UI Automation
assemblies, System.Drawing, System.Web.Extensions and Microsoft.CSharp. It prints
its exact command and compiler PID; no SDK, packages, installation or settings
changes are needed. Products go only into `-Output`.

Desktop **main** spawns `Vivid.Windows.exe --parent-pid <main-pid>` with private piped
stdio and `windowsHide:true`. `--test-mode` additionally enables `simulate_escape`.
EOF/`close` exit 0; parent exit ends the helper. Never expose stdio to renderer or
network clients. Desktop main must enforce Person/Device/Thread/Run authority,
serialize requests, validate responses, cancel queued work on stop, and end the
turn on revocation, Run end or connection loss. Integration is not implemented here.

## Protocol

UTF-8 JSON lines: `{id:integer,method:string,params:object,turn?:string,budget_ms?:integer}`.
`params` is required, including `{}` for methods without parameters. One request
at a time. Success: `{id,ok:true,result}`. Failure: `{id,error:{name,message}}`.
`InvalidRequest` additionally carries the offending `field` (unknown keys use `key`).
`TypingInterrupted` additionally carries `delivered` and `reason` inside `error`.
Invalid envelopes retain a valid integer id when possible, otherwise id 0;
oversized lines and invalid UTF-8 use id 0. No OS exception text or stack traces
escape. Stderr contains short diagnostics, never window titles, text or images.

Every method requires `begin_turn`, except `begin_turn`, `end_turn`, `close`, and
`status`. This includes **observation** (`list_windows`, `get_window_state`) and
installed-app inventory. `status` captures nothing and returns phase
`Idle`, `Active` or `Stopped`, `hooksLive`, `cooldownRemainingMs`, and `diagnosticsDropped`.

| Method             | Params                                                 | Result                                                                                    |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `begin_turn`       | `{}` plus envelope `turn`                              | `{active:true}`; start that authorized turn                                               |
| `end_turn`         | `{}`                                                   | `{active:false}`; clear caches; preserve stop latch                                       |
| `status`           | `{}`                                                   | `{phase,hooksLive,cooldownRemainingMs,diagnosticsDropped}`; no capture                    |
| `list_apps`        | `{}`                                                   | `{apps:[{name,id,source,launchable,reason}],skipped}`                                     |
| `launch_app`       | `{app: name,id?: inventoryId}`                         | `{pid,app,id}`                                                                            |
| `list_windows`     | `{}`                                                   | `[{app,id,pid,title,inputAccess}]`                                                        |
| `activate_window`  | `{window}`                                             | `{}`                                                                                      |
| `get_window_state` | `{window,include_text?,include_screenshot?}`           | `{window,text?,truncated?,screenshot?,origin?}`                                           |
| `click`            | `{window,element_index,click_count?,mouse_button?}`    | `{}`                                                                                      |
| `click`            | `{window,x,y,screenshotId,click_count?,mouse_button?}` | `{}`                                                                                      |
| `type_text`        | `{window,text,element_index?}`                         | `{}`; at most 4000 UTF-16 units                                                           |
| `press_key`        | `{window,key}`                                         | `{}`; exact Alt+F4 returns `{outcome:"closed"}` or `{outcome:"closePending",dialogClass}` |
| `scroll`           | `{window,x,y,screenshotId,scrollX,scrollY}`            | `{}`                                                                                      |
| `close`            | `{}`                                                   | `{}`, then exit 0                                                                         |
| `simulate_escape`  | `{}`                                                   | `{stopped:true}`; test mode only                                                          |

`launch_app` requires a successful `list_apps` in the current turn; beginning or
ending a turn clears catalog authority. It matches an installed name exactly, case-insensitively. It rejects
paths, UNC strings, arguments and names absent from the same `list_apps` inventory.
Supply `id` to disambiguate duplicate names; it is never a caller-controlled launch
path. Inventory combines Person/shared Start Menu `.lnk` executable entries with
packaged AppsFolder entries read through shell COM. Shortcut targets and arguments
come exclusively from those entries. Shortcut children receive null standard
handles with inheritance disabled. `CreateEnvironmentBlock` uses the current user
primary token with `bInherit=false`; `CreateProcess` receives that fresh Unicode
block and `CREATE_UNICODE_ENVIRONMENT`, never the helper/desktop environment.
There is no `CREATE_NO_WINDOW` launch: console executables are refused first.
We chose explicit environment isolation rather than `ShellExecute` from the helper,
which would not establish independent environment provenance. Packaged apps use the public
`IApplicationActivationManager.ActivateApplication` broker, with no helper handles.
Launch PID may be a launcher or an existing instance; it does not authorize any
arbitrary window or justify terminating an existing process. App handoff is async.

`window` is the inventory `{app,id}` pair. `app` names the HWND's owning process;
packaged windows may belong to ApplicationFrameHost. `id` is an opaque string binding the helper session, HWND, process
id, process creation time and class. It is stable while that identity stays alive. Every list rebuilds the inventory, skipping
vanished/inaccessible windows; resolving a vanished/changed identity gives
`WindowGone`. `inputAccess` is `Allowed`, `Elevated` or `Unverified`; input rechecks
the token rather than trusting this inventory value. Same-process, same-class HWND
reuse between observations cannot be distinguished. Re-inventory and observe after a window closes.

Text defaults false, screenshot true; both false is invalid. Text is UI Automation
ControlView preorder with indexes, roles, names, values, enabled state and physical
bounds. Virtual controls retain UIA `Name`, including buttons, menu/list items,
tabs, checkboxes and links. For Document/Edit/Text controls with TextPattern, use
`DocumentRange.GetText(201)` instead of an unbounded document-sized name. Every
name/value caps at 200 UTF-16 units with an ellipsis. UIA current/cached `Name`
is an indivisible BSTR property with no length-only or maximum-length getter.
Caching cannot bound that allocation; non-document labels are fetched whole and
capped immediately. A malicious provider can still allocate a huge label. ValuePattern has no bounded
read or length property, so its unbounded values remain explicitly skipped.
The `truncated` flag covers text/structural limits and value omissions. Traversal
stops globally at 500 elements or depth 32. Password text stays hidden; absent
patterns are marked. Provider indexes vary: never hard-code them.

Screenshots are `{id,width,height,png,source,scale}`. PNG is base64, never a path.
The longer side caps at **1920 pixels**. `scale=min(1,1920/max(original dimensions))`;
the short side rounds to the nearest integer. Callers always send **screenshot
pixels**. The helper maps x to `floor(x*originalWidth/width)`, y analogously, then
adds physical `origin`. No caller DPI division is needed. Screenshot dimensions
bound coordinates; SendInput then maps to primary-display absolute coordinates.
PrintWindow uses PW_RENDERFULLCONTENT; packed-row LockBits detects all-black output.
Screen-copy fallback requires foreground ownership, primary-display containment
and no overlapping visible window. It can still race other window movement.

## Input, stop and budgets

Every input attempt after activation (or a targeted close) invalidates both the screenshot id and text
indexes for that window, including partial/refused native delivery and activation.
Get fresh state before another coordinate or element input. Coordinate input also
requires unchanged bounds. Click count is 1..3; left/right/middle are supported.
Single left element clicks prefer InvokePattern, then TogglePattern, then
SelectionItemPattern. These patterns do not activate or require the foreground;
only their pointer fallback does. Explicit `type_text.element_index` prefers
ValuePattern.SetValue (replaces that control's value without focus), otherwise
clicks that element and types under the usual guard. It requires fresh text indexes.
Pointer input checks
that the named window owns the point. Held physical modifiers cause refusal.

All state-changing input (Invoke, Toggle, Select, SetValue, pointer/keyboard,
targeted close) and explicit activation require **2000 ms (2 seconds)**
without Person input (`Activity.PersonQuietMilliseconds`). Recent input gives
`PersonActive` before activation or any global input batch. The helper reads
session `GetLastInputInfo`, stamps/tracks its own SendInput batches, and observes
keyboard/mouse hooks. Every helper SendInput carries the private random
per-process `Activity.OwnInputTag` in `dwExtraInfo`. ONLY that tag is excluded;
EVERY other event counts as the Person, including injected events from an
on-screen keyboard, remote control, remapper or UIA provider. Simultaneous Person
input is retained. Foreign hook events use receipt time because an injector can
supply an old/future event timestamp. Reading list/status/get_window_state remains allowed while
the Person is active; accessibility mutations return `PersonActive` too. Targeted Alt+F4 is an HWND message without activation, but still requires Person idle.
Activity observation failure refuses input; dispatched input cannot be recalled.

Activation restores minimized targets with nonblocking `ShowWindowAsync`, temporarily attaches the current thread to
foreground/target input queues and, for UWP frames, the focused client queue from
GetGUIThreadInfo. It calls BringWindowToTop/SetForegroundWindow and
always detaches. At most three attempts, each ordered by a bounded WM_NULL receipt;
final foreground root owner must equal the named HWND. No synthetic Alt/key taps.
An honest `ForegroundRefused` reports foreground class and process name, never
window title. The inspected reconstruction notes expose activation vocabulary but
do not document these native internals; this follows the round-three design and
[Microsoft's queue attachment contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput).
`--test-mode` also exposes `diagnostics`: Person age/event count, own injection
batch and own-hook counts, and foreground class/process. It captures no window text or image.

Typing uses the target keyboard layout where mapping needs at most Shift, otherwise
balanced Unicode packets. `TypingInterrupted.delivered` counts UTF-16 units whose
character keydown Windows accepted, even if only part of a batch was inserted.
It is not confirmation that the application interpreted those characters. A focus
change, stop, budget expiry or native failure never claims the entire text was
unsent; inspect state and never blindly retry. There is no clipboard use or retry.

`press_key` refuses anything containing a Windows key, Alt+Tab, Alt+Esc, Ctrl+Esc
(including Ctrl+Shift+Esc), and Ctrl+Alt+Del/Delete, including added modifiers.
**Alt+F4 is allowed because it closes the named window.** The exact two-key chord
posts SC_CLOSE to that validated HWND, avoiding a global focus race. An
out-of-context event observer pumps native receipts for at most 350 ms, returning
`closed` if the HWND disappeared or `closePending` otherwise. `dialogClass`
contains only the class of a visible root-owned popup, never title/text; it is
null when no native popup is observed (including some virtual WinUI dialogs).
A pending result does not authorize replaying close; observe the app and handle
its save prompt through fresh accessibility state. Other keys use guarded SendInput. See `input.cs`
for the closed key names. Scroll is Windows wheel units (120/notch): positive Y
is down, positive X right, each axis capped at ±2400.

Escape **anywhere**, including injected Escape from another process, stops an
active turn; only our private tagged events are excluded. Stop removes both
hooks, hides the notice seam, and latches `Stopped`. It queues
`{"event":"stopped","turn":"the-ended-id","cooldown_ms":5000}` without pipe I/O.
`Turn.StopCooldownMilliseconds` is **5000 ms**: `begin_turn` returns `PersonStopped`
throughout that cooldown even with a new id. A stopped id is permanently refused
for this helper process. After cooldown a newly authorized, new id may begin.
`end_turn` preserves the stop latch and cooldown. Every protected request and
`status`/`close` during Active/Stopped carries the same envelope `turn`; mismatch
gives `TurnMismatch`. Retrying an active id is idempotent. Turn ids must be
nonempty and at most 128 UTF-16 units.

Hooks install at `begin_turn` and are removed at `end_turn`/stop; Idle has none.
Before every mutation and on active `status`, tagged F24-key-up and same-position
mouse-move probes must reach and be consumed by both hooks. This detects
Windows' silent timeout removal, rather than trusting stale handles. Input
returns `HookUnavailable` on a missing receipt, and `status.hooksLive` is false.
If a hook is missing, those harmless probes can reach the application; they
neither type a character nor click. If the mouse hook is absent, the
probe can race a concurrent cursor move; live probes are consumed. Reads remain available for diagnosis.
Hook callbacks consume no Person events; Escape still reaches the application.
The hooks never wait on pipe writes. A dedicated stdout writer preserves line
order; stopped notification may wait behind a response if stdout is not drained.
Diagnostics use a 256-line queue (1024 characters each), a separate background
stderr writer, and drop on saturation. `status.diagnosticsDropped` counts drops;
no diagnostics are emitted from the activation code while input queues are attached.

Request lines cap at **1 MiB UTF-8** before decoding. Oversized lines are drained to
LF, refused as `LineTooLong`, and the process keeps serving. Responses exceeding
32 MiB UTF-8 return `ResponseTooLarge`, including the bounded outline and downscaled PNG.

Budgets cap at 10,000 ms (15,000 for launch). Zero refuses immediately (except cleanup `close`). Cooperative
expiry returns `RequestBudgetExhausted`, or `TypingInterrupted` for interrupted
text. A dedicated watchdog exits **70** when a request or response write exceeds its
budget, including native blocking and undrained stdout. Exit 70 means terminal
budget exhaustion with an uncertain input outcome; restart and observe, never replay.
A terminal `RequestBudgetExhausted` (or `TypingInterrupted`) reply is best-effort
only: it gets at most 100ms on a separate background thread, and blocked stdout or
a blocked turn lock cannot prevent exit. An already dispatched input may have happened. Never replay on restart.
Keep a separate desktop watchdog for broken pipes/backpressure and stop only the
child PID main spawned. Windows has no atomic foreground-check-and-inject API;
UIA/native calls may block and dispatched work cannot be recalled on stop.

## What Vivid cannot drive

`launch_app` refuses console-subsystem executables and known shell/terminal names
with `ShellRefused`; both shortcut targets and packaged AUMID manifest executables
are resolved and inspected as PE files. `list_apps` keeps refused entries with
`launchable:false,reason:"ShellRefused"`. Unreadable/unresolved targets fail closed
with `AppTargetUnverified`. All input methods (including activation and targeted
close) and every `get_window_state` capture (screenshots included) enforce the same policy again.

The named policy includes Command Prompt (`cmd.exe`), PowerShell (`powershell.exe`,
`pwsh.exe`), Windows Terminal (`WindowsTerminal.exe`, `wt.exe`), `conhost.exe`,
`OpenConsole.exe`, `wsl.exe`, `wslhost.exe`, Bash, Mintty/Git Bash, Ubuntu and other
known WSL distribution launchers, Alacritty, WezTerm, Hyper, Tabby, SSH and bare
Python/py/node REPLs. See `shells.cs` for the complete list/prefixes; all console
PE targets are refused regardless of name or arguments. GUI script/shell hosts
are refused by resolved image name too: powershell_ise, wscript, cscript, mshta,
rundll32, regsvr32, msiexec, regedit, mmc, control. Shortcut targets AND native-
parsed arguments are checked for those hosts and script extensions cmd/bat/ps1/
psm1/psd1/vbs/vbe/js/jse/wsf/wsh/hta/reg/msi/msp/msc (including taskschd.msc).
Nested .lnk targets/arguments are resolved read-only with an eight-link/cycle
bound; scripts/hosts give `ShellRefused`, unverifiable links fail closed. ALL `ConsoleWindowClass`
windows are refused, regardless of host/client ownership, so attached shell
clients cannot bypass the guard. Existing terminal windows need not be activated.
The Explorer `#32770` Run dialog is identified without its translated title: a
child `ComboBox` with shell resource control ID **12298** (`IDC_RUNDLG_EDITPATH`,
[resource definition](https://github.com/reactos/reactos/blob/master/dll/win32/shell32/shresdef.h)) is refused; File Explorer address
bars remain allowed. System chords, including Win+R, remain refused.

**Known limit:** editors with integrated terminals (VS Code and similar) are NOT
detected. Input can execute arbitrary commands through such an editor. The product
layer must still ask the Person before input. Name/PE checks are not a sandbox;
they do not prove what a GUI app, renamed GUI terminal or mutable launcher will do.

Inventory `source` is `machine` for All Users Start Menu and packaged apps, `person`
for the per-user Start Menu. Packaged provenance does not imply machine-wide install.
Any same-user process can write a per-user shortcut: it is NOT proof of an installed
or trusted app. The product layer must show this source. Corrupt/dangling shortcuts,
unreadable folders and package entries are skipped individually; `skipped` counts
entries/folders omitted, including unsupported shortcuts and directory reparse points.

## What the desktop app must do

- Ask the Person before the first turn and show its notice for the whole turn.
- Drain BOTH stdout and stderr continuously; serialize requests and validate replies.
- Never run the helper elevated; keep its private stdio away from renderer/network clients.
- Treat exit **70** as an unknown outcome: restart, observe, and never blindly replay input.
- Honour the stopped event immediately, cancel queued work, and tell the server at once.
- Require the Person's **Approval before input to ANY app**. File Explorer's address
  bar, Start search, an editor's integrated terminal, and saved scripts can execute
  commands; the helper cannot tell. Shell refusals do not remove this requirement.
- Keep **one turn per Run**; a new id is not permission to bypass a stop. End it on
  Run end, authority revocation, or connection loss; show inventory source provenance.

Known limits: integrated terminals and GUI apps executing saved scripts are NOT
detected. A renamed GUI host can evade the named list; image/PE checks are not a
sandbox, and mutable apps/shortcuts can race checks. Accessibility Invoke on a
Close/Delete-like control name gets NO special treatment. The product layer must
assess consequential actions and obtain Approval; labels are not a safety boundary.
Person activity and hook receipts cannot make foreground-check-and-SendInput
atomic or recall a dispatched native/provider action. UIA Name fetch allocation
is unbounded as described above; some save dialogs are virtual, so a pending
close may have no native dialog class. Windows silent hook loss is detected only
at the next self-test; an Escape during that gap cannot be recovered.

## Unsupported and unproved

No own notice window, renderer/server integration, `get_window`, drag,
secondary-action, Move/Wait adapters, arbitrary executable/URL launching,
multi-monitor pointer input, elevated/UAC/secure-desktop control, or stable identity
across helper restarts. Arbitrary app-provider Unicode interpretation is not
promised; read back observable text. Physical Escape, forced HWND recycling,
hung-provider kill and occluded screen-copy fallback need separate live proof.

The earlier inspected transport reference supplied request vocabulary, per-request
budgets and observation-before-input ordering. This helper adapts that mechanism
to installed Windows framework APIs; it is not binary-compatible with that client.
Native contracts: [activation](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication),
[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput),
[PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow).
