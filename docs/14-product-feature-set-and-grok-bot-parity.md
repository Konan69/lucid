# Product feature set and Grok Bot parity

This is the collaboration-facing product map for the initial Konan build. “Parity” below is a
directional product target, not a claim that Konan and Grok Bot are equivalent.

## Available now

| Capability | State | Notes |
| --- | --- | --- |
| Named AI teammate | Working | Konan is the persistent product identity. |
| Live conversation | Working | The web app streams real Flue responses from GLM 5.3 Flash through OpenRouter. |
| Rich responses | Working | Assistant output renders safe Markdown with GFM lists, tables, links, blockquotes, and code. |
| Durable thread history | Working | Each product thread ID maps to a Flue conversation stored in local SQLite. |
| Send while working | Working | Flue admits new user messages while a response is active and processes them in order. |
| Stop a response | Working | The composer can abort the active response. |
| Connection recovery | Working | The conversation exposes loading, retry, and error states. |
| Conversation list and creation | Working locally | The sidebar creates/selects real durable Flue conversations; their title index is stored alongside Flue state in SQLite. |
| Scheduled routines | Working locally | SQLite stores definitions and run history; a Node cron trigger dispatches durable schedule signals into Flue with pause, test-run, edit, and delete controls. |
| Response provenance | Working | Model, timing, usage, and tool-call count are attached to agent responses. |
| Protected browser-to-runtime path | Working locally | Vite proxies the runtime API and adds the bearer token outside the browser bundle. Production needs an equivalent server-side gateway. |

## Visible but not implemented

These surfaces are product fixtures. They demonstrate the intended experience but are not runtime
contracts and should not be mistaken for finished backend behavior.

| Capability | Current state | Backend work needed |
| --- | --- | --- |
| Thread lifecycle | Working locally | Creation, navigation, rename, archive/restore, and delete use the SQLite-backed product index; user ownership remains outside the demo. |
| Work log | Working locally | The active conversation derives requests, responses, model/timing/usage metadata, failures, and tool calls from its real Flue transcript. |
| Computer panel | Fixture data | A separately supplied execution boundary and artifact model are still required. |
| Tool-call presentation | UI-ready | Real tools, policies, approvals, and results are not mounted. |
| Attachments | Control only | Upload storage, validation, message parts, and retrieval. |
| People, companies, projects, and library | Product fixtures | CRUD APIs, authorization, persistence, and search. |

## Grok Bot product parity map

The comparison uses xAI's current first-party descriptions of Grok Bot: a persistent agent with a
cloud computer, connectors, approvals, reusable skills, scheduled or event-driven routines, and
multi-bot collaboration.

| Grok Bot capability | Konan today | Target boundary |
| --- | --- | --- |
| Persistent conversation and background state | Partial | SQLite conversation history works; durable jobs and cross-thread memory do not. |
| Browser, terminal, and filesystem computer | UI fixture | Proprietary execution subsystem, supplied separately. |
| Connectors and MCP services | Not implemented | Proprietary connector layer, supplied separately. |
| Approval before sensitive actions | Not implemented | Policy and approval protocol spanning product backend and runtime. |
| Reusable skills | Research only | Versioned skill definitions, mounting, permissions, and product management. |
| Scheduled and event-triggered routines | Partial | Cron routines and run history work locally; provider events, catch-up, retry policy, notifications, and production scheduler ownership remain. |
| Multiple agents collaborating in parallel | Not implemented | Delegation protocol, shared context, ownership, and activity presentation. |
| Files, links, images, and richer input | Partial | Text is live; attachment ingestion and persisted artifacts remain. |
| Activity transcript and action visibility | UI fixture | Normalized runtime events and durable work log. |
| Sharing and organization controls | Product model only | Authentication, roles, tenancy, audit, and sharing APIs. |

## Recommended initial build order

1. **Done:** stabilize the live conversation slice and add real thread lifecycle controls.
2. **Done for the demo:** add recurring routines with next-run time, run history, missed-run visibility, retry, and pause controls.
3. **Done for current runtime data:** connect the work log to real Flue transcript and response metadata.
4. Add one harmless tool end to end, including an explicit approval and visible result.
5. Add one connector behind a narrow interface without moving connector credentials into the web app.
6. Connect the computer panel to the separately supplied execution and artifact boundary.

The first vertical slice should prove the complete trust boundary before broadening capability. A
feature is complete only when its product state, authorization, failure behavior, persistence, and
observability are all represented.

## Collaboration boundary

Engineers may work across the web app, ordinary backend APIs, auth, product entities, shared
contracts, SQLite-backed conversation transport, the included Flue model adapter, and the included
single-process demo scheduler. Do not add the production scheduler, connector implementations,
tool implementations, computer transport, credential handling, reconstructed material, research
notes, or legacy PRDs to this repository.

## Sources

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [Bots and persistent computers](https://docs.x.ai/grok-bot/bots)
- [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq)
