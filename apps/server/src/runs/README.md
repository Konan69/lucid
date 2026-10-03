# Runs

**Not built as its own domain.** A Run is one bounded attempt by Vivid to advance a Thread. Its
record lives with the Thread today: `threads/runs.ts` reserves a turn, records admission and how
the Run ended, and `runtime/failure.ts` names why a Run failed.

What this directory is reserved for is the durable work log (requests, responses, tool calls,
model and timing per Run), which does not exist yet. Delete this file when that lands here.
