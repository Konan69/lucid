import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, normalizeServerUrl } from "./api.ts";

test("server URLs reject unsafe schemes and embedded credentials", () => {
  assert.equal(
    normalizeServerUrl(" https://example.com/vivid/ "),
    "https://example.com/vivid",
  );
  for (const url of [
    "file:///tmp/a",
    "javascript:alert(1)",
    "https://secret@example.com",
    "https://example.com?token=secret",
  ])
    assert.throws(() => normalizeServerUrl(url));
});
test("direct runtime routes authenticate both API and chat; gateway routes stay behind proxy", async () => {
  let observed: RequestInit | undefined;
  const api = createApi(
    { url: "https://example.com", token: "test-token" },
    async (_, init) => {
      observed = init;
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(api.agentUrl("a/b"), "https://example.com/agents/vivid/a%2Fb");
  assert.equal(await api.request("/api/tasks/one", "DELETE"), undefined);
  assert.equal(observed?.method, "DELETE");
  assert.equal(
    new Headers(observed?.headers).get("authorization"),
    "Bearer test-token",
  );
  assert.equal(
    createApi({ url: "https://example.com", token: "" }).agentUrl("one"),
    "https://example.com/api/vivid/one",
  );
});
test("multipart uploads leave the boundary header to fetch", async () => {
  const form = new FormData();
  form.append("file", new Blob(["notes"]), "notes.txt");
  const api = createApi(
    { url: "https://example.com", token: "" },
    async (_, init) => {
      assert.equal(new Headers(init?.headers).has("content-type"), false);
      assert.equal(init?.body, form);
      return Response.json({ document: { name: "notes.txt" } });
    },
  );
  assert.deepEqual(await api.request("/api/library", "POST", form), {
    document: { name: "notes.txt" },
  });
});
test("backend errors reach the screen instead of appearing as empty success", async () => {
  const api = createApi({ url: "https://example.com", token: "" }, async () =>
    Response.json({ error: "Folder not found" }, { status: 404 }),
  );
  await assert.rejects(
    api.request("/api/library?folderId=missing"),
    /Folder not found/,
  );
});
