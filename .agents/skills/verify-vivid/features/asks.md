# An Integration asks

Model requirement: real model. Rehearsal cannot prove this journey.

Run `verify feature asks <run>` and `verify browser asks <run>` after Launch and worthy Doctor on the same unchanged head. Cleanup follows. Each takes a few minutes.

The recipe ([asks.mjs](../scripts/asks.mjs)) connects the disposable Verify Pulse Integration and asks the real model to call its `approve` and `file` operations ([pulse.mjs](../scripts/pulse.mjs)). Both pause in Executor itself (`approval: always()`), and `file` then asks a typed form (`ctx.elicit`). There is no Ask rule; the ask is the Integration's own.

1. **Approval.** One pending Approval with a saved continuation, headed with the tool's declared title and the account ("Send a verification pulse with Verify Pulse"). Browser: the banner's rows are exactly Allow and Don't allow, and the Feed card offers Don't allow and Allow with no draft field. Allow succeeds.
2. **Question.** After Allow on `file`, one waiting Input request with the Integration's form. Browser: the head is the form's message, the defaulted choice (Medium) is chosen, the defaulted text (Summary) is filled, and Send waits for the required yes-or-no. The Person presses No and Send. The request ends Completed, and the value Executor's `ctx.elicit` received is exactly `{ priority: "medium", summary: "Phone form bug", labels: [], urgent: false }`: the untouched required array is `[]`, untouched optional fields are absent, the default text is unchanged. The Thread shows the Person's "Sent".
3. **Withdrawn.** While a second question waits, the composer is labelled Message Vivid. A message withdraws the question and its paused call is answered cancel: the request ends Withdrawn with a Cancelled outcome.
4. **Expired.** An Approval and a question are left waiting, then the run's own Executor container is restarted, which drops both paused calls as #227's live proof does. Allow and Send then reach Executor too late and come back Expired at once, instead of after Executor's 15-minute deadline. Browser: after reload the Thread says "Expired before you answered. Nothing was sent." and "Expired before you answered. Verify Pulse may already have acted."

A final export of the quiesced Executor shows one pulse for the allowed Approval and none for the cancelled question or the expired Approval.

Evidence stays in `asks/` and `browser/asks/`, with each wait's Thread detail, the question's DOM reading, the provider exports and, for the browser, snapshots and screenshots of every stage.

Unproved: the phone and desktop clients (desktop loads the same web client), the Notifications panel, push notification buttons, and expiry by Executor's own deadline with the server's sweep.
