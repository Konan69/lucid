# Product decisions

**Status:** Canonical product context  
**Updated:** 2 September 2026

This file separates Vivid's stated decisions from design proposals and assistant assumptions. When
another document conflicts with this one, this one wins until Vivid changes it.

## Product

- Vivid is an AI teammate for ordinary work, not a coding tool.
- The experience must be dead simple for non-technical people.
- The initial relationship and mental model are the person and Vivid. Do not begin by asking the
  person to configure people, agents, skills, connectors, or automations.
- Vivid must scale to an organization. This is a hard rule, not a post-v1 afterthought.
- **Vivid never said "no team in v1."** That sentence was an assistant inference and is invalid.
  The exact set of team features in v1 remains a product-scoping decision.
- Simplicity and organizational scale must coexist. Earlier internal products lost simplicity when organizational
  concepts and implementation nouns became visible destinations.

## Organization without a dashboard

The promising substrate already exists in the Grok Bot reference:

- asynchronous Vivid-to-Vivid messages that wake the recipient;
- shared rooms and bounded group turns;
- cross-user invitations and membership;
- forks and subagents that keep the primary Vivid responsive;
- shared organizational memory and policy beneath each person's experience.

These capabilities do not require an agent roster or an organization dashboard on the main screen.
People and their Vivids can participate through ordinary threads. The exact v1 interaction is not
yet settled; do not quietly defer all team support or invent a separate admin product.

## Company, teams, and projects

- The company is the organization and the top-level ownership boundary.
- A company has ordinary members and Teams made from those members.
- Projects are cross-functional work containers. They are not tags and do not belong to only one
  department or Team.
- Projects form a recursive tree: a Project may contain child Projects, which may contain further
  child Projects.
- Projects have members and may involve Teams. Threads may be located inside Projects.
- Child Projects inherit members, permissions, context, and connections from their parent.
- Whether a child may restrict inherited access or may only extend it remains open.

The full model and remaining questions are in [Company and projects](12-company-and-projects.md).

## Main-screen direction

- Combine Open Session's conversation layout, Grok Bot's approachable relationship, and the useful
  information density of T3 Code's sidebar.
- The sidebar must use product language, not architecture language.
- Current sidebar exploration: **Today**, **Routines**, and **Library**.
- **Library** replaces both the earlier "Ready when you are" wording and Vivid's use of the label
  "Teach Vivid" or "Teach a task." The latter remains valid only when describing Grok Bot itself.
- Show Vivid's face and name without a subtitle or status sentence underneath.
- Vivid did not specify active-row behavior. Selected states, lifecycle shelves, and status styling
  are design proposals that must not be reported as his decisions.
- The interface needs convincing depth: distinguish surface tiers with disciplined contrast,
  hairlines, shadows, and dark-theme edge highlights. Judge these against the supplied screenshots.

## Content and examples

- Remove Georgiy, Bosch, and references derived from Vivid's past projects.
- Use easy, neutral, everyday examples that explain the product without private history: booking
  dinner, comparing flights, moving an appointment, planning meals, reminders, forms, and email.
- Reference repositories inform product mechanics and architecture; they should not leak into
  customer-facing fixture content.

## Settings

- Settings should follow the compact modal pattern in the supplied Grok Bot screenshot.
- Theme is required at minimum. Supported preference values are system, light, and dark.
- Other settings remain proposals until product scope is decided. Do not mistake a reconstructed
  mock settings page for an approved settings specification.

## Platform and architecture

- The web client uses Vite.
- The agent runtime is first. Do not design it backwards from the UI, a cloud provider, or a broad
  set of speculative contracts.
- Vivid is one ordinary, long-lived program with one artifact, state directory, lifecycle, and API.
  It may supervise child processes internally; those are not separately deployed services.
- The local baseline requires no cloud account: file-backed SQLite, local artifacts, filesystem,
  subprocesses, and browser access. The same program may run on a laptop, container, or VM.
- **Flue Node is the selected agent runtime.** Its coordinator, submission journal, leases, durable
  conversation stream, and restart reconciliation are the durability engine. SQLite stores their
  evidence; SQLite alone is not the engine. Always configure a file path because Flue's default
  in-memory SQLite does not survive process exit.
- Flue owns canonical agent conversation state. Vivid wraps Flue observation in a shared client
  store and maps that view model into AI Elements. Do not put `useChat` between the clients and
  Flue or maintain a second canonical message array.
- Effect structures Vivid's product services and may run durable product jobs such as schedules or
  connector ingestion. It does not wrap or duplicate Flue agent-turn recovery.
- WorkflowAgent, Workflow SDK, Nitro, and a required Postgres World are not part of the selected
  runtime. They remain evaluated alternatives in the research record.
- Cloudflare is optional infrastructure, not the canonical runtime. Do not require Workers,
  Durable Objects, bindings, or object storage merely to run Vivid.
- Use T3 Code's useful platform split as a reference: shared web renderer for browser and Electron
  desktop; native mobile UI over shared contracts and client runtime; backend owns durable agent
  work and streams typed events to clients.
- Explain architecture in conversation when requested. Writing a document alone is not an answer.
- Vivid's computer follows the whole-machine thesis: a persistent, private machine carrying agent
  state and execution context. Cloudbox contributes lifecycle, wake, and identity; Grok Bot
  contributes desktop, browser identity, egress, takeover, messaging, and fork mechanics.

## Repository and dependency state

- The repository is now a pnpm workspace with `apps/web`, `apps/server`, `packages/contracts`,
  `packages/client-runtime`, and `packages/design-tokens`.
- Effect `4.0.0-rc.112` is currently installed in the contracts, runtime, and server packages.
- Oxlint `1.81.0` is currently installed at the workspace root. Vivid requested the latest RC; the
  installed version must be checked against the registry before claiming that request is complete.
- A package install or architecture extraction is not permission to continue inventing product UI.
  Vivid explicitly corrected the assistant for writing code beyond the requested scope.

## Working discipline

- Attribute statements carefully: distinguish direct decisions, assistant proposals, reference
  behavior, and implementation accidents.
- Keep documenting product exploration, but do not let documentation silently settle open choices.
- When Vivid asks what remains, report unfinished work plainly so product sketching can continue.
- Do not use previous private projects or people as demo content unless Vivid asks for them.

## Still open

- Which team and organization interactions belong in v1.
- Whether Today, Routines, and Library are the final sidebar destinations.
- The final main-screen hierarchy, active/selected treatment, and thread grouping.
- The complete settings scope beyond theme.
- How Vivid closes Flue's acceptance gaps: durable approval, tool-produced vision, per-submission
  control, phone reconnection, computer integration, and packaging.
- The final desktop and mobile delivery sequence.
