# Client state

**Not built.** This directory reserves the place named in `docs/00-structure.md`.

One client data layer for web, mobile and desktop: a cache keyed by RPC call, live updates over the RPC stream, optimistic writes, and the pure view logic every surface shares (Thread lanes, Connection-request grouping).

It replaces mobile's polling `lib/resource/` store and web's reload-after-write, which are two answers to the same question.

Defined by: docs/07-main-screen.md, docs/09-platform-architecture.md.

Delete this file when the first real module lands here.
