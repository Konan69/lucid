# Routines and templates

**Status:** Feature designed 2 September 2026; UI shipped as a demo. Commerce model is a proposal,
not an agreement.

## Shape

```text
Routine
├── Name and one-line summary
├── Trigger (schedule or event)
├── Actions (ordered, each one bounded)
└── Origin
    ├── Written from scratch ("New routine")
    └── Installed from a template
         ├── Vivid original (free or priced)
         └── Publisher template (branded, priced)

Template gallery
├── Vivid originals — free: Weekly numbers, Close the week
├── Vivid originals — priced: Contract renewal watch (£3/mo)
└── Publisher templates — Tender triage, Brand guard, Client intake, …

Template detail
├── Publisher badge, rating, install count, price
├── Numbered action steps
├── "Use template" purchase action
└── Trust note: instructions ship, access never does
```

## What a routine is

A routine is a named, repeatable instruction set: one trigger and a short ordered list of bounded
actions. Routines are the output of the automation moments in conversations — when Vivid offers to
repeat something, the thing it offers is a routine ("Vivid set up a routine · Every Monday at 8am").

Routines are plain and inspectable. A person can read every action before and after installing.
No code, no flow editor, no implementation nouns.

## The template model

Every routine can become a template. A template is the routine's instructions plus a price and a
publisher. The publisher is either Vivid or an outside team.

- **Vivid originals** demonstrate the model and are free or cheap.
- **Publisher templates** are how organizations sell their playbook. Examples in the demo:
  Whitehall Works (Tender triage, ops), Studio Norr (Brand guard, marketing), Kestrel Legal Ops
  (Client intake, legal/admin).

The commercial rule in the demo copy: **buy once, run forever; authors keep 70% of every sale.**
Vivid takes a 30% cut. This mirrors the "Grok portals templates" pattern from the reconstructed
project: a gallery of reusable starts, branded publishers, revenue share with authors.

## Why templates (the Vivid framing)

Vivid's framing: "every organization is a routine that is just sold." The templates feature is the
product expression of that — a law firm's intake process, an agency's brand check, an ops team's
tender triage are all packaged as routines and sold to other Vivid customers. Vivid's revenue is
the 30% cut of every sale.

Templates are deliberately **cross-audience**: legal, ops, admin, design, marketing. Nothing in
the gallery is developer tooling. The gallery is the clearest proof that Vivid is not a coding tool.

## The trust boundary (invariant)

**A template ships instructions, not access.** The author never sees the buyer's data. Installing
"Client intake to file" from Kestrel Legal Ops gives Vivid the steps to run; it does not give
Kestrel any visibility into who runs it or what flows through it. This is stated on every template
detail page and must hold in the real implementation.

## Invariants

- A routine is readable in one screen: trigger plus actions, no hidden steps.
- An installed template produces an ordinary routine; it can be edited, and editing does not break
  attribution or payments.
- Publishing requires owning the routine; a template derived from someone else's template keeps
  chain of attribution (open question below).
- Free and paid templates are indistinguishable in behavior; price changes nothing at runtime.
- The 70/30 split is the only commerce number shown in user-facing copy.

## Shipped in the demo

- `apps/web/src/data/routines.ts` — routine and template fixtures.
- `apps/web/src/screen/Routines.tsx` — the Routines screen (`?routines`): Running list, Template
  gallery, Sell-your-own card, Template detail with "Use template" and the trust note.
- Sidebar "Routines" entry routes to it.

## Still to decide

- Actual revenue split and whether "buy once, run forever" survives contact with subscription
  pricing (demo cards show both £/mo prices and the "buy once" line).
- Whether organizations (docs/12) can publish templates under a company identity and route the
  author cut to the company.
- Whether templates can require connectors (e.g. "Drive") and what happens on install if the buyer
  has not connected them.
- Attribution and remixing: can a buyer modify a purchased template and republish it?
- Versioning: when an author updates a template, do installed copies update, fork, or ask?
- Refunds, VAT, and regional pricing — untouched.
