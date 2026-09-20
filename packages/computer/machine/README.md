# Machine

**Not built.** This directory reserves the place named in `docs/00-structure.md`.

The `MachineProvider` boundary (state, start, stop, run) and its boat.dev implementation. Nothing durable goes through it: a provider that loses a machine loses nothing a Person made, which is what keeps the provider replaceable. The boundary's interface lives in `computer/state` today and moves here with its first implementation.

Defined by: docs/04-computer.md.

Delete this file when the first real module lands here.
