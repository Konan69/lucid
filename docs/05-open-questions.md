# Open questions

2026-10-03: These are the 2 September questions, retained without deciding them here; later implementation evidence superseding their status is in [docs/14](14-product-feature-set-and-grok-bot-parity.md), with owner decisions listed in the docs audit report.

Undecided as of 2026-09-02.

1. **The first greeting.** What Vivid says on day one, before there is a thread to show. It carries
   the whole product with no nav to help it. This is the first thing to design.
2. **The desktop client.** Grok Bot's egress tunnel and teach-a-task both need a client on the
   user's laptop. Vivid needs one for the same reasons. Electron, or the T3 Code fork's shell.
3. **Memory.** The organizational-memory direction, retrieval model, and how much belongs
   per-user in v1.
4. **What "connectors" become in the UI.** The "what do you use every day" grid answers it once.
   Everything after that is an in-thread ask. The audit view the user can open later is undesigned.
5. **Runtime acceptance gaps.** One Pi Durable cell per Person on celld is selected, but durable approval, tool-produced vision,
   phone reconnection, computer integration, and kill/restart behavior still need proof before the
   runtime can be called production-ready.
6. **Project inheritance.** Child projects inherit members, permissions, context, and connections.
   Can a child narrow that inherited access, or may it only add to it?
7. **Project contents.** Threads may live in projects. Whether projects also directly own goals,
   files, memory, and milestones—and whether threads may remain unfiled—is undecided.
