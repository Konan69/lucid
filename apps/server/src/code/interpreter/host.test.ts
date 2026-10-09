import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { Program, Tool, toolRefusal } from "./index.ts";
const run = (tool: Tool.Definition<never>) => Program.make({ tools: { host: { call: tool } } }).execute("return await tools.host.call({})");
class UnsafeHostError extends Schema.TaggedError<UnsafeHostError>()("UnsafeHostError", {
    reason: Schema.String,
}) {
}
describe("Program host failure boundary", () => {
    it.live("preserves explicit safe tool failures", () => Effect.gen(function* () {
        const result = (yield* run(Tool.make({
            description: "Fail safely",
            input: Schema.Struct({}),
            output: Schema.String,
            run: () => Effect.fail(toolRefusal("Authorized request was refused")),
        })));
        expect(result.ok ? undefined : result.error).toStrictEqual({
            kind: "ToolFailure",
            message: "Authorized request was refused",
        });
    }));
    it.live("sanitizes unknown host failures and defects", () => Effect.gen(function* () {
        for (const failure of [
            Effect.fail(new UnsafeHostError({ reason: "Authorization: Bearer typed-secret" })),
            Effect.die(new Error("postgres://user:defect-secret@example.invalid")),
        ]) {
            const result = (yield* run(Tool.make({
                description: "Fail internally",
                input: Schema.Struct({}),
                output: Schema.String,
                run: () => failure,
            })));
            expect(result.ok ? undefined : result.error).toStrictEqual({
                kind: "ToolFailure",
                message: "Tool execution failed",
            });
            expect(JSON.stringify(result)).not.toMatch(/typed-secret|defect-secret|Authorization: Bearer/);
        }
    }));
    it.live("sanitizes invalid host output", () => Effect.gen(function* () {
        const secret = "invalid-output-secret";
        const result = (yield* run(Tool.make({
            description: "Return invalid output",
            input: Schema.Struct({}),
            output: Schema.Struct({ safe: Schema.String }),
            run: () => Effect.succeed({ safe: 1, secret } as unknown as {
                readonly safe: string;
            }),
        })));
        expect(result.ok ? undefined : result.error).toStrictEqual({
            kind: "InvalidToolOutput",
            message: "Invalid output from tool 'host.call'.",
        });
        expect(JSON.stringify(result)).not.toMatch(/invalid-output-secret/);
    }));
    it.live("sanitizes host output that throws while being copied", () => Effect.gen(function* () {
        const result = (yield* run(Tool.make({
            description: "Return hostile output",
            input: Schema.Struct({}),
            output: Schema.Unknown,
            run: () => Effect.succeed(new Proxy({}, {
                ownKeys: () => {
                    throw new Error("host-output-secret");
                },
            })),
        })));
        expect(result.ok ? undefined : result.error).toStrictEqual({
            kind: "InvalidToolOutput",
            message: "Invalid output from tool 'host.call'.",
        });
        expect(JSON.stringify(result)).not.toMatch(/host-output-secret/);
    }));
    it.live("caught tool failures are Error values in-program", () => Effect.gen(function* () {
        const result = (yield* Program.make({
            tools: {
                host: {
                    call: Tool.make({
                        description: "Refuse",
                        input: Schema.Struct({}),
                        output: Schema.String,
                        run: () => Effect.fail(toolRefusal("Refused")),
                    }),
                },
            },
        }).execute(`
        try {
          await tools.host.call({})
          return "no"
        } catch (e) {
          return { isError: e instanceof Error, message: e.message }
        }
      `));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.value).toStrictEqual({ isError: true, message: "Refused" });
    }));
    it.live("propagates host interruption instead of returning a diagnostic", () => Effect.gen(function* () {
        const exit = (yield* Effect.exit(Program.make({
            tools: {
                host: {
                    call: Tool.make({
                        description: "Interrupt",
                        input: Schema.Struct({}),
                        output: Schema.String,
                        run: () => Effect.interrupt,
                    }),
                },
            },
        }).execute("return await tools.host.call({})")));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
    }));
});
describe("Program tool-call observation", () => {
    it.live("reports the tools actually invoked with decoded input", () => Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const lookup = Tool.make({
            description: "Look up a value",
            input: Schema.Struct({ query: Schema.String }),
            output: Schema.String,
            run: ({ query }) => Effect.succeed(query),
        });
        const result = (yield* Program.make({
            tools: { context: { lookup } },
            onToolCallStart: (call) => Effect.sync(() => calls.push(call)),
        }).execute(`
        if (false) await tools.context.lookup({ query: "not called" })
        return await tools.context.lookup({ query: "deployment failure" })
      `));
        expect(result.ok).toBe(true);
        expect(calls).toStrictEqual([{ index: 0, name: "context.lookup", input: { query: "deployment failure" } }]);
    }));
    it.live("observes settled calls with outcome and duration", () => Effect.gen(function* () {
        const events: Array<{
            phase: string;
            index: number;
            name: string;
            outcome?: string;
            message?: string;
        }> = [];
        const lookup = Tool.make({
            description: "Look up a value",
            input: Schema.Struct({ query: Schema.String }),
            output: Schema.String,
            run: ({ query }) => (query === "boom" ? Effect.fail(toolRefusal("Lookup refused")) : Effect.succeed(query)),
        });
        const runtime = Program.make({
            tools: { context: { lookup } },
            onToolCallStart: (call) => Effect.sync(() => {
                events.push({ phase: "start", index: call.index, name: call.name });
            }),
            onToolCallEnd: (call) => Effect.sync(() => {
                expect(call.durationMs).toBeGreaterThanOrEqual(0);
                events.push({
                    phase: "end",
                    index: call.index,
                    name: call.name,
                    outcome: call.outcome,
                    ...(call.message === undefined ? {} : { message: call.message }),
                });
            }),
        });
        const success = (yield* runtime.execute(`return await tools.context.lookup({ query: "ok" })`));
        expect(success.ok).toBe(true);
        const failure = (yield* runtime.execute(`return await tools.context.lookup({ query: "boom" })`));
        expect(failure.ok).toBe(false);
        expect(events).toStrictEqual([
            { phase: "start", index: 0, name: "context.lookup" },
            { phase: "end", index: 0, name: "context.lookup", outcome: "success" },
            { phase: "start", index: 0, name: "context.lookup" },
            { phase: "end", index: 0, name: "context.lookup", outcome: "failure", message: "Lookup refused" },
        ]);
    }));
});
describe("Program console capture", () => {
    it.live("captures console output as bounded result logs", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        const returned = console.log("Thread info:", { name: "Demo", count: 2 })
        console.warn("careful")
        return returned
      `,
        }));
        expect(result).toStrictEqual({
            ok: true,
            value: null,
            logs: ['Thread info: {"name":"Demo","count":2}', "[warn] careful"],
            toolCalls: [],
        });
        expect(Schema.decodeUnknownSync(Program.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result);
    }));
    it.live("keeps logs captured before failures", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.log("before failure")
        throw new Error("boom")
      `,
        }));
        expect(result.ok ? undefined : result.logs).toStrictEqual(["before failure"]);
        expect(result.ok ? undefined : result.error.message).toBe("Uncaught: boom");
    }));
    it.live("prints NaN and Infinity literally instead of the JSON null", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.log(NaN)
        console.log(Infinity, -Infinity)
        console.log({ ratio: NaN, bounds: [Infinity] })
        return null
      `,
        }));
        expect(result.ok).toBe(true);
        expect(result.logs).toStrictEqual(["NaN", "Infinity -Infinity", '{"ratio":NaN,"bounds":[Infinity]}']);
    }));
    it.live("renders sandbox values nested inside logged containers", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.log({ m: new Map([["a", 1]]), when: new Date(0), r: /ab/g, s: new Set([1, 2]) })
        console.log([new Date(0)])
        return null
      `,
        }));
        expect(result.ok).toBe(true);
        expect(result.logs).toStrictEqual([
            '{"m":Map(1) [["a",1]],"when":1970-01-01T00:00:00.000Z,"r":/ab/g,"s":Set(2) [1,2]}',
            "[1970-01-01T00:00:00.000Z]",
        ]);
    }));
    it.live("console formatting is total: cycles and opaque references render as markers", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        const m = new Map()
        m.set("self", m)
        console.log({ box: m })
        console.log({ fn: (x) => x, ok: 1 })
        return null
      `,
        }));
        expect(result.ok).toBe(true);
        expect(result.logs).toStrictEqual(['{"box":Map(1) [["self",[Circular]]]}', '{"fn":[Program reference],"ok":1}']);
    }));
    it.live("console.table renders sandbox value cells", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.table([{ when: new Date(0), n: NaN }])
        return null
      `,
        }));
        expect(result.ok).toBe(true);
        expect(result.logs).toStrictEqual(["(index)\twhen\tn\n0\t1970-01-01T00:00:00.000Z\tNaN"]);
    }));
    it.live("captures console.dir and console.table output", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.dir({ nested: { ok: true } })
        console.table([
          { name: "Kit", count: 1, hidden: "x" },
          { name: "Olive", count: 2, hidden: "y" }
        ], ["name", "count"])
        return "done"
      `,
        }));
        expect(result).toStrictEqual({
            ok: true,
            value: "done",
            logs: ['{"nested":{"ok":true}}', "(index)\tname\tcount\n0\tKit\t1\n1\tOlive\t2"],
            toolCalls: [],
        });
    }));
});
describe("Program output budget", () => {
    it.live("absent maxOutputBytes means no truncation at all", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `console.log("z".repeat(50_000)); return "x".repeat(100_000)`,
        }));
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.truncated).toBeUndefined();
        expect(result.value).toBe("x".repeat(100000));
        expect(result.logs).toStrictEqual(["z".repeat(50000)]);
    }));
    it.live("truncates an oversized result value with a marker instead of failing", () => Effect.gen(function* () {
        const limits: Program.ExecutionLimits = { maxOutputBytes: 40 };
        const result = (yield* Program.execute({
            code: `return { data: "${"x".repeat(200)}" }`,
            limits,
        }));
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.truncated).toBe(true);
        expect(typeof result.value).toBe("string");
        expect(result.value).toMatch(/^\{"data":"x+ \[result truncated: \d+ bytes exceeds the 40-byte output limit; return a smaller value\]$/);
        expect(Schema.decodeUnknownSync(Program.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result);
    }));
    it.live("keeps leading logs within the remaining budget and marks the cut", () => Effect.gen(function* () {
        const limits: Program.ExecutionLimits = { maxOutputBytes: 40 };
        const result = (yield* Program.execute({
            code: `
        console.log("first line")
        console.log("${"y".repeat(200)}")
        return "ok"
      `,
            limits,
        }));
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.value).toBe("ok");
        expect(result.truncated).toBe(true);
        expect(result.logs).toStrictEqual(["first line", "[logs truncated: showing 1 of 2 lines]"]);
    }));
    it.live("does not mark results within the budget", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `
        console.log("fits")
        return { fits: true }
      `,
        }));
        expect(result).toStrictEqual({
            ok: true,
            value: { fits: true },
            logs: ["fits"],
            toolCalls: [],
        });
    }));
});
describe("Program schema flexibility", () => {
    it.live("accepts render-only JSON Schema input and omitted output", () => Effect.gen(function* () {
        const observed: Array<unknown> = [];
        const call = Tool.make({
            description: "Call an adapter-described tool",
            input: {
                type: "object",
                properties: { id: { type: "string" }, count: { type: "number" } },
                required: ["id"],
            },
            run: (input) => Effect.sync(() => {
                observed.push(input);
                return { echoed: input };
            }),
        });
        const runtime = Program.make({ tools: { adapter: { call } } });
        expect(runtime.catalog()).toStrictEqual([
            {
                path: "adapter.call",
                description: "Call an adapter-described tool",
                signature: "tools.adapter.call(input: {\n  id: string,\n  count?: number,\n}): Promise<unknown>",
            },
        ]);
        // JSON Schema is render-only: mistyped input passes through unvalidated.
        const result = (yield* runtime.execute(`return await tools.adapter.call({ id: 42 })`));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.value).toStrictEqual({ echoed: { id: 42 } });
        expect(observed).toStrictEqual([{ id: 42 }]);
    }));
    it.live("renders JSON Schema outputs and $defs references", () => Effect.gen(function* () {
        const lookup = Tool.make({
            description: "Look up a user",
            input: { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
            output: {
                $ref: "#/$defs/User",
                $defs: {
                    User: {
                        type: "object",
                        properties: { login: { type: "string" }, id: { type: "number" } },
                        required: ["login", "id"],
                    },
                },
            },
            run: () => Effect.succeed({ login: "kit", id: 7 }),
        });
        const runtime = Program.make({ tools: { users: { lookup } } });
        expect(runtime.catalog()).toStrictEqual([
            {
                path: "users.lookup",
                description: "Look up a user",
                signature: "tools.users.lookup(input: {\n  login: string,\n}): Promise<{\n  login: string,\n  id: number,\n}>",
            },
        ]);
        const result = (yield* runtime.execute(`return await tools.users.lookup({ login: "kit" })`));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.value).toStrictEqual({ login: "kit", id: 7 });
    }));
    it.live("Effect Schema output without an input transform still renders unknown when omitted", () => Effect.gen(function* () {
        const ping = Tool.make({
            description: "Ping",
            input: Schema.Struct({ host: Schema.String }),
            run: () => Effect.succeed("pong"),
        });
        const runtime = Program.make({ tools: { net: { ping } } });
        expect(runtime.catalog()[0]?.signature).toBe("tools.net.ping(input: {\n  host: string,\n}): Promise<unknown>");
        const result = (yield* runtime.execute(`return await tools.net.ping({ host: "example.test" })`));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.value).toBe("pong");
    }));
});
describe("Program public contract", () => {
    const lookup = Tool.make({
        description: "Look up an order by ID",
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.Struct({ id: Schema.String, status: Schema.String }),
        run: ({ id }) => Effect.succeed({ id, status: "open" }),
    });
    const tools = { orders: { lookup } };
    const source = `return await tools.orders.lookup({ id: "order_42" })`;
    it.live("keeps one-shot and reusable execution equivalent", () => Effect.gen(function* () {
        const runtime = Program.make({ tools });
        const [oneShot, reusable] = (yield* Effect.all([
            Program.execute({ tools, code: source }),
            runtime.execute(source),
        ]));
        expect(reusable).toStrictEqual(oneShot);
        const input: Program.Input = { code: source };
        expect(Schema.decodeUnknownSync(Program.Input)(input)).toStrictEqual(input);
        expect(Schema.decodeUnknownSync(Program.Result)(JSON.parse(JSON.stringify(reusable)))).toStrictEqual(reusable);
    }));
    it.live("inlines a COMPLETE small catalog and keeps search registered but unadvertised", () => Effect.gen(function* () {
        const runtime = Program.make({ tools });
        expect(runtime.catalog()).toStrictEqual([
            {
                path: "orders.lookup",
                description: "Look up an order by ID",
                signature: "tools.orders.lookup(input: {\n  id: string,\n}): Promise<{\n  id: string,\n  status: string,\n}>",
            },
        ]);
        expect(runtime.instructions()).toContain("Available tools (COMPLETE list");
        expect(runtime.instructions()).toContain("- orders (1 tool)");
        expect(runtime.instructions()).toContain("  - tools.orders.lookup(input: {\n  id: string,\n}): Promise<{\n  id: string,\n  status: string,\n}> // Look up an order by ID");
        // A fully inlined catalog does not advertise search in the instructions...
        expect(runtime.instructions()).not.toMatch(/\$program/);
        // ...but the search tool stays registered, so a speculative call still works with the
        // same signature as the inline catalog.
        const result = (yield* runtime.execute(`return await tools.$program.search({ query: "order" })`));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toStrictEqual({
                items: [
                    {
                        path: "tools.orders.lookup",
                        description: "Look up an order by ID",
                        signature: "tools.orders.lookup(input: {\n  id: string,\n}): Promise<{\n  id: string,\n  status: string,\n}>",
                    },
                ],
                remaining: 0,
                next: null,
            });
        }
    }));
    it.live("renders bracket notation for tool names that are not JavaScript identifiers", () => Effect.gen(function* () {
        const resolveLibrary = Tool.make({
            description: "Resolve a library ID",
            input: Schema.Struct({ libraryName: Schema.String }),
            output: Schema.String,
            run: ({ libraryName }) => Effect.succeed(`/resolved/${libraryName}`),
        });
        const runtime = Program.make({ tools: { context7: { "resolve-library-id": resolveLibrary } } });
        expect(runtime.catalog()).toStrictEqual([
            {
                path: "context7.resolve-library-id",
                description: "Resolve a library ID",
                signature: 'tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): Promise<string>',
            },
        ]);
        expect(runtime.instructions()).toContain('tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): Promise<string>');
        const search = (yield* runtime.execute(`return await tools.$program.search({ query: "resolve library id" })`));
        expect(search.ok).toBe(true);
        if (search.ok) {
            expect(search.value).toStrictEqual({
                items: [
                    {
                        path: 'tools.context7["resolve-library-id"]',
                        description: "Resolve a library ID",
                        signature: 'tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): Promise<string>',
                    },
                ],
                remaining: 0,
                next: null,
            });
        }
        const call = (yield* runtime.execute(`return await tools.context7["resolve-library-id"]({ libraryName: "TypeScript" })`));
        expect(call.ok).toBe(true);
        if (call.ok)
            expect(call.value).toBe("/resolved/TypeScript");
        const exact = (yield* runtime.execute(`return await tools.$program.search({ query: 'tools.context7["resolve-library-id"]' })`));
        expect(exact.ok).toBe(true);
        if (exact.ok)
            expect(exact.value).toMatchObject({ remaining: 0, next: null });
    }));
    it("instructions use markdown sections with placeholder-only call forms", () => {
        const runtime = Program.make({ tools });
        const instructions = runtime.instructions();
        // Sections in order: workflow at the top, catalog at the bottom.
        expect(instructions).toContain("## Workflow");
        expect(instructions).toContain("## Rules");
        expect(instructions).toContain("## Language");
        expect(instructions.indexOf("## Workflow")).toBeLessThan(instructions.indexOf("## Rules"));
        expect(instructions.indexOf("## Rules")).toBeLessThan(instructions.indexOf("## Language"));
        expect(instructions.indexOf("## Language")).toBeLessThan(instructions.indexOf("\n## Available tools (COMPLETE list"));
        expect(instructions).not.toContain("JSON.parse(res)");
        expect(instructions).toContain("Return only the fields you need");
        expect(instructions).toContain("avoid returning large raw payloads");
        expect(instructions).toContain("Do not infer or normalize tool names");
        expect(instructions).toContain("bracket notation and quotes are part of the path");
        expect(instructions).toContain("surrounding agent tools are not available");
        expect(instructions).toContain("Only program tools listed here and internal runtime tools");
        // Placeholders use generic namespace/tool/field names only - no fabricated real tools
        // and no real catalog tools cherry-picked into example lines.
        expect(instructions).toContain("`const result = await tools.<namespace>.<tool>(input)`");
        expect(instructions).toContain("Return only the fields you need from structured results");
        expect(instructions).toContain("check that it is a non-null object and not an array");
        expect(instructions).not.toContain("result.<field>");
        expect(instructions).not.toContain("data.<field>");
        expect(instructions).not.toContain("total_count");
        expect(instructions).not.toContain("list_issues");
        expect(instructions).not.toContain("tools.orders.lookup({");
        // COMPLETE: step 1 picks from the inlined list; search is not advertised.
        expect(instructions).toContain("1. Pick a tool from the list under `## Available tools`");
        expect(instructions).not.toContain("Browse one namespace");
        const partial = Program.make({ tools, discovery: { catalogBudget: 0 } }).instructions();
        // PARTIAL: the workflow starts with search (with query-style guidance that is clearly
        // a query string, never a tool name) and the browse-namespace rule appears.
        expect(partial).toContain('1. If needed, discover tools: `return await tools.$program.search({ query: "<intent + key nouns>" })`.');
        expect(partial).toContain("In the next execution, copy a returned path exactly");
        expect(partial).toContain("Only program tools listed here or returned by `tools.$program.search` and internal runtime tools");
        expect(partial).toContain('- Browse one namespace: `await tools.$program.search({ query: "", namespace: "<name>" })`.');
        expect(partial).toContain("repeat the same search with `offset: next.offset`");
        expect(partial).toContain("  limit?: number,\n  offset?: number,");
        expect(partial).not.toContain("total_count");
        expect(partial).not.toContain("tools.orders.lookup({");
    });
    it("the language section describes the restricted runtime without overclaiming", () => {
        const instructions = Program.make({ tools }).instructions();
        expect(instructions).toContain("restricted JavaScript language for calling tools");
        expect(instructions).toContain("not a general-purpose runtime");
        expect(instructions).not.toContain("Standard modern JavaScript works");
        expect(instructions).not.toContain("TypeScript type annotations");
        for (const missing of ["Modules/imports", "classes", "generators", "fetch", "promise chaining"]) {
            expect(instructions).toContain(missing);
        }
        expect(instructions).toContain("URL, URLSearchParams, and URI encoding helpers");
        expect(instructions).not.toContain("host globals");
        expect(instructions).toContain("Use program tools for external operations");
        expect(instructions).toContain("Dates and URLs serialize to strings at data boundaries; Map/Set/RegExp/URLSearchParams serialize to `{}`.");
    });
    it("zero tools keep minimal sections and the no-tools notice", () => {
        const runtime = Program.make({});
        const instructions = runtime.instructions();
        expect(instructions).toContain("No tools are currently available.");
        expect(instructions).toContain("## Language");
        expect(instructions).toContain("## Available tools");
        expect(instructions).not.toContain("## Workflow");
        expect(instructions).not.toContain("## Rules");
        expect(instructions).not.toMatch(/\$program/);
    });
    it.live("uses one ranked search returning complete definitions for large catalogs", () => Effect.gen(function* () {
        const upload = Tool.make({
            description: "Upload one readable local file to the current Discord thread",
            input: Schema.Struct({ path: Schema.String }),
            output: Schema.Struct({ sent: Schema.Boolean }),
            run: () => Effect.succeed({ sent: true }),
        });
        const generate = Tool.make({
            description: "Generate an image and upload it to the current Discord thread",
            input: Schema.Struct({ prompt: Schema.String }),
            output: Schema.Struct({ sent: Schema.Boolean }),
            run: () => Effect.succeed({ sent: true }),
        });
        const runtime = Program.make({
            tools: { thread: { uploadFile: upload, generateImage: generate }, orders: { lookup } },
            discovery: { catalogBudget: 0 },
        });
        expect(runtime.instructions()).toContain("Available tools (PARTIAL - 0 of 3 shown; find the rest with tools.$program.search)");
        expect(runtime.instructions()).toContain("- thread (2 tools, none shown)");
        expect(runtime.instructions()).toContain("- orders (1 tool, none shown)");
        expect(runtime.instructions()).toMatch(/\$program\.search/);
        expect(runtime.instructions()).not.toMatch(/tools\.thread\.uploadFile\(input/);
        const result = (yield* runtime.execute(`
      return await tools.$program.search({
        query: "send message attachment upload file to current Discord thread",
        limit: 2
      })
    `));
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.value).toStrictEqual({
            items: [
                {
                    path: "tools.thread.uploadFile",
                    description: "Upload one readable local file to the current Discord thread",
                    signature: "tools.thread.uploadFile(input: {\n  path: string,\n}): Promise<{\n  sent: boolean,\n}>",
                },
                {
                    path: "tools.thread.generateImage",
                    description: "Generate an image and upload it to the current Discord thread",
                    signature: "tools.thread.generateImage(input: {\n  prompt: string,\n}): Promise<{\n  sent: boolean,\n}>",
                },
            ],
            remaining: 0,
            next: null,
        });
        expect(result.toolCalls).toStrictEqual([{ name: "$program.search" }]);
        const variants = (yield* runtime.execute(`
      return await Promise.all([
        tools.$program.search({ query: "file" }),
        tools.$program.search({ query: "image" })
      ])
    `));
        expect(variants.ok).toBe(true);
        if (variants.ok) {
            expect((variants.value as Array<{
                items: Array<{
                    path: string;
                }>;
            }>)[0]?.items[0]?.path).toBe("tools.thread.uploadFile");
            expect((variants.value as Array<{
                items: Array<{
                    path: string;
                }>;
            }>)[1]?.items[0]?.path).toBe("tools.thread.generateImage");
        }
        const removed = (yield* runtime.execute(`return await tools.$program.describe({ path: "thread.uploadFile" })`));
        expect(removed.ok).toBe(false);
        if (!removed.ok)
            expect(removed.error.kind).toBe("UnknownTool");
    }));
    it.live("search defaults to 10 results and resolves exact tool paths", () => Effect.gen(function* () {
        const tool = (index: number) => Tool.make({
            description: `Numbered tool ${index}`,
            input: Schema.Struct({ id: Schema.String }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        const runtime = Program.make({
            tools: {
                many: Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`tool${index}`, tool(index)])),
            },
        });
        const browse = (yield* runtime.execute(`return await tools.$program.search({})`));
        expect(browse.ok).toBe(true);
        if (browse.ok) {
            const value = browse.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
                next: {
                    offset: number;
                } | null;
            };
            expect(value.items).toHaveLength(10);
            expect(value.remaining).toBe(4);
            expect(value.next).toStrictEqual({ offset: 10 });
        }
        for (const query of ["many.tool13", "tools.many.tool13"]) {
            const exact = (yield* runtime.execute(`return await tools.$program.search({ query: ${JSON.stringify(query)} })`));
            expect(exact.ok).toBe(true);
            if (exact.ok) {
                expect(exact.value).toStrictEqual({
                    items: [
                        {
                            path: "tools.many.tool13",
                            description: "Numbered tool 13",
                            signature: "tools.many.tool13(input: {\n  id: string,\n}): Promise<string>",
                        },
                    ],
                    remaining: 0,
                    next: null,
                });
            }
        }
    }));
    it.live("scopes search to one namespace and browses it alphabetically", () => Effect.gen(function* () {
        const simple = (description: string) => Tool.make({
            description,
            input: Schema.Struct({ id: Schema.String }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        const runtime = Program.make({
            tools: {
                github: { list_issues: simple("List issues"), create_issue: simple("Create an issue") },
                linear: { list_issues: simple("List Linear issues") },
            },
        });
        // Empty query + namespace browses just that namespace, alphabetical by path.
        const browse = (yield* runtime.execute(`return await tools.$program.search({ query: "", namespace: "github" })`));
        expect(browse.ok).toBe(true);
        if (browse.ok) {
            const value = browse.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items.map((item) => item.path)).toStrictEqual([
                "tools.github.create_issue",
                "tools.github.list_issues",
            ]);
        }
        // A query + namespace ranks within that namespace only.
        const scoped = (yield* runtime.execute(`return await tools.$program.search({ query: "issues", namespace: "linear" })`));
        expect(scoped.ok).toBe(true);
        if (scoped.ok) {
            const value = scoped.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items[0]?.path).toBe("tools.linear.list_issues");
        }
        const invalid = (yield* runtime.execute(`return await tools.$program.search({ query: "issues", namespace: 7 })`));
        expect(invalid.ok).toBe(false);
        if (!invalid.ok)
            expect(invalid.error.kind).toBe("InvalidToolInput");
    }));
    it.live("matches input parameter names and partial-word substrings", () => Effect.gen(function* () {
        const upload = Tool.make({
            description: "Send a document to the workspace",
            input: {
                type: "object",
                properties: { attachment: { type: "string", description: "Local path of the payload to send" } },
                required: ["attachment"],
            },
            run: () => Effect.succeed("ok"),
        });
        const other = Tool.make({
            description: "Rename the workspace",
            input: Schema.Struct({ name: Schema.String }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        const runtime = Program.make({ tools: { files: { upload, other } } });
        // "attachment" appears in neither path nor description - only in the input schema's
        // property names, which the searchable text includes.
        const byParameter = (yield* runtime.execute(`return await tools.$program.search({ query: "attachment" })`));
        expect(byParameter.ok).toBe(true);
        if (byParameter.ok) {
            const value = byParameter.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items[0]?.path).toBe("tools.files.upload");
        }
        // Substring matching: a partial word ("docum") still hits the description.
        const bySubstring = (yield* runtime.execute(`return await tools.$program.search({ query: "docum" })`));
        expect(bySubstring.ok).toBe(true);
        if (bySubstring.ok) {
            const value = bySubstring.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items[0]?.path).toBe("tools.files.upload");
        }
    }));
    it.live("a plural query term matches singular-only tool text", () => Effect.gen(function* () {
        const simple = (description: string) => Tool.make({
            description,
            input: Schema.Struct({ id: Schema.String }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        const runtime = Program.make({
            tools: {
                // Neither path nor description contains "issues" - only the singular "issue".
                tracker: { fetch_all: simple("Fetch every open issue in the project") },
                github: { list_issues: simple("List issues") },
                misc: { rename: simple("Rename the workspace") },
            },
        });
        // "issues" still finds the singular-only tool (term OR singular(term) per field)...
        const plural = (yield* runtime.execute(`return await tools.$program.search({ query: "issues", namespace: "tracker" })`));
        expect(plural.ok).toBe(true);
        if (plural.ok) {
            const value = plural.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items[0]?.path).toBe("tools.tracker.fetch_all");
        }
        // ...while a true "issues" path match still outranks the singular-only description match.
        const ranked = (yield* runtime.execute(`return await tools.$program.search({ query: "issues" })`));
        expect(ranked.ok).toBe(true);
        if (ranked.ok) {
            const value = ranked.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
            };
            expect(value.remaining).toBe(0);
            expect(value.items.map((item) => item.path)).toStrictEqual([
                "tools.github.list_issues",
                "tools.tracker.fetch_all",
            ]);
        }
    }));
    it.live("empty query lists everything alphabetically by path", () => Effect.gen(function* () {
        const simple = (description: string) => Tool.make({
            description,
            input: Schema.Struct({}),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        // Deliberately declared out of alphabetical order.
        const runtime = Program.make({
            tools: {
                zeta: { last: simple("Last") },
                alpha: { beta: simple("Middle"), aardvark: simple("First") },
            },
        });
        const browse = (yield* runtime.execute(`return await tools.$program.search({})`));
        expect(browse.ok).toBe(true);
        if (browse.ok) {
            const value = browse.value as {
                items: Array<{
                    path: string;
                }>;
                remaining: number;
                next: unknown;
            };
            expect(value.items.map((item) => item.path)).toStrictEqual([
                "tools.alpha.aardvark",
                "tools.alpha.beta",
                "tools.zeta.last",
            ]);
            expect(value.remaining).toBe(0);
            expect(value.next).toBeNull();
        }
        const middle = (yield* runtime.execute(`return await tools.$program.search({ limit: 1, offset: 1 })`));
        expect(middle.ok).toBe(true);
        if (middle.ok) {
            expect(middle.value).toMatchObject({
                items: [{ path: "tools.alpha.beta" }],
                remaining: 1,
                next: { offset: 2 },
            });
        }
        const exhausted = (yield* runtime.execute(`return await tools.$program.search({ limit: 1, offset: 3 })`));
        expect(exhausted.ok).toBe(true);
        if (exhausted.ok)
            expect(exhausted.value).toStrictEqual({ items: [], remaining: 0, next: null });
    }));
    it("inlines round-robin across namespaces so one expensive namespace cannot starve the rest", () => {
        const cheap = Tool.make({
            description: "Cheap",
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        const expensive = Tool.make({
            description: "An expensive tool whose description alone consumes far more than the remaining inline catalog byte budget for this runtime",
            input: Schema.Struct({
                someRatherLongParameterName: Schema.String,
                anotherEvenLongerParameterName: Schema.Number,
            }),
            output: Schema.String,
            run: () => Effect.succeed("ok"),
        });
        // Round 1 places alpha.cheap (~17 estimated tokens) and beta.cheap (~17); in round 2
        // alpha.expensive does not fit, which marks only alpha done - it must NOT prevent
        // other namespaces from inlining (beta already got its line in the same round).
        const runtime = Program.make({
            tools: { alpha: { cheap, expensive }, beta: { cheap } },
            discovery: { catalogBudget: 40 },
        });
        const instructions = runtime.instructions();
        expect(instructions).toContain("Available tools (PARTIAL - 2 of 3 shown; find the rest with tools.$program.search)");
        expect(instructions).toContain("- alpha (2 tools, 1 shown)");
        expect(instructions).toContain("  - tools.alpha.cheap(input: {\n  q: string,\n}): Promise<string> // Cheap");
        expect(instructions).not.toContain("tools.alpha.expensive(");
        // Fully shown namespaces read cleanly (no "shown" annotation).
        expect(instructions).toContain("- beta (1 tool)");
        expect(instructions).toContain("  - tools.beta.cheap(input: {\n  q: string,\n}): Promise<string> // Cheap");
        expect(instructions).toMatch(/\$program\.search/);
    });
    it("charges inline JSDoc against the catalog token budget", () => {
        const documented = Tool.make({
            description: "Look up a record",
            input: {
                type: "object",
                properties: {
                    id: { type: "string", description: "A detailed identifier description. ".repeat(20) },
                },
                required: ["id"],
            } as const,
            run: () => Effect.succeed("ok"),
        });
        const runtime = Program.make({
            tools: { records: { lookup: documented } },
            discovery: { catalogBudget: 40 },
        });
        expect(runtime.catalog()[0]?.signature).toContain("/** A detailed identifier description.");
        expect(runtime.instructions()).toContain("Available tools (PARTIAL - 0 of 1 shown; find the rest with tools.$program.search)");
        expect(runtime.instructions()).not.toContain("tools.records.lookup(input:");
    });
    it.live("decodes tool input and output before exposing either side", () => Effect.gen(function* () {
        const observed: Array<unknown> = [];
        const transformed = Tool.make({
            description: "Double a number",
            input: Schema.Struct({ value: Schema.NumberFromString }),
            output: Schema.NumberFromString,
            run: ({ value }) => Effect.sync(() => {
                observed.push(value);
                return String(value * 2);
            }),
        });
        const runtime = Program.make({
            tools: { math: { double: transformed } },
            onToolCallStart: (call) => Effect.sync(() => observed.push(call.input)),
        });
        const success = (yield* runtime.execute(`return await tools.math.double({ value: "21" })`));
        expect(success).toStrictEqual({ ok: true, value: 42, toolCalls: [{ name: "math.double" }] });
        expect(observed).toStrictEqual([{ value: 21 }, 21]);
        const invalid = (yield* runtime.execute(`return await tools.math.double({ value: 21 })`));
        expect(invalid.ok).toBe(false);
        if (invalid.ok)
            return;
        expect(invalid.error.kind).toBe("InvalidToolInput");
        expect(observed).toStrictEqual([{ value: 21 }, 21]);
    }));
    it.live("returns JSON-safe data and normalizes undefined to null", () => Effect.gen(function* () {
        const result = (yield* Program.execute({
            code: `return { top: undefined, nested: [1, undefined] }`,
        }));
        expect(result).toStrictEqual({
            ok: true,
            value: { top: null, nested: [1, null] },
            toolCalls: [],
        });
        expect(Schema.decodeUnknownSync(Program.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result);
    }));
    it.live("rejects invalid configuration and discovery limits", () => Effect.gen(function* () {
        expect(() => Program.execute({ code: "return 1", limits: { timeoutMs: 0 } })).toThrow(RangeError);
        expect(() => Program.execute({ code: "return 1", limits: { timeoutMs: Number.POSITIVE_INFINITY } })).toThrow(RangeError);
        expect(() => Program.execute({ code: "return 1", limits: { maxToolCalls: -1 } })).toThrow(RangeError);
        expect(() => Program.execute({ code: "return 1", limits: { maxOutputBytes: -1 } })).toThrow(RangeError);
        expect(() => Program.make({ tools, discovery: { catalogBudget: -1 } })).toThrow(RangeError);
        const result = (yield* Program.make({
            tools,
            discovery: { catalogBudget: 0 },
        }).execute(`return await tools.$program.search({ query: "order", limit: 0.5 })`));
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error.kind).toBe("InvalidToolInput");
        for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            const invalidOffset = (yield* Program.make({ tools }).execute(`return await tools.$program.search({ query: "order", offset: ${JSON.stringify(offset)} })`));
            expect(invalidOffset.ok).toBe(false);
            if (!invalidOffset.ok)
                expect(invalidOffset.error.kind).toBe("InvalidToolInput");
        }
    }));
    it.live("enforces the tool-call limit as a diagnostic", () => Effect.gen(function* () {
        const result = (yield* Program.execute({ tools, code: source, limits: { maxToolCalls: 0 } }));
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.kind).toBe("ToolCallLimitExceeded");
    }));
    it.live("timeoutMs and maxToolCalls have no defaults: absent means unlimited", () => Effect.gen(function* () {
        // 150 tool calls would have exceeded the old default cap of 100; with no limits
        // provided, there is no cap and no timeout - budgets are host policy.
        const counter = Tool.make({
            description: "Count invocations",
            input: Schema.Struct({}),
            output: Schema.Number,
            run: () => Effect.succeed(1),
        });
        const result = (yield* Program.execute({
            tools: { host: { count: counter } },
            code: `
        let total = 0
        for (let i = 0; i < 150; i += 1) total += await tools.host.count({})
        return total
      `,
        }));
        expect(result).toMatchObject({ ok: true, value: 150 });
        if (result.ok)
            expect(result.toolCalls.length).toBe(150);
    }));
    it.live("the timeout interrupts a busy loop without any operation budget", () => Effect.gen(function* () {
        // Regression: timeout interruption must not depend on interpreter-side work accounting.
        // The Effect fiber runtime auto-yields between interpreter steps, so a pure `while
        // (true) {}` loop is interrupted by `timeoutMs` alone.
        const startedAt = Date.now();
        const result = (yield* Program.execute({ code: "while (true) {}", limits: { timeoutMs: 200 } }));
        const elapsedMs = Date.now() - startedAt;
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe("TimeoutExceeded");
            expect(result.error.message).toContain("timed out after 200ms");
        }
        expect(elapsedMs).toBeLessThan(3000);
    }));
    it("reserves the discovery namespace", () => {
        expect(() => Program.make({ tools: { $program: { lookup } } })).toThrow(/reserved for Program discovery tools/);
    });
});
