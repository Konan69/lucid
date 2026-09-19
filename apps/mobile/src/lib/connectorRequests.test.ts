import { test } from "node:test";
import assert from "node:assert/strict";
import { readConnectorRequest, authorizationAddress } from "../../../web/src/data/connectorRequests.ts";

void test("connector cards accept only supported IDs and bounded, nonempty reasons", () => {
  assert.deepEqual(readConnectorRequest({ kind: "connector-request", connector: "gmail", reason: " Find the reply. " }), {
    kind: "connector-request", connector: "gmail", reason: "Find the reply.",
  });
  for (const connector of ["__proto__", "constructor", "../../auth", "slack"]) {
    assert.equal(readConnectorRequest({ kind: "connector-request", connector, reason: "Connect" }), null);
  }
  for (const reason of [null, " ", "a".repeat(401)]) {
    assert.equal(readConnectorRequest({ kind: "connector-request", connector: "drive", reason }), null);
  }
  assert.equal(readConnectorRequest({ connector: "gmail", reason: "Connect" }), null);
});

void test("authorization handoffs reject executable URLs and embedded credentials", () => {
  assert.equal(authorizationAddress("https://accounts.google.com/o/oauth2/v2/auth?state=test"), "https://accounts.google.com/o/oauth2/v2/auth?state=test");
  for (const address of [undefined, "javascript:alert(1)", "file:///tmp/auth", "http://accounts.google.com", "https://user:password@example.com", "/auth"]) {
    assert.throws(() => authorizationAddress(address));
  }
});
