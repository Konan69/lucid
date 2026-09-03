# Surface

What the user sees. This document describes visible behavior only; implementation and runtime
mechanics are outside its scope.

## First run

Grok Bot's onboarding is two human questions, then the thread.

1. **"Give each Bot a job."** Three colored blob faces with job titles: Invoice Chaser, Weekly
   Standup, Sales Forecast. A bot is a job with a face. These are automations, never called that.
2. **"What do you use every day?"** A grid of familiar tools: mail, calendar, files, and browser.
   These are connectors, answered as "what I use".
3. **"Create your first Bot."** Pick a color, pick a face, type a name, Get started. The left rail
   already says "No chats yet". Suggestion cards are sentences: "Summarizes your Slack channels and
   flags what needs you." "Watches LinkedIn for launches and hires worth a warm intro."

Vivid keeps the shape and collapses it: Vivid already has a face and its name is Vivid. The two
questions remain. Then Vivid says hello and the composer has focus.

## The thread

Open Session shows how work, questions, and queued input render inside a conversation. Vivid takes
these wholesale:

- **The composer is the whole product.** One box: "What do you want to work on?", attach, mic, send.
  No form, no wizard, no model or mode picker.
- **Work is a collapsible "Working" block.** A plan line, a step count, expandable detail. A
  non-technical person gets a summary they can trust and detail they can open.
- **Questions are cards in the thread.** "Vivid needs input", two labeled options with a one-line
  tradeoff each, an "or type your own" field, one Answer button. This is the permission pattern too.
- **The composer queues while Vivid works.** "Queue for when it finishes." The user never waits and
  never wonders whether typing is allowed.
- **Mobile is the same thread**, not a cut-down app.

## What Vivid drops

- Any sidebar of nouns. Open Session's Feed, Pull requests, Workspaces, Archived is a developer's
  map. A list of Home, Chats, Tasks, Automations, Inbox, Agents, Skills, and Connections is the database.
- Grok Bot's plugin modal: a search box, seventeen category chips, Add buttons. The "what do you use
  every day" question already answered it. Anything else is asked for in the thread when needed.
- Bots plural. Invoice Chaser becomes "Vivid chases invoices on Fridays", said once.
- Model names, cost readouts, review panels, PR chrome.

## Library

Vivid names the reusable-knowledge destination **Library**. It is where saved knowledge and
repeatable procedures belong without asking a non-technical person to understand agents, skills,
or automation builders.

## Not yet designed

The empty state on day one. Vivid's first greeting has to carry the whole product with no nav to
help it.
