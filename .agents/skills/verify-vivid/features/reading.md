# Read reporting

Model requirement: HTTP sends no message. Browser requires a real provider and refuses rehearsal. It sends one short Person message to a disposable Thread through the shipped public gateway and waits for a real reply and completed Run.

## Behaviour and entry points

Opening a Thread reports its current standing as read. Revisiting a remembered standing does not send another `MarkThreadRead`. One client session remembers fifty Threads. Opening the fifty-first distinct Thread evicts the oldest; reopening the evicted Thread reports it again. Renaming leaves its standing unchanged, including on return. A real reply advances an offscreen Thread's standing, which is reported only when the Person returns.

The shared policy is [seen.ts](../../../../packages/client/state/src/seen.ts). The web screen reads it in [Thread.tsx](../../../../apps/web/src/screen/Thread.tsx). The phone supplies its own live engine to the same policy. Desktop's web renderer uses the web path; native lifecycle behaviour needs its own run.

## Run the recipes

After Launch and Doctor on the unchanged commit, run both recipes with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature reading flue-<id>
.agents/skills/verify-vivid/verify browser reading flue-<id>
```

HTTP uses an empty Thread created through public `CreateThread`. It sends two real `MarkThreadRead` writes and checks through `GetThread` that neither moves the Thread or creates a Run. It establishes the repeated-write contract, not client suppression.

Browser starts on an empty Thread and creates 51 more through public `CreateThread`, each with an explicit title. CDP attaches to the owned tab and observes the real `/api/live` frames after one reload. Every subsequent move uses an actual sidebar link, preserving one ledger. Successful read receipts establish the first fifty visits. Returning to two remembered Threads must leave their request counts at one. Opening the fifty-first distinct Thread and returning to the oldest must produce its second successful read receipt.

For the metadata case, the browser leaves that oldest Thread for the fifty-second. Public `PatchThread` renames the offscreen Thread without changing `updatedAt`. The observer requires a subsequent browser `WatchThread` publication with the renamed title and unchanged standing. An earlier publication of that standing cannot satisfy the receipt. The sidebar must show the new title. After rendering and again after sidebar return, its read count must remain unchanged.

The browser leaves for the fifty-second Thread again. The public `chat` helper submits one short message using the disposable Person's authority and reads the real model reply. Public `WatchThread` must report one additional completed Run and a newer `updatedAt`. The browser's own `WatchThread` must receive that standing while another Thread is on screen. Its read count must remain unchanged through settlement and rendering. Returning through the actual sidebar must produce exactly one additional successful `MarkThreadRead` receipt and request.

`threads.json`, `rpc-traffic.json`, public RPC receipts, model submission/stream evidence, `settlement.json`, snapshots, and screenshots remain in `browser/reading/`. Traffic retains only read/watch request names, Thread ids, synthetic titles, receipt outcomes, and standings. It retains no auth headers or conversation bodies. `scope.json` records the model and omitted subcases. The recipe uses no direct SQL, transport replacement, fabricated response, or internal ledger inspection. Notification delivery is outside this recipe.

## Blocked subcases

- Failed-claim retry is blocked. It needs a genuine `MarkThreadRead` refusal while the same Thread remains readable, then recovery in the same client session. No public trigger for that state is configured. Intercepted responses would test a simulated failure.
- Phone and desktop native entry points need runs on those clients. The web result does not prove mobile navigation, native suspend, or device restart.

Root owns Launch, Doctor, both recipe runs, Cleanup, and the independent review at the final head. Syntax and lint checks alone leave these journeys unverified.
