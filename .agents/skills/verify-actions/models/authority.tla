------------------------------ MODULE authority ------------------------------
(***************************************************************************)
(* Who lets one Integration act reach the provider.                        *)
(*                                                                         *)
(* One Thread, one Integration, one act Vivid proposes once, and the one   *)
(* Executor operation that act becomes. Every action below names the code  *)
(* it stands for (apps/server/src/...). One action is one step the code    *)
(* takes atomically: one SQL statement or transaction, or one Executor     *)
(* request whose answer it waits for.                                      *)
(*                                                                         *)
(* Fixed per behaviour (chosen in Init, so one run covers every mix):      *)
(*   effect      the tool's effect label (read, write, destructive)        *)
(*   applicable  the rules the rule judge found applicable                 *)
(*   uncertain   the rule judge failed on a scope with a restricting rule  *)
(*   background  the Thread is a Background Thread (unwatched work)        *)
(* Chosen per Gate call: Jev's review (Run, Ask, or no review at all).     *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS Devices,    \* the Person's devices answering the same Approval at once
          MaxPauses   \* how many times Executor may pause the one operation

Effects  == {"read", "write", "destructive"}
Reviews  == {"Run", "Ask", "Unreviewed"}
Asks     == {"own", "held"}     \* own: Vivid's Approval; held: an Integration's held pause
PersonOk == {"Reviewed", "PersonApproved", "PersonPress"}

VARIABLES
  effect, applicable, uncertain, background,
  call,         \* Vivid's tool call: "idle" -> "done"
  flow,         \* the request in flight on the operation: [pc, basis]
  opBasis,      \* the authority the operation was last sent under
  exec,         \* Executor's state of the operation
  pauses,       \* pauses Executor has raised for the operation
  askedApproval,\* Executor asked for approval at least once (consequence evidence)
  pauseExpired, \* the current pause is past its expiresAt
  appr,         \* [Asks -> status]
  ownExpired,   \* Vivid's own Approval is past its 24 hour expiresAt
  dev,          \* [Devices -> [pc, ask, choice]]
  owed,         \* [Asks -> "none" | "allow" | "deny"] work owed by the winning decision
  inp,          \* the Integration's Input request status
  inpAnswer,    \* the claimed answer: "none" | "accept" | "decline"
  inpCancelled, \* cancelWithdrawn already answered the withdrawn question
  \* ghosts, read only by the invariants
  took,         \* every time the act took effect: [basis, consequential]
  moves,        \* [Asks -> number of decisions that won the claim]
  declined,     \* a Person's decline won a claim
  late,         \* a resume reached Executor after its pause expired, or an Approval ran after expiry
  withdrawnAt,  \* the current Input request was withdrawn at some point
  withdrawnAccept

vars == <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
          askedApproval, pauseExpired, appr, ownExpired, dev, owed, inp, inpAnswer,
          inpCancelled, took, moves, declined, late, withdrawnAt, withdrawnAccept>>

None == [pc |-> "none", basis |-> "none"]

(***************************************************************************)
(* approvals/gate.ts gateLayer Gate.check, with approvals/policy.ts        *)
(* reviewOutcome and unwatchedOutcome. Connection targets are always       *)
(* `reviewable`. Returns [d, b]: Allowed with basis b, Ask, or Blocked.    *)
(***************************************************************************)
Gate(eff, rev) ==
  IF eff = "read" THEN [d |-> "Allow", b |-> "Read"]                      \* Gate.before
  ELSE IF "Never" \in applicable THEN [d |-> "Blocked", b |-> "none"]     \* never rule
  ELSE IF "Ask" \in applicable \/ uncertain THEN [d |-> "Ask", b |-> "none"]
  ELSE IF background                                                      \* checkUnwatched
    THEN IF rev = "Run" THEN [d |-> "Allow", b |-> "Reviewed"] ELSE [d |-> "Ask", b |-> "none"]
  ELSE IF eff # "destructive" /\ "Allow" \in applicable
    THEN [d |-> "Allow", b |-> "AllowRule"]
  ELSE IF rev = "Run" THEN [d |-> "Allow", b |-> "Reviewed"]              \* reviewOutcome
  ELSE IF rev = "Ask" THEN [d |-> "Ask", b |-> "none"]
  ELSE IF eff = "destructive" THEN [d |-> "Ask", b |-> "none"]            \* unreviewed destructive asks
  ELSE [d |-> "Allow", b |-> "Unreviewed"]                                \* 4 Oct 2026: unreviewed write runs

(* Executor's possible answers to one request that reached it. *)
Outcomes == IF pauses < MaxPauses
              THEN {"applied", "approvalPause", "inputPause", "refused"}
              ELSE {"applied", "refused"}

(* A new Integration Approval for the held pause (asks.ts pause -> ApprovalStore.raise).
   A new pause has a new digest, so it is a new Approval with its own decision count. *)
RaiseHeld ==
  /\ appr' = [appr EXCEPT !.held = "pending"]
  /\ moves' = [moves EXCEPT !.held = 0]

(***************************************************************************)
(* Executor answered request with basis b. The ghost `took` records every *)
(* time the act took effect and the authority it carried; it is           *)
(* consequential when the tool is destructive or Executor asked for       *)
(* approval (asks.ts approve: "approval metadata is consequence evidence"). *)
(* `next` is what the same request does with the answer.                    *)
(***************************************************************************)
Land(o, b, next) ==
  /\ exec' = o
  /\ opBasis' = b
  /\ pauses' = IF o \in {"approvalPause", "inputPause"} THEN pauses + 1 ELSE pauses
  /\ askedApproval' = (askedApproval \/ o = "approvalPause")
  /\ pauseExpired' = IF o \in {"approvalPause", "inputPause"} THEN FALSE ELSE pauseExpired
  /\ took' = IF o = "applied"
               THEN Append(took, [basis |-> b, consequential |-> effect = "destructive" \/ askedApproval])
               ELSE took
  \* tools.ts resolveApproval -> asks.ts approve; tools.ts pauseConnection -> InputStore.askIntegration
  /\ flow' = IF o = "approvalPause" THEN [pc |-> "resolve", basis |-> next] ELSE None

(* tools.ts pauseConnection -> InputStore.askIntegration: an input pause is a new question. *)
NewQuestion ==
  /\ inp' = "waiting" /\ inpAnswer' = "none" /\ inpCancelled' = FALSE /\ withdrawnAt' = FALSE

(* Executor answered a request that did not come from the Input request. *)
LandOutside(o, b, next) ==
  /\ Land(o, b, next)
  /\ IF o = "inputPause" THEN NewQuestion ELSE UNCHANGED <<inp, inpAnswer, inpCancelled, withdrawnAt>>

Init ==
  /\ effect \in Effects
  /\ applicable \in SUBSET {"Never", "Ask", "Allow"}
  /\ uncertain \in BOOLEAN
  /\ background \in BOOLEAN
  /\ call = "idle"
  /\ flow = None
  /\ opBasis = "none"
  /\ exec = "none"
  /\ pauses = 0
  /\ askedApproval = FALSE
  /\ pauseExpired = FALSE
  /\ appr = [a \in Asks |-> "none"]
  /\ ownExpired = FALSE
  /\ dev = [d \in Devices |-> [pc |-> "idle", ask |-> "none", choice |-> "none"]]
  /\ owed = [a \in Asks |-> "none"]
  /\ inp = "none" /\ inpAnswer = "none" /\ inpCancelled = FALSE
  /\ took = <<>>
  /\ moves = [a \in Asks |-> 0]
  /\ declined = FALSE
  /\ late = FALSE
  /\ withdrawnAt = FALSE
  /\ withdrawnAccept = FALSE

(* connections/tools.ts useToolAs: Gate.check, then ApprovalRequired raises Vivid's own
   Approval (gate.ts ask -> store.ts raise), Blocked ends, Allowed dispatches. *)
Propose ==
  /\ call = "idle"
  /\ \E rev \in Reviews :
       LET g == Gate(effect, rev) IN
       /\ call' = "done"
       /\ CASE g.d = "Blocked" -> UNCHANGED <<appr, flow>>
            [] g.d = "Ask"     -> /\ appr' = [appr EXCEPT !.own = "pending"] /\ UNCHANGED flow
            [] g.d = "Allow"   -> /\ flow' = [pc |-> "dispatch", basis |-> g.b] /\ UNCHANGED appr
  /\ UNCHANGED <<effect, applicable, uncertain, background, opBasis, exec, pauses, askedApproval,
                 pauseExpired, ownExpired, dev, owed, inp, inpAnswer, inpCancelled, took, moves,
                 declined, late, withdrawnAt, withdrawnAccept>>

(* connections/tools.ts runConnection -> executor.ts call: the request reaches Executor. *)
Dispatch ==
  /\ flow.pc = "dispatch"
  /\ \E o \in Outcomes : LandOutside(o, flow.basis, flow.basis)
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, appr, ownExpired, dev, owed,
                 moves, declined, late, withdrawnAccept>>

(***************************************************************************)
(* connections/asks.ts approve: Executor asked for approval.               *)
(*  Unreviewed               -> the Person decides (pause raises the held  *)
(*                              Approval).                                 *)
(*  Read, AllowRule, Contained -> Gate.check again as destructive; only a  *)
(*                              Reviewed allow resumes, Blocked declines.  *)
(*  Reviewed, PersonApproved, PersonPress -> resumeApproved.               *)
(***************************************************************************)
Resolve ==
  /\ flow.pc = "resolve"
  /\ LET b == flow.basis IN
     CASE b = "Unreviewed" ->
            /\ RaiseHeld /\ flow' = None /\ UNCHANGED exec
       [] b \in {"Read", "AllowRule", "Contained"} ->
            \E rev \in Reviews :
              LET g == Gate("destructive", rev) IN
              (CASE g.d = "Allow" /\ g.b = "Reviewed" ->
                      /\ flow' = [pc |-> "accept", basis |-> "Reviewed"]
                      /\ UNCHANGED <<appr, moves, exec>>
                 [] g.d = "Allow" \/ g.d = "Ask" ->
                      /\ RaiseHeld /\ flow' = None /\ UNCHANGED exec
                 [] g.d = "Blocked" ->      \* declineBlocked: resume with decline
                      /\ exec' = "refused" /\ flow' = None /\ UNCHANGED <<appr, moves>>)
       [] OTHER ->
            /\ flow' = [pc |-> "accept", basis |-> b] /\ UNCHANGED <<appr, moves, exec>>
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, opBasis, pauses, askedApproval,
                 pauseExpired, ownExpired, dev, owed, inp, inpAnswer, inpCancelled, took,
                 declined, late, withdrawnAt, withdrawnAccept>>

(* connections/asks.ts resumeApproved -> executor.ts makeResume, accept. makeResume answers
   Expired without sending once pause.expiresAt has passed. A further approval pause loops
   with the same basis (resumeApproved's while loop). *)
Accept ==
  /\ flow.pc = "accept"
  /\ exec = "approvalPause"
  /\ IF pauseExpired
       THEN /\ exec' = "expired" /\ flow' = None
            /\ UNCHANGED <<opBasis, pauses, askedApproval, pauseExpired, took, inp, inpAnswer,
                           inpCancelled, withdrawnAt, late>>
       ELSE /\ late' = (late \/ pauseExpired)
            /\ \E o \in Outcomes : LandOutside(o, flow.basis, flow.basis)
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, appr, ownExpired, dev, owed,
                 moves, declined, withdrawnAccept>>

(* The clock passes an Executor pause's expiresAt. *)
PauseDeadline ==
  /\ exec \in {"approvalPause", "inputPause"}
  /\ ~pauseExpired
  /\ pauseExpired' = TRUE
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, appr, ownExpired, dev, owed, inp, inpAnswer, inpCancelled, took,
                 moves, declined, late, withdrawnAt, withdrawnAccept>>

(* The clock passes Vivid's own Approval's expiresAt (store.ts raise: 24 hours). *)
OwnDeadline ==
  /\ appr.own = "pending"
  /\ ~ownExpired
  /\ ownExpired' = TRUE
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, dev, owed, inp, inpAnswer, inpCancelled, took,
                 moves, declined, late, withdrawnAt, withdrawnAccept>>

(***************************************************************************)
(* approvals/store.ts claim, first half: read the row, requireUnexpired    *)
(* (a held pause skips Vivid's deadline), requireDecisionAuthority. The    *)
(* Person presses Allow or Decline on device d.                            *)
(***************************************************************************)
DeviceReads(d) ==
  /\ dev[d].pc = "idle"
  /\ \E a \in Asks, c \in {"allow", "deny"} :
       /\ appr[a] = "pending"
       /\ dev' = [dev EXCEPT ![d] =
                    IF a = "own" /\ ownExpired
                      THEN [pc |-> "done", ask |-> a, choice |-> c]     \* ApprovalExpired
                      ELSE [pc |-> "read", ask |-> a, choice |-> c]]
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, owed, inp, inpAnswer,
                 inpCancelled, took, moves, declined, late, withdrawnAt, withdrawnAccept>>

(* approvals/store.ts move: one conditional UPDATE out of pending. Vivid's own Approval also
   requires expiresAt > now; a held pause does not. The loser answers ApprovalDecided. *)
ClaimGuard(a) == appr[a] = "pending" /\ (a = "held" \/ ~ownExpired)

DeviceClaims(d) ==
  /\ dev[d].pc = "read"
  /\ LET a == dev[d].ask
         c == dev[d].choice IN
     IF ClaimGuard(a)
       THEN /\ appr' = [appr EXCEPT ![a] = IF c = "allow" THEN "executing" ELSE "denied"]
            /\ moves' = [moves EXCEPT ![a] = @ + 1]
            /\ owed' = [owed EXCEPT ![a] = c]
            /\ declined' = (declined \/ c = "deny")
            /\ late' = (late \/ (a = "own" /\ c = "allow" /\ ownExpired))
       ELSE UNCHANGED <<appr, moves, owed, declined, late>>
  /\ dev' = [dev EXCEPT ![d].pc = "done"]
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, ownExpired, inp, inpAnswer, inpCancelled, took,
                 withdrawnAt, withdrawnAccept>>

(* approvals/store.ts decide -> runJournaled -> approvals/runner.ts -> tools.ts
   connectionRunner: the stored action runs under PersonApproved. A decline sends nothing. *)
RunOwn ==
  /\ owed.own # "none"
  /\ owed' = [owed EXCEPT !.own = "none"]
  /\ IF owed.own = "allow"
       THEN flow' = [pc |-> "dispatch", basis |-> "PersonApproved"]
       ELSE UNCHANGED flow
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, dev, inp, inpAnswer, inpCancelled,
                 took, moves, declined, late, withdrawnAt, withdrawnAccept>>

(* approvals/store.ts answerPausedApproval -> asks.ts answer -> executor.ts makeResume with
   the Person's accept or decline. A later approval pause continues as PersonApproved. *)
AnswerHeld ==
  /\ owed.held # "none"
  /\ exec = "approvalPause"
  /\ owed' = [owed EXCEPT !.held = "none"]
  /\ appr' = [appr EXCEPT !.held = IF @ = "executing" THEN "done" ELSE @]   \* finishIntegration
  /\ IF pauseExpired
       THEN /\ exec' = "expired" /\ flow' = None
            /\ UNCHANGED <<opBasis, pauses, askedApproval, pauseExpired, took, inp, inpAnswer,
                           inpCancelled, withdrawnAt, late>>
       ELSE IF owed.held = "deny"
         THEN /\ exec' = "refused" /\ flow' = None
              /\ UNCHANGED <<opBasis, pauses, askedApproval, pauseExpired, took, inp, inpAnswer,
                             inpCancelled, withdrawnAt, late>>
         ELSE /\ late' = (late \/ pauseExpired)
              /\ \E o \in Outcomes : LandOutside(o, "PersonApproved", "PersonApproved")
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, ownExpired, dev, moves,
                 declined, withdrawnAccept>>

(* approvals/store.ts expire: pending rows past expiresAt become expired. A held pause's
   expiresAt is the pause's own; its journal settles through IntegrationAnswers.settle. *)
ExpireApproval ==
  /\ \E a \in Asks :
       /\ appr[a] = "pending"
       /\ IF a = "own" THEN ownExpired ELSE pauseExpired
       /\ appr' = [appr EXCEPT ![a] = "expired"]
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, ownExpired, dev, owed, inp, inpAnswer,
                 inpCancelled, took, moves, declined, late, withdrawnAt, withdrawnAccept>>

(* inputs/store.ts answerIntegration: claim waiting -> answering with one conditional UPDATE. *)
InputClaim ==
  /\ inp = "waiting"
  /\ inpAnswer = "none"
  /\ \E r \in {"accept", "decline"} :
       /\ inp' = "answering"
       /\ inpAnswer' = r
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, dev, owed, inpCancelled, took,
                 moves, declined, late, withdrawnAt, withdrawnAccept>>

(* inputs/store.ts answerIntegration -> asks.ts answer -> makeResume with the form answer.
   An approval pause after a form is re-decided as 'Read' (asks.ts answer: basis). *)
InputAnswer ==
  /\ inpAnswer \in {"accept", "decline"}
  /\ exec = "inputPause"
  /\ IF pauseExpired \/ inpAnswer = "decline"
       THEN /\ exec' = IF pauseExpired THEN "expired" ELSE "refused"
            /\ flow' = None
            /\ inpAnswer' = "used"
            /\ inp' = IF inp = "answering" THEN "answered" ELSE inp    \* finishIntegrationInput
            /\ UNCHANGED <<opBasis, pauses, askedApproval, pauseExpired, took, inpCancelled,
                           withdrawnAt, late, withdrawnAccept>>
       ELSE /\ late' = (late \/ pauseExpired)
            /\ withdrawnAccept' = (withdrawnAccept \/ withdrawnAt)
            /\ \E o \in Outcomes :
                 /\ Land(o, opBasis, "Read")
                 /\ IF o = "inputPause"
                      THEN NewQuestion
                      ELSE /\ inpAnswer' = "used"
                           /\ inp' = IF inp = "answering" THEN "answered" ELSE inp
                           /\ UNCHANGED <<inpCancelled, withdrawnAt>>
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, appr, ownExpired, dev, owed,
                 moves, declined>>

(* inputs/store.ts withdrawWaiting: the Person's ordinary message withdraws a waiting question. *)
Withdraw ==
  /\ inp = "waiting"
  /\ inp' = "withdrawn"
  /\ withdrawnAt' = TRUE
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, dev, owed, inpAnswer, inpCancelled,
                 took, moves, declined, late, withdrawnAccept>>

(* inputs/store.ts cancelWithdrawn -> asks.ts answer with cancel: nothing takes effect. *)
CancelWithdrawn ==
  /\ inp = "withdrawn"
  /\ ~inpCancelled
  /\ exec = "inputPause"
  /\ inpCancelled' = TRUE
  /\ exec' = IF pauseExpired THEN "expired" ELSE "refused"
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, dev, owed, inp, inpAnswer, took,
                 moves, declined, late, withdrawnAt, withdrawnAccept>>

(* inputs/store.ts expireIntegrationInputs: past the pause's deadline. No request is sent. *)
ExpireInput ==
  /\ inp \in {"waiting", "answering"}
  /\ pauseExpired
  /\ inp' = IF inp = "waiting" THEN "expired" ELSE "answered"
  /\ UNCHANGED <<effect, applicable, uncertain, background, call, flow, opBasis, exec, pauses,
                 askedApproval, pauseExpired, appr, ownExpired, dev, owed, inpAnswer, inpCancelled,
                 took, moves, declined, late, withdrawnAt, withdrawnAccept>>

Next ==
  \/ Propose \/ Dispatch \/ Resolve \/ Accept
  \/ PauseDeadline \/ OwnDeadline
  \/ \E d \in Devices : DeviceReads(d) \/ DeviceClaims(d)
  \/ RunOwn \/ AnswerHeld \/ ExpireApproval
  \/ InputClaim \/ InputAnswer \/ Withdraw \/ CancelWithdrawn \/ ExpireInput

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The promises. Each is one plain sentence in the skill. *)

TypeOK ==
  /\ effect \in Effects
  /\ \A a \in Asks : moves[a] \in 0..2

(* A Never rule always wins: an act it covers never takes effect unless it only reads and
   Executor did not ask approval for it (Gate.before passes plain reads before any rule). *)
NeverWins ==
  "Never" \in applicable =>
    \A i \in DOMAIN took : effect = "read" /\ ~took[i].consequential

(* A destructive act, or one Executor asked approval for, takes effect only on Jev's review
   saying run, or the Person's own consent. *)
ConsequentialNeedsReviewOrPerson ==
  \A i \in DOMAIN took : took[i].consequential => took[i].basis \in PersonOk

(* Nothing the Person declined takes effect. *)
DeclinedNeverRuns == declined => took = <<>>

(* Nothing is sent on an expired pause, and no Approval runs after its own deadline. *)
ExpiredNeverSends == ~late

(* A question the Person withdrew by writing in the Thread is never answered accept. *)
WithdrawnNeverAccepted == ~withdrawnAccept

(* Each Approval is decided once, however many devices press at the same moment. *)
DecidedOnce == \A a \in Asks : moves[a] <= 1
=============================================================================
