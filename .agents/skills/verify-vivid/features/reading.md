# Read reporting

Model requirement: none for the implemented journeys. Launch still requires provider keys and a real runtime model. Neither recipe sends a message or claims model behaviour.

## Behaviour and entry points

Opening a Thread reports its current standing as read. Revisiting a remembered standing does not send another `MarkThreadRead`. One client session remembers fifty Threads. Opening the fifty-first distinct Thread evicts the oldest; reopening the evicted Thread reports it again. A live update to a Thread left offscreen does not report it until the Person returns.

The shared policy is [seen.ts](../../../../packages/client/state/src/seen.ts). The web screen reads it in [Thread.tsx](../../../../apps/web/src/screen/Thread.tsx). The phone supplies its own live engine to the same policy. Desktop's web renderer uses the web path; native lifecycle behaviour needs its own run.

## Run the recipes

After Launch and Doctor on the unchanged commit, run both recipes with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature reading flue-<id>
.agents/skills/verify-vivid/verify browser reading flue-<id>
```

HTTP uses an empty Thread created through public `CreateThread`. It sends two real `MarkThreadRead` writes and checks through `GetThread` that neither moves the Thread or creates a Run. It establishes the repeated-write contract, not client suppression.

Browser starts on an empty Thread and creates 51 more through public `CreateThread`, each with an explicit title. CDP attaches to the owned tab and observes the real `/api/live` frames after one reload. Every subsequent move uses an actual sidebar link, preserving one ledger. Successful read receipts establish the first fifty visits. Returning to two remembered Threads must leave their request counts at one. Opening the fifty-first distinct Thread and returning to the oldest must produce its second successful read receipt.

For the background case, the browser leaves that oldest Thread for the fifty-second. Public `PatchThread` renames the offscreen Thread. The observer waits for the browser's actual `WatchThread` publication of the returned `updatedAt`, and the sidebar must show the new title. After rendering, its read count must remain unchanged. Returning through the sidebar must produce the next successful read receipt. This checks an offscreen metadata update, not a model reply or notification delivery.

`threads.json`, `rpc-traffic.json`, public RPC receipts, snapshots, and screenshots remain in `browser/reading/`. Traffic retains only read request names, Thread ids, receipt outcomes, and standings. It retains no auth headers or conversation bodies. `scope.json` records the omitted subcases. The recipe uses no direct SQL, transport replacement, fabricated response, or internal ledger inspection.

## Blocked subcases

- Failed-claim retry is blocked. It needs a genuine `MarkThreadRead` refusal while the same Thread remains readable, then recovery in the same client session. No public trigger for that state is configured. Intercepted responses would test a simulated failure.
- Offscreen model replies need a working real provider and an observable Run/publication. Renaming does not prove that case.
- Phone and desktop native entry points need runs on those clients. The web result does not prove mobile navigation, native suspend, or device restart.

Root owns Launch, Doctor, both recipe runs, Cleanup, and the independent review at the final head. Syntax and lint checks alone leave these journeys unverified.
