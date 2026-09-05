import { test } from "node:test";
import assert from "node:assert/strict";
import { laneConversations } from "../../../web/src/data/conversationLanes.ts";

test("web and native grouping prioritizes pinned work without duplicating conversations", () => {
  const { lanes } = laneConversations([
    { id: "pinned-working", pinned: true, status: "working", when: "today" },
    { id: "approval", status: "approve", when: "today" },
    { id: "running", status: "working", when: "yesterday" },
    { id: "recent", status: "ready", when: "today" },
    { id: "older", status: "ready", when: "earlier" },
  ]);
  assert.deepEqual(
    lanes.map((lane) => [lane.key, lane.items.map((t) => t.id)]),
    [
      ["pinned", ["pinned-working"]],
      ["needs", ["approval"]],
      ["working", ["running"]],
      ["today", ["recent"]],
      ["earlier", ["older"]],
    ],
  );
  assert.equal(new Set(lanes.flatMap((lane) => lane.items.map((t) => t.id))).size, 5);
});

test("snoozed conversations stay out of date groups and empty sections disappear", () => {
  const { lanes, snoozed } = laneConversations([
    { id: "later", status: "ready", when: "today", snoozeUntil: "2099-01-01" },
    { id: "yesterday", status: "ready", when: "yesterday" },
  ]);
  assert.deepEqual(
    lanes.map((lane) => lane.key),
    ["yesterday"],
  );
  assert.deepEqual(
    snoozed.map((t) => t.id),
    ["later"],
  );
  assert.deepEqual(laneConversations([]), { lanes: [], snoozed: [] });
});
