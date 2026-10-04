import * as Schema from 'effect/Schema'

/** One fixture vocabulary owns the test spawner's data and the native thread's decoded ingress. */
export const Fixture = Schema.TaggedUnion({
  spin: { flag: Schema.instanceOf(SharedArrayBuffer) },
  grow: { flag: Schema.instanceOf(SharedArrayBuffer), heapMb: Schema.Number },
  exit: {},
  defect: {},
  faulted: {},
  absent: {},
})
