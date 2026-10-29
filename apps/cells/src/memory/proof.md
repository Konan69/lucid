# Cross-Person memory on native cells

Run on the verify-vivid disposable devbox stack, never a shared fleet. This recipe proves
native RPC. The file-backed runtime fixture cannot prove DurableObject RPC admission.
Use the stack's private runtime token without printing or retaining it in evidence.

1. Launch and Doctor at the combined head using verify-vivid. Require `worthy: true`.
2. Choose fresh Person IDs A and B and Thread IDs T and U. Send authenticated runtime
   `POST /persons/A/threads/T` with `initialData.creator=A`, `scope.acting=B`, a unique
   idempotency key and a signal attributed to B. Ask Vivid to remember that B's meeting
   preference is before noon because afternoons are for writing.
3. Await the returned submission through the native terminal endpoint. Require `Done`.
   Read T's state. Require a successful `write_memory` receipt and retain its layer and file.
4. Send a second signal in T acting for B. Ask when B prefers meetings and why.
   Await `Done`. Require `read_memory` for the recorded address, its body containing the
   preference and `source` naming B's first ThreadRun. Require the reply to say before noon.
   A reply without the read receipt does not prove cross-cell reads.
5. Open U in B's cell and ask the same question. Require the saved preference in the prompt
   or a successful `read_memory` receipt. Open a fresh Thread in A's cell acting for A.
   Require its memory index to omit B's address. These observations establish B owns the entry.
6. Retain request bodies without authorization headers, submission receipts, public states
   and native cell ownership receipts for A and B. Run Cleanup and retain its audit.

A native RPC refusal, missing tool receipt, provider failure or unavailable launcher blocks
this proof. A build receipt, a scripted answer or an in-process stub is not a pass.
