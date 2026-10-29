# An ask that changed

Model requirement: real model. Rehearsal cannot prove this journey.

Run `verify feature changed <run>` and `verify browser changed <run>` after Launch and worthy Doctor on the same unchanged head. Cleanup follows.

The recipe connects the disposable Verify Pulse Integration and creates a personal Ask rule through public RPC. It asks the real model to write a document, then to emit a pulse whose words are that document, named with `{"$document": title}` in `use_tool` input. The first completed Run must leave one Pending Approval whose stored input carries the document's text and whose binding names version 1.

The Person then revises the document through the public ReviseArtifact RPC with their own session. No client has a document editor yet, so this is the product's only edit path. Allow on the old ask, with its id and digest, must be refused with ApprovalChanged, and a quiesced Executor export must show no matching event. The stale outcome wakes Vivid through the approval sweeper. The second completed Run must leave the old Approval Invalidated with ContentChanged at version 2, and one fresh Pending Approval carrying the revised text.

HTTP allows the fresh ask through DecideApproval. Browser checks that the old card reads "The document changed after this was asked.", that the fresh ask is up over the composer, and presses **Allow** on it. Both require the fresh Approval Succeeded, a third completed Run, and exactly one provider event. Browser reloads and checks the stale line again. The owned rule and Connection are removed, including after failure.

Evidence stays in `changed/` and `browser/changed/`. It includes the first and fresh asks, the refused decision, provider exports before and after, and the verdict. Browser also retains commands, snapshots and screenshots.

Integration re-authorization, a stopped Run and Membership loss are proved by database-backed tests (`apps/server/src/approvals/stale.test.ts`), not here. Native clients remain unproved.
