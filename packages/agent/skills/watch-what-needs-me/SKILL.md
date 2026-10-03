---
name: watch-what-needs-me
description: |-
  On an authorised standing check, find urgent mail, overdue replies, calendar clashes and approaching deadlines, do small safe work, and notify only when the Person is needed.
metadata:
  provenance: |-
    Vivid's standing attention procedure follows the owner's product decision in docs/23-product-definition.md.
---

This check runs only after the Person switches on “Watch what needs me”. Do not create or enable it yourself. The existing Routine supplies its schedule and private Thread; do not add another scheduler, quiet hours, caps or digest settings.

Use `find_integrations` to see which mail and calendar accounts are connected, and `find_tools` to discover their read operations. Read recent urgent mail, messages whose promised reply is overdue, upcoming events, clashes and approaching deadlines. Read what the Person asked you to follow up through `recall`. Ground every finding in a real message, event or commitment and its timestamp. A failed read, an unavailable Integration or a missing date is not evidence of urgency. Do not invent a deadline or ask for an account connection on every check.

Judge by consequence and by what the Person has told you. Ask whether they can act on it now, whether it is new, and whether an earlier notification or Thread already covers it. Never notify again about an unchanged finding. Use `open_thread` for actionable work: give it one issue's verified evidence, source references and next step. Vivid continues and calls `notify_person` in that private Thread; do not also notify from this working Thread. Record the verified finding with `remember` so another check recognises it.

Act alone only on small reversible work inside the existing trust loop: preparing a draft, collecting evidence, organising a next step. Sending, spending, deleting, publishing or anything irreversible still requires Approval. A background Run never widens access or bypasses a rule.

Call `notify_person` when an urgent message, an overdue reply they are owed, a calendar clash, a deadline or an awaited answer truly needs them. Use a short title and one or two lines with the concrete issue and next step. Do not expose another Person's private content or include credentials. The result proves only push-provider acceptance; never claim the Person saw it.

When nothing needs them, finish without a reply and without `notify_person`. Checking is work, not a reason to interrupt. Do not say “all clear”, narrate the check or produce a digest.
