# What Lucid is for

Decided with the owner on 3 October 2026 and revised on 25 October 2026, after he used the web and phone apps and judged them
"generic" and "not useful to anyone yet". This page says what the product must do for one person
before anything else is built. It narrows [docs/22](22-one-product.md); the rule in
[docs/01](01-principle.md) still holds: a screen must justify why it is not a message in the Thread.

## Who it is for first

One person: the owner, in his own working day. A team comes second and must fit without turning the
product into a dashboard.

## What makes it worth opening every day

In the owner's words and order:

1. **It chases what I am waiting on.** Replies owed, things people promised, follow-ups.
2. **It does jobs on its computer** while the person does something else.
3. **It keeps my projects moving.** It knows each Project's state and pushes the next step.
4. **It organises my time and gives me to-dos.**

A morning summary of mail and calendar was offered and not chosen. It is a means to the four above,
not a goal.

## Decisions

| Question            | Decision                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First run           | **Lucid speaks first, in the Thread.** No wizard and no "give it a job" step: that belongs to products with many assistants. Lucid greets the Person, asks what they use most and offers to connect it with cards in the Thread, and shows a short checklist of what is left. The Person can ignore all of it and type.                                                                       |
| Reaching the Person | **The app's own push notifications** on phone, desktop and browser. A chat app is **paused**: WhatsApp does not allow assistants on business numbers and the owner does not use Telegram. iMessage is his preference when a chat app comes back.                                                                                                                                              |
| Speaking unasked    | **Lucid decides what is worth the Person's attention** and notifies them. No quiet-hours, caps or summary settings: the owner called those overdesign. A Person corrects Lucid in words and it remembers.                                                                                                                                                                                     |
| Check-ins           | **Lucid takes up open work by itself** (what the Person is waiting on, a Project's next step, a question left unanswered) and comes back with progress. Lucid chooses when. A Person who wants a fixed time can say so in the Thread ("every morning at 7"); that is an option, never a setup step. Routines as a separate product surface were removed on 25 October 2026.                   |
| What wakes Lucid    | A Person's message, a reply to a notification, a Watch event from an Integration, and a check-in. Mail sent to Lucid, webhooks and messages from another Lucid come later.                                                                                                                                                                                                                    |
| Permissions         | Asked where a Person manages things (the Feed, Settings or a notification), never as a banner in a Thread and never before Lucid starts work. Finer-grained permissions come later.                                                                                                                                                                                                           |
| Acting unasked      | **Small safe things alone, told after.** Anything that sends, spends, deletes or cannot be undone still needs the Person's yes.                                                                                                                                                                                                                                                               |
| Projects            | **A Project is a logical group of work.** It is back in the product, redesigned, and Lucid can create one.                                                                                                                                                                                                                                                                                    |
| Companies           | Creating a Company is offered by Lucid at the right moment in a Thread and has one well-placed entry in the app, on web and phone. A Person can scope to a Company the same way as to a Project. What scoping narrows is left to the builder; the owner has no preference.                                                                                                                    |
| Skills              | A Person never sees or manages skills. Lucid saves and reuses its own procedures.                                                                                                                                                                                                                                                                                                             |
| The Computer        | **Every Lucid Computer comes with the apps already installed** (office, creative and engineering tools) and a home screen that shows them, as the reference assistant's computer does. A Person sees it live: a Peek in the Thread while Lucid works, and a panel beside the Thread, popped out or full screen, with the pages Lucid opened as tabs and a line saying what it is doing.       |
| Feel                | **The Thread looks alive and stays quiet.** Each thing Lucid says is its own message bubble. While it works, one bubble over the composer says the step it is on ("Using Grain", with that Integration's logo) with a moving shimmer; no steps, timers or "Worked" lines stay in the Thread. An Integration card is one row: logo, name, one line written for the Person, at most one button. |
| Background work     | Out of scope for the Thread. What Lucid does in the background (Watches, check-ins) reports its status to the Feed page.                                                                                                                                                                                                                                                                      |
| Look                | Clean dark and light, no violet, layers and contrast as measured from the reference app, colour from Lucid's face and real service logos. Lucid's name, colour and face shape are the Person's choice.                                                                                                                                                                                        |

## Built since this page was written

Google sign-in on the server, notifications on phone, desktop and browser, Watches on Integration
events with findings in the Feed, the Computer from a Thread, the deployed server and the
installable phone app. [docs/14](14-product-feature-set-and-grok-bot-parity.md) holds how each was
checked.

## Still open

1. **Check-ins:** Lucid choosing open work to take up and when, plus a fixed time when a Person asks
   for one.
2. **Waiting-on tracking:** what the Person is owed and by whom, kept by Lucid and chased.
3. **To-dos and time:** a Person's own to-do list that Lucid adds to and ticks off, and Lucid
   placing work in the calendar.
4. **Projects with state:** what a Project is trying to reach, where it stands, the next step.
5. **The Computer panel:** a terminal and the Computer's files beside the screen and pages.

Later, in no order: mail to Lucid, webhooks, Lucid-to-Lucid messages, finer permissions, apps Lucid
builds and shares, and learning a task by watching the Person's browser.
