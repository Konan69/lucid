import * as Schema from 'effect/Schema'

/**
 * One vocabulary owns the test launcher's argument and the fixture process's decoded ingress. Each
 * case is one way an extraction process behaves once the official RPC reaches it:
 * - `spin`: enters the handler and blocks JavaScript, so only a kill ends it;
 * - `grow`: enters the handler and exhausts V8's old generation under the launcher's heap cap;
 * - `abort`: enters the handler and aborts without exhausting anything;
 * - `exit`: enters the handler and exits with code 1;
 * - `defect`: the handler throws; `faulted`: the handler fails with the typed retryable error;
 * - `absent`: exits with code 1 while loading, before the worker handshake.
 *
 * The cases carry no data. The handler-entry receipt is a pipe the launcher adds (`RECEIPT_FD`), and
 * the heap cap is a launcher option, so nothing is shared through memory.
 */
export const Fixture = Schema.TaggedUnion({
  spin: {},
  grow: {},
  abort: {},
  exit: {},
  defect: {},
  faulted: {},
  absent: {},
})

/**
 * The wire form of one case as a process argument: `fork` passes strings only
 * (Node v24.14.1 lib/child_process.js:160), so the launcher encodes and the fixture decodes this.
 */
export const FixtureArgument = Schema.fromJsonString(Fixture)
