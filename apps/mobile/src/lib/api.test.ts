import { expect, it } from "vitest";
import { createApi, normalizeServerUrl } from "./api.ts";

it("server URLs reject unsafe schemes and embedded credentials", () => {
  expect(normalizeServerUrl(" https://example.com/vivid/ ")).toBe(
    "https://example.com/vivid",
  );
  for (const url of [
    "file:///tmp/a",
    "javascript:alert(1)",
    "https://secret@example.com",
    "https://example.com?token=secret",
  ]) {
    expect(() => normalizeServerUrl(url)).toThrow();
  }
});

it("direct runtime routes authenticate both API and chat; gateway routes stay behind proxy", async () => {
  let observed: RequestInit | undefined;
  const api = createApi(
    { url: "https://example.com", token: "test-token" },
    async (_, init) => {
      observed = init;
      return new Response(null, { status: 204 });
    },
  );

  expect(api.agentUrl("a/b")).toBe(
    "https://example.com/agents/vivid/a%2Fb",
  );
  await expect(api.request("/api/tasks/one", "DELETE")).resolves.toBeUndefined();
  expect(observed?.method).toBe("DELETE");
  expect(new Headers(observed?.headers).get("authorization")).toBe(
    "Bearer test-token",
  );
  expect(
    createApi({ url: "https://example.com", token: "" }).agentUrl("one"),
  ).toBe("https://example.com/api/vivid/one");
});

it("multipart uploads leave the boundary header to fetch", async () => {
  const form = new FormData();
  form.append("file", new Blob(["notes"]), "notes.txt");
  const api = createApi(
    { url: "https://example.com", token: "" },
    async (_, init) => {
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect(init?.body).toBe(form);
      return Response.json({ document: { name: "notes.txt" } });
    },
  );

  await expect(api.request("/api/library", "POST", form)).resolves.toStrictEqual(
    { document: { name: "notes.txt" } },
  );
});

it("backend errors reach the screen instead of appearing as empty success", async () => {
  const api = createApi({ url: "https://example.com", token: "" }, async () =>
    Response.json({ error: "Folder not found" }, { status: 404 }),
  );

  await expect(api.request("/api/library?folderId=missing")).rejects.toThrow(
    /Folder not found/,
  );
});
