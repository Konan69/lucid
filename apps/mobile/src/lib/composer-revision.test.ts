import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
} from "../native/composerEditorRevision.ts";

const snapshots = [
  { eventCount: 4, value: "hello", selection: { start: 5, end: 5 } },
  { eventCount: 5, value: "hello!", selection: { start: 6, end: 6 } },
];
test("late native events cannot overwrite newer keystrokes", () => {
  assert.equal(acknowledgeComposerNativeEvent(5, 4), null);
  assert.equal(acknowledgeComposerNativeEvent(5, NaN), null);
  assert.equal(acknowledgeComposerNativeEvent(5, 5.5), null);
  assert.equal(acknowledgeComposerNativeEvent(5, 6), 6);
});
test("intermediate React value and selection stay behind native revision", () => {
  assert.equal(
    resolveComposerControlledEventCount(
      "hello",
      { start: 5, end: 5 },
      5,
      snapshots,
    ),
    4,
  );
  assert.equal(
    resolveComposerControlledEventCount(
      "hello!",
      { start: 5, end: 5 },
      5,
      snapshots,
    ),
    4,
  );
  assert.equal(
    resolveComposerControlledEventCount(
      "hello!",
      { start: 6, end: 6 },
      5,
      snapshots,
    ),
    5,
  );
});
test("intentional composer clear uses latest revision instead of stale echo", () => {
  assert.equal(resolveComposerControlledEventCount("", null, 5, snapshots), 5);
  assert.equal(isComposerNativeEcho("", null, 5, snapshots), false);
  assert.equal(isComposerNativeEcho("hello!", null, 5, snapshots), true);
  assert.equal(
    isComposerNativeEcho("hello!", { start: 0, end: 0 }, 5, snapshots),
    false,
  );
});
test("acknowledgement preserves newer pending edits", () => {
  assert.deepEqual(pruneAcknowledgedComposerNativeEvents(snapshots, 4), [
    snapshots[1],
  ]);
  assert.equal(snapshots.length, 2);
});
