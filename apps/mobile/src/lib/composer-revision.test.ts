import { expect, it } from "vitest";
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

it("late native events cannot overwrite newer keystrokes", () => {
  expect(acknowledgeComposerNativeEvent(5, 4)).toBeNull();
  expect(acknowledgeComposerNativeEvent(5, Number.NaN)).toBeNull();
  expect(acknowledgeComposerNativeEvent(5, 5.5)).toBeNull();
  expect(acknowledgeComposerNativeEvent(5, 6)).toBe(6);
});

it("intermediate React value and selection stay behind native revision", () => {
  expect(
    resolveComposerControlledEventCount(
      "hello",
      { start: 5, end: 5 },
      5,
      snapshots,
    ),
  ).toBe(4);
  expect(
    resolveComposerControlledEventCount(
      "hello!",
      { start: 5, end: 5 },
      5,
      snapshots,
    ),
  ).toBe(4);
  expect(
    resolveComposerControlledEventCount(
      "hello!",
      { start: 6, end: 6 },
      5,
      snapshots,
    ),
  ).toBe(5);
});

it("intentional composer clear uses latest revision instead of stale echo", () => {
  expect(resolveComposerControlledEventCount("", null, 5, snapshots)).toBe(5);
  expect(isComposerNativeEcho("", null, 5, snapshots)).toBe(false);
  expect(isComposerNativeEcho("hello!", null, 5, snapshots)).toBe(true);
  expect(
    isComposerNativeEcho("hello!", { start: 0, end: 0 }, 5, snapshots),
  ).toBe(false);
});

it("acknowledgement preserves newer pending edits", () => {
  expect(pruneAcknowledgedComposerNativeEvents(snapshots, 4)).toStrictEqual([
    snapshots[1],
  ]);
  expect(snapshots).toHaveLength(2);
});
