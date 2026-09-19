import { test } from "node:test";
import assert from "node:assert/strict";
import { composerColor } from "../native/composerColor.ts";
import { nativeTokens } from "../../../../packages/design-tokens/src/native.ts";

void test("native composer gets readable Vivid text in both appearances", () => {
  for (const platform of ["android", "ios"]) {
    assert.equal(composerColor(nativeTokens.dark.ink, platform), "#fcfcfc");
    assert.equal(composerColor(nativeTokens.light.ink, platform), "#141414");
    assert.equal(composerColor(nativeTokens.dark.accent, platform), "#7c6cff");
  }
});

void test("native placeholder preserves alpha with each platform's hex byte order", () => {
  assert.equal(composerColor(nativeTokens.dark["ink-3"], "android"), "#6bfcfcfc");
  assert.equal(composerColor(nativeTokens.dark["ink-3"], "ios"), "#fcfcfc6b");
  assert.equal(composerColor("#11223344", "android"), "#44112233");
  assert.equal(composerColor("#11223344", "ios"), "#11223344");
});
