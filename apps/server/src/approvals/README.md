# Approvals

Authorization for one consequential action: the exact action Vivid proposed, its risk, the
rationale, the scope and the decision. This domain is the trust loop's record and its machinery.

- `gate.ts` decides what happens to one thing Vivid wants to do: allowed now, an Approval raised
  in the Thread for the acting Person, or blocked by a rule (in the rule's own wording).
- `action.ts` binds an Approval to the whole encoded action, so what runs later is exactly what
  was shown.
- `store.ts` and `tables.ts` hold one row per Approval. Each stored status declares its exact
  columns; an inconsistent row fails when it is read.
- `runner.ts` performs an approved action by handing it to the domain that owns its target
  (Connections, the Computer). That domain checks again, at the moment of running, that the Person
  may still do it: an Approval does not outlive a removed Connection or a lost Membership.
- `replay.ts` and `sweeper.ts` finish what a dead process left owed: rows are claimed under a
  lease, admitted outside the transaction, and fenced against stale writes.
- `signal.ts` tracks delivery of the outcome to the Thread separately from the decision.

Defined by `docs/22-one-product.md` (the trust loop). Rules that pre-decide actions live in
`rules/`; the audit line for each decision is written through `audit/`.
