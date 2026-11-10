------------------------------- MODULE journal -------------------------------
(***************************************************************************)
(* The action journal (apps/server/src/actions/journal.ts): one act (one   *)
(* fingerprint in one Thread) sent by up to three operations.              *)
(*                                                                         *)
(*   c1, c2  two tool calls of the Run for the same act. Each is named by  *)
(*           its call id (operationOf.call), so a runtime retry after a    *)
(*           server restart reuses the same operation.                     *)
(*   ap      an Approval's operation (operationOf.approval), sent when the *)
(*           Person allows it (approvals/store.ts runJournaled).           *)
(*                                                                         *)
(* Whether a send is allowed at all is authority.tla's question; here      *)
(* every send is allowed, and the question is how often the act lands.    *)
(*                                                                         *)
(* Executor: a request that reached it may land (the act takes effect),   *)
(* be refused, pause for the Person, or still be running when Vivid's     *)
(* 90 second request timeout ends the wait (executor.ts responseReader).  *)
(* ExecutorContinues says whether Executor keeps running a request after  *)
(* Vivid stopped waiting. Not confirmed from Executor's source; the        *)
(* default is TRUE, the cautious reading.                                 *)
(*                                                                         *)
(* Lookup names what reconciliation can ask the provider                  *)
(* (connections/reconcile.ts look): "none" (every other tool), "mail"     *)
(* (Gmail send: can find, never proves absence), "calendar" (Calendar     *)
(* event insert: can prove absence of a settled operation).               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Lookup, ExecutorContinues, MaxCrashes

Ops     == {"c1", "c2", "ap"}
Calls   == {"c1", "c2"}
Defined == {"applied", "notapplied"}

VARIABLES
  pc,         \* [Ops -> step of the server process sending that operation]
  pending,    \* [Ops -> [op, back]]: the operation to reconcile first and the step to rerun
  rechecked,  \* [Ops -> TRUE once afterReconciliation already reran the attempt]
  row,        \* [Ops -> [st, rec, at]] the actions table; st "none" means no row
  clock,      \* claimedAt order
  inflight,   \* operations Executor is running
  paused,     \* operations Executor holds paused for the Person
  answer,     \* [Ops -> Executor's answer Vivid has not read yet]
  resuming,   \* operations whose pause a Person's answer is resuming
  crashes,
  \* ghosts
  landed,     \* sequence of [op, knew]: each time the act took effect
  knew        \* [Ops -> operations recorded as having taken effect when this one was sent]

vars == <<pc, pending, rechecked, row, clock, inflight, paused, answer, resuming, crashes,
          landed, knew>>

NoRow == [st |-> "none", rec |-> "unchecked", at |-> 0]
NoPending == [op |-> "none", back |-> "none"]

(* journal.ts `unresolved`: being sent or settled Unknown, and not reconciled either way. *)
Unresolved(o) == row[o].st \in {"dispatching", "unknown"} /\ row[o].rec \notin Defined

(* Recorded as having taken effect: a Completed or Accepted receipt, or reconciled Applied. *)
KnownDone == {o \in Ops : row[o].st \in {"completed", "accepted"} \/ row[o].rec = "applied"}

LandedOps == {landed[i].op : i \in DOMAIN landed}

(* journal.ts answerFor, read inside one transaction. *)
Reconciled == {o \in Ops : row[o].st # "none" /\ row[o].rec \in Defined}
Newest == CHOOSE o \in Reconciled : \A p \in Reconciled : row[p].at <= row[o].at
AnswerFor(o) ==
  IF row[o].st # "none" THEN [d |-> "Answered", op |-> o]
  ELSE IF \E p \in Ops : Unresolved(p)
    THEN [d |-> "Reconcile", op |-> CHOOSE p \in Ops : Unresolved(p)]
  ELSE IF Reconciled # {} /\ row[Newest].rec = "applied" THEN [d |-> "Answered", op |-> Newest]
  ELSE [d |-> "Fresh", op |-> o]

Init ==
  /\ pc = [o \in Ops |-> "idle"]
  /\ pending = [o \in Ops |-> NoPending]
  /\ rechecked = [o \in Ops |-> FALSE]
  /\ row = [o \in Ops |-> NoRow]
  /\ clock = 0
  /\ inflight = {}
  /\ paused = {}
  /\ answer = [o \in Ops |-> "none"]
  /\ resuming = {}
  /\ crashes = 0
  /\ landed = <<>>
  /\ knew = [o \in Ops |-> {}]

(* The Run makes call o (tools.ts useToolAs); the Person allows the Approval (store.ts decide). *)
Start(o) ==
  /\ pc[o] = "idle"
  /\ pc' = [pc EXCEPT ![o] = IF o \in Calls THEN "before" ELSE "claim"]
  /\ rechecked' = [rechecked EXCEPT ![o] = FALSE]
  /\ UNCHANGED <<pending, row, clock, inflight, paused, answer, resuming, crashes, landed, knew>>

(* A refused or answered attempt ends; ReconciliationRequired goes to the provider lookup,
   and afterReconciliation reruns the step that asked (`back`) once. *)
Route(o, found, onFresh) ==
  CASE found.d = "Answered" ->
         /\ pc' = [pc EXCEPT ![o] = "done"] /\ UNCHANGED <<pending, row, clock>>
    [] found.d = "Reconcile" /\ rechecked[o] ->      \* afterReconciliation reruns only once
         /\ pc' = [pc EXCEPT ![o] = "done"] /\ UNCHANGED <<pending, row, clock>>
    [] found.d = "Reconcile" ->
         /\ pc' = [pc EXCEPT ![o] = "reconcile"]
         /\ pending' = [pending EXCEPT ![o] = [op |-> found.op, back |-> pc[o]]]
         /\ UNCHANGED <<row, clock>>
    [] found.d = "Fresh" -> onFresh

(* journal.ts answerBefore: answerFor before the Gate, no lock, nothing written. *)
Before(o) ==
  /\ pc[o] = "before"
  /\ Route(o, AnswerFor(o),
           /\ pc' = [pc EXCEPT ![o] = "claim"] /\ UNCHANGED <<pending, row, clock>>)
  \* claim wraps its own afterReconciliation, so it may reconcile once more
  /\ rechecked' = [rechecked EXCEPT ![o] = FALSE]
  /\ UNCHANGED <<inflight, paused, answer, resuming, crashes, landed, knew>>

(* journal.ts claim: under the act's advisory lock, answerFor again, then insert the row. *)
Claim(o) ==
  /\ pc[o] = "claim"
  /\ Route(o, AnswerFor(o),
           /\ row' = [row EXCEPT ![o] = [st |-> "dispatching", rec |-> "unchecked", at |-> clock + 1]]
           /\ clock' = clock + 1
           /\ pc' = [pc EXCEPT ![o] = "send"]
           /\ UNCHANGED pending)
  /\ UNCHANGED <<rechecked, inflight, paused, answer, resuming, crashes, landed, knew>>

(***************************************************************************)
(* journal.ts reconcile (reached through afterReconciliation): a definite  *)
(* earlier answer stands; otherwise the read-only provider lookup          *)
(* (reconcile.ts look) decides, written only if still undecided. Then the  *)
(* original attempt reruns once.                                           *)
(***************************************************************************)
LookupSays(p) ==
  IF Lookup = "none" THEN "inconclusive"
  ELSE IF p \in LandedOps THEN "applied"                                   \* Found
  ELSE IF Lookup = "calendar" /\ row[p].st # "dispatching" THEN "notapplied" \* Absent
  ELSE "inconclusive"                                                      \* Unsupported

Reconcile(o) ==
  /\ pc[o] = "reconcile"
  /\ LET p == pending[o].op
         said == IF row[p].st \in {"completed", "accepted"} THEN "applied"
                 ELSE IF row[p].rec \in Defined THEN row[p].rec
                 ELSE LookupSays(p)
     IN /\ row' = IF row[p].st # "none" /\ row[p].rec \notin Defined /\ said # "inconclusive"
                    THEN [row EXCEPT ![p].rec = said]
                    ELSE row
        \* Inconclusive keeps the original refusal; a definite answer reruns the step once
        /\ pc' = [pc EXCEPT ![o] = IF said \in Defined THEN pending[o].back ELSE "done"]
  /\ rechecked' = [rechecked EXCEPT ![o] = TRUE]
  /\ pending' = [pending EXCEPT ![o] = NoPending]
  /\ UNCHANGED <<clock, inflight, paused, answer, resuming, crashes, landed, knew>>

(* tools.ts runConnection / sendJournaled: the request reaches Executor. *)
Send(o) ==
  /\ pc[o] = "send"
  /\ inflight' = inflight \cup {o}
  /\ knew' = [knew EXCEPT ![o] = KnownDone]
  /\ pc' = [pc EXCEPT ![o] = "wait"]
  /\ UNCHANGED <<pending, rechecked, row, clock, paused, answer, resuming, crashes, landed>>

(* Executor runs a request: the act takes effect, it is refused, or it pauses for the Person. *)
Execute(o) ==
  /\ o \in inflight
  /\ inflight' = inflight \ {o}
  /\ \E r \in {"applied", "refused", "paused"} :
       /\ answer' = [answer EXCEPT ![o] = r]
       /\ landed' = IF r = "applied" THEN Append(landed, [op |-> o, knew |-> knew[o]]) ELSE landed
       /\ paused' = IF r = "paused" THEN paused \cup {o} ELSE paused
  /\ UNCHANGED <<pc, pending, rechecked, row, clock, resuming, crashes, knew>>

(* The waiting server process reads Executor's answer and writes the receipt
   (tools.ts settleCall, store.ts runJournaled, asks.ts record). A pause leaves the row
   being sent: its ask holds it. *)
Read(o) ==
  /\ pc[o] = "wait" \/ o \in resuming
  /\ answer[o] # "none"
  \* settle and release write only while the row has no receipt (receipt is null)
  /\ row' = CASE answer[o] = "applied" /\ row[o].st = "dispatching" -> [row EXCEPT ![o].st = "completed"]
              [] answer[o] = "refused" /\ row[o].st = "dispatching" -> [row EXCEPT ![o] = NoRow]
              [] OTHER -> row
  /\ answer' = [answer EXCEPT ![o] = "none"]
  /\ pc' = [pc EXCEPT ![o] = IF pc[o] = "wait" THEN "done" ELSE pc[o]]
  /\ resuming' = resuming \ {o}
  /\ UNCHANGED <<pending, rechecked, clock, inflight, paused, crashes, landed, knew>>

(* executor.ts responseReader: after 90 seconds the wait ends with ExecutorTransportFailure,
   read as OutcomeUnknown and settled Unknown. Executor may still be running the request. *)
Timeout(o) ==
  /\ pc[o] = "wait" \/ o \in resuming
  /\ o \in inflight
  /\ row' = [row EXCEPT ![o].st = IF @ = "dispatching" THEN "unknown" ELSE @]   \* settle
  /\ inflight' = IF ExecutorContinues THEN inflight ELSE inflight \ {o}
  /\ pc' = [pc EXCEPT ![o] = IF pc[o] = "wait" THEN "done" ELSE pc[o]]
  /\ resuming' = resuming \ {o}
  /\ UNCHANGED <<pending, rechecked, clock, paused, answer, crashes, landed, knew>>

(* The Person (or Jev's review) accepts the held pause: asks.ts answer -> makeResume. *)
Resume(o) ==
  /\ o \in paused
  /\ paused' = paused \ {o}
  /\ inflight' = inflight \cup {o}
  /\ resuming' = resuming \cup {o}
  /\ UNCHANGED <<pc, pending, rechecked, row, clock, answer, crashes, landed, knew>>

(* The pause runs out (asks.ts record Expired, settled Unknown); makeResume never sends it. *)
PauseExpires(o) ==
  /\ o \in paused
  /\ paused' = paused \ {o}
  /\ row' = [row EXCEPT ![o].st = IF @ = "dispatching" THEN "unknown" ELSE @]
  /\ UNCHANGED <<pc, pending, rechecked, clock, inflight, answer, resuming, crashes, landed, knew>>

(* The server restarts. Every server process stops where it is; rows stay as written.
   The runtime retries its tool calls under the same call ids; an executing Approval is never
   re-run (store.ts expire marks it unknown). Executor keeps what it holds. *)
Crash ==
  /\ crashes < MaxCrashes
  /\ \E o \in Ops : pc[o] \notin {"idle", "done"} \/ o \in resuming
  /\ crashes' = crashes + 1
  /\ pc' = [o \in Ops |-> CASE pc[o] \in {"idle", "done"} -> pc[o]
                            [] o \in Calls -> "idle"
                            [] OTHER -> "done"]
  /\ resuming' = {}
  /\ answer' = [o \in Ops |-> "none"]
  /\ pending' = [o \in Ops |-> NoPending]
  /\ UNCHANGED <<rechecked, row, clock, inflight, paused, landed, knew>>

Next ==
  \/ \E o \in Ops : Start(o) \/ Before(o) \/ Claim(o) \/ Reconcile(o) \/ Send(o)
                    \/ Execute(o) \/ Read(o) \/ Timeout(o) \/ Resume(o) \/ PauseExpires(o)
  \/ Crash

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ \A o \in Ops : row[o].st \in {"none", "dispatching", "completed", "accepted", "unknown"}
  /\ \A o \in Ops : row[o].rec \in {"unchecked", "applied", "notapplied", "inconclusive"}

(* Reconciliation never records NotApplied for an operation that took effect, before or after. *)
NotAppliedIsTrue == \A o \in Ops : row[o].rec = "notapplied" => o \notin LandedOps

(* The act never takes effect twice unless the first time was recorded before the second
   send: no retry, restart, second call or Approval sends it blind. *)
NoBlindSecondSend ==
  \A i, j \in DOMAIN landed : i < j => landed[i].op \in landed[j].knew
=============================================================================
