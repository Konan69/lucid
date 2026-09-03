# Principle

Status: stated by Vivid, 2026-09-02. Not yet tested against a build.

## The rule

Any proposed screen, nav item, or setting must justify why it is not a message in the thread.

## What that produces

- **One surface.** A thread list, a thread, and a settings gear. Nothing else is a destination.
- **Vivid is the agent.** The word "agent" never appears in the product. There is no roster and no
  agent configuration. Vivid has a face and a name so it reads as a someone, not a chat box.
- **Simple alone, organizational by design.** The starting relationship is one person and their
  Vivid, but that does not exclude teams from v1. Scaling to an organization is a hard product
  rule. Shared threads, people, organizational memory, policy, and Vivid-to-Vivid communication
  must fit without turning the main experience into an admin dashboard.
- **No nav of nouns.** Skills, Connections, Automations, Agents, Inbox are engineering categories.
  Earlier internal products exposed each one as a sidebar item and read as dashboards. A non-technical user
  has no mental model for "a skill" or "a connector" and should not need one.
- **Capabilities arrive on demand.** Vivid asks for a service or document the first time it needs
  it, inside the thread. Permission is a question in the thread plus an activity record the user can
  open later.
- **Repeated work is said, not built in a flow editor.** A person describes the outcome in the
  thread and confirms the resulting card.
- **Memory is what makes it Vivid.** It remembers the user across threads. Prior organizational
  memory and retrieval work goes here, invisibly.
- **Keep implementation machinery underneath.** The surface describes outcomes, not infrastructure.

## Why

Vivid's reaction to earlier internal products: "dashboards posing as workspaces." Non-technical users
struggle with agents, skills, and connectors as concepts. Grok Bot has the same machinery and hides
all of it behind one conversation, which makes it nearly impossible to not just start chatting.
