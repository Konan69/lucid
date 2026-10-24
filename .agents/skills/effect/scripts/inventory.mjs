import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const [installedRepo, output, revision = "origin/main"] = process.argv.slice(2);
assert(installedRepo && output, "Pass the installed repository and output directory");
const require = createRequire(path.resolve(installedRepo, "package.json"));
const ts = require("typescript");
const clientRequire = createRequire(path.resolve(installedRepo, "packages/client/state/package.json"));
const packageFile = clientRequire.resolve("effect/package.json");
const root = path.dirname(packageFile);
assert.equal(JSON.parse(fs.readFileSync(packageFile, "utf8")).version, "4.0.2");
const sha = execFileSync("git", ["rev-parse", revision], { encoding: "utf8" }).trim();
const printer = ts.createPrinter({ removeComments: true });
const source = (relative) => ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true);
const groups = {
  lifetime: ["Effect", "Fiber", "FiberMap", "FiberSet", "FiberHandle", "Scope", "Exit", "Cause"],
  coordination: ["Deferred", "Latch", "Semaphore", "PartitionedSemaphore", "Queue", "PubSub", "SubscriptionRef", "Ref", "SynchronizedRef", "RcRef", "RcMap", "ScopedRef", "Pool", "Cache", "ScopedCache", "Request", "RequestResolver"],
  time: ["Schedule", "Clock", "testing/TestClock", "Duration"],
  stream: ["Stream"],
  transactions: ["TxRef", "TxDeferred", "TxSemaphore", "TxQueue", "TxPubSub", "TxSubscriptionRef", "TxPriorityQueue"]
};
for (const group of ["reactivity", "workflow", "cluster"]) {
  groups[group] = fs.readdirSync(path.join(root, "src", group)).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => `${group}/${f.slice(0, -3)}`);
}
const named = /Machine|State|Workflow|Activity|Cluster/;
const listed = new Set(Object.values(groups).flat());
function discover(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "internal") return [];
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return discover(path.join(directory, entry.name), relative + "/");
    if (!relative.endsWith(".ts") || relative.endsWith("index.ts")) return [];
    const module = relative.slice(0, -3);
    if (listed.has(module)) return [];
    const file = source(`src/${relative}`);
    return file.statements.some((node) => exported(node) && names(node).some((name) => named.test(name))) ? [module] : [];
  });
}
const effectCategories = new Set(["collecting", "repetition", "delays & timeouts", "racing", "resource management", "caching", "interruption", "forking", "transactions", "zipping"]);
const effectNames = new Set(["Retry", "retry", "retryOrElse", "request", "requestUnsafe", "RunOptions", "runFork", "runForkWith", "fiber", "fiberId", "clockWith", "callback", "never", "yieldNow", "yieldNowWith", "exit", "abortSignal"]);

/** Index token and qualified-name occurrences once, so all exports use the same immutable Git snapshot. */
function usages() {
  const result = new Map();
  const raw = execFileSync("git", ["grep", "-n", "-I", "-e", ".", sha, "--", "apps", "packages"], { encoding: "utf8", maxBuffer: 150_000_000 });
  for (const line of raw.split("\n")) {
    const match = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
    if (!match) continue;
    const [, file, number, text] = match;
    for (const token of new Set(text.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g))) {
      for (const key of new Set([token, ...token.split(".")])) {
        let entry = result.get(key);
        if (!entry) { entry = { count: 0, examples: [] }; result.set(key, entry); }
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(`${file}:${number}`);
      }
    }
  }
  return result;
}
const usage = usages();
const exported = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const bindingNames = (name) => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => bindingNames(element.name));
const names = (node) => ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap((d) => bindingNames(d.name)) : node.name ? [node.name.text] : [];

/** Keep source descriptions and declaration signatures separate. The declaration printer preserves all overloads and public model members. */
function entries(relative) {
  const src = source(`src/${relative}.ts`);
  const decl = source(`dist/${relative}.d.ts`);
  const descriptions = new Map();
  const declarations = new Map();
  for (const node of src.statements) {
    for (const name of names(node)) {
      if (!descriptions.has(name) || node.jsDoc?.[0]?.comment) descriptions.set(name, node);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const alias of node.exportClause.elements) descriptions.set(alias.name.text, alias);
    }
  }
  for (const node of decl.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const alias of node.exportClause.elements) {
        const original = descriptions.get(alias.name.text) ?? descriptions.get(alias.propertyName?.text);
        const declaration = decl.statements.find((s) => names(s).includes(alias.propertyName?.text ?? alias.name.text));
        assert(original && declaration, `${relative}.${alias.name.text} alias missing source or declaration`);
        declarations.set(alias.name.text, { original, signatures: [printer.printNode(ts.EmitHint.Unspecified, declaration, decl), `export { ${alias.getText(decl)} };`] });
      }
      continue;
    }
    if (!exported(node)) continue;
    for (const name of names(node)) {
      const original = descriptions.get(name);
      assert(original, `${relative}.${name} missing source`);
      if (groups.discovery.includes(relative) && !named.test(name)) continue;
      if (relative === "Effect") {
        const category = ts.getJSDocTags(original).find((t) => t.tagName.text === "category")?.comment;
        if (!effectCategories.has(category) && !effectNames.has(name)) continue;
      }
      const entry = declarations.get(name) ?? { original, signatures: [] };
      entry.signatures.push(printer.printNode(ts.EmitHint.Unspecified, node, decl));
      declarations.set(name, entry);
    }
  }
  return [...declarations].map(([name, { original, signatures }]) => {
    const doc = ts.getTextOfJSDocComment(original.jsDoc?.[0]?.comment);
    const description = typeof doc === "string" ? doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ") : "Public model or namespace. Its full declaration follows.";
    return { name, description, line: src.getLineAndCharacterOfPosition(original.getStart(src)).line + 1, signatures };
  });
}

/** Generate lookup pages behind one router. No generated page changes runtime code. */
function generate() {
  fs.mkdirSync(output, { recursive: true });
  const index = ["# Installed API inventory", "", `Effect 4.0.2. Vivid usage snapshot \`${sha}\`.`, "", "Generated by [inventory.mjs](../../scripts/inventory.mjs). Effect declarations and descriptions retain their [MIT license](../license.md). Signatures come from installed `dist/*.d.ts`; descriptions and line numbers come from `src/*.ts`. Overloads and public interface methods remain intact. A count is one distinct top-level exported name, including types and namespaces. Nested API members are included in the declarations but are not counted separately.", "", "Usage is lexical evidence, not a binding analysis. Each entry reports the namespace-qualified token and the bare name. A missing match does not prove absence because imports can be aliased. Examples can include comments or tests. Recheck the import before reusing an example. The source citation is relative to the resolved Effect package, not this repository.", "", "`Effect` includes every export in its collecting, repetition, delays and timeouts, racing, resource management, caching, interruption, forking, transaction, and zipping categories, plus the named retry, request, clock, fiber, callback and run options. Discovery modules include exports whose names contain Machine, State, Workflow, Activity, or Cluster. Other listed modules include every top-level export. The Effect selection also includes its local named export aliases. Public class and interface members are included verbatim in their declarations.", "", "| Area | Exports | Modules |", "| --- | ---: | --- |"];
  for (const [group, modules] of Object.entries(groups)) {
    let count = 0;
    const links = [];
    for (const relative of modules) {
      const module = path.basename(relative);
      const found = entries(relative);
      count += found.length;
      const file = `${group}/${module.toLowerCase()}.md`;
      links.push(`[${module}](${file})`);
      const moduleUsage = usage.get(module);
      const lines = [`# ${module}`, "", `Import \`effect/${relative}\`. Source \`effect@4.0.2/src/${relative}.ts\`.`, "", `Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.\n\nDistinct exports inventoried: ${found.length}. Module-name matches in Vivid: ${moduleUsage?.count ?? 0}. ${moduleUsage?.examples.join(", ") ?? "No bare-name match."}`, ""];
      for (const entry of found) {
        const qualified = usage.get(`${module}.${entry.name}`);
        const bare = usage.get(entry.name);
        lines.push(`## ${entry.name}`, "", entry.description.replaceAll("\u2014", ".").replaceAll("\u2013", "-"), "", `Source: \`effect@4.0.2/src/${relative}.ts:${entry.line}\`.`, "", `Vivid \`${module}.${entry.name}\` matches: ${qualified?.count ?? 0}. ${qualified?.examples.join(", ") ?? "No qualified match."} Bare-name matches: ${bare?.count ?? 0}. Aliased usage is unverified.`, "", "```ts", entry.signatures.join("\n"), "```", "");
      }
      fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
      fs.writeFileSync(path.join(output, file), lines.join("\n"));
    }
    console.log(`${group}: ${count} exports in ${modules.length} modules`);
    index.push(`| ${group} | ${count} | ${links.join(", ")} |`);
  }
  fs.writeFileSync(path.join(output, "index.md"), `${index.join("\n")}\n`);
}
groups.discovery = discover(path.join(root, "src"));
generate();

/** Render the hand-reviewed fit records beside the exhaustive declaration appendix. */
function renderFits() {
  const fits = JSON.parse(fs.readFileSync(new URL("./fits.json", import.meta.url), "utf8"));
  const lines = ["# Effect lifecycle and coordination capabilities", "", "Effect 4.0.2. This is an installed-source reference. General fit guidance comes before repository applications. [The declaration catalog](inventory/index.md) preserves every selected export, overload, option, and public model member with source file and line. [Runtime evidence](evidence.md) records the scripts, output, and limits.", "", "The catalog contains 1,598 distinct top-level exported names across 97 module pages. It includes complete coordination, Schedule, Duration, Stream, reactivity, workflow, and cluster modules. The Effect selection is explicit in the catalog index. Nested methods are present in declarations and excluded from the count. The additional discovery scan includes state-named exports outside those modules.", "", "## Source and reproduction", "", "Resolve `effect/package.json` from both `packages/client/state` and `apps/server` with `node -p \"require.resolve('effect/package.json')\"`. Both resolved the same `<repo>/node_modules/.pnpm/effect@4.0.2/node_modules/effect/package.json` in the investigation. The installed package exports `effect/reactivity`, `effect/workflow`, and `effect/cluster`. It has no `src/unstable` directory. Old imports from `effect/unstable` in the adjacent guidance are historical leads, not installed paths.", "", "Run these commands from the repository root. Pass a checkout with installed dependencies as `<installed-repo>`. Run the probes on a development box. Their second argument is the resolved Effect package directory.", "", "```bash", "node .agents/skills/effect/scripts/inventory.mjs <installed-repo> .agents/skills/effect/rules/inventory origin/main", "node .agents/skills/effect/scripts/probes/coordination.mjs <effect-package-directory>", "node .agents/skills/effect/scripts/probes/lifetime.mjs <effect-package-directory>", "node .agents/skills/effect/scripts/probes/time.mjs <effect-package-directory>", "node .agents/skills/effect/scripts/probes/atoms.mjs <effect-package-directory>", "node .agents/skills/effect/scripts/probes/presence.mjs <effect-package-directory>", "```", "", "The generator rejects any version other than 4.0.2. Its Git usage snapshot is immutable. Usage entries are lexical matches and may include comments, tests, or unrelated bindings. A missing qualified match leaves aliased use unverified. Re-run `git grep -n -w '<name>' <snapshot-sha> -- apps packages` and inspect imports before claiming an API is unused.", "", "## Capability index", ""];
  for (const fit of fits) {
    const id = fit.name.toLowerCase().replaceAll(/[^a-z0-9 -]/g, "").replaceAll(/ +/g, "-");
    lines.push(`- [${fit.name}](#${id}).`);
  }
  lines.push("", "## Capabilities", "");
  for (const fit of fits) {
    const [group, module] = fit.module.split("/");
    const file = `inventory/${group}/${module.toLowerCase()}.md`;
    const declarations = fs.readFileSync(path.join(output, group, `${module.toLowerCase()}.md`), "utf8");
    for (const name of fit.exports.split(" ")) assert(declarations.includes(`## ${name}\n`), `${fit.name}: missing ${module}.${name}`);
    lines.push(`### ${fit.name}`, "", `${fit.description} Source, signatures, and options are in [${module}](${file}). Related exports include ${fit.exports.split(" ").map((name) => `\`${name}\``).join(", ")}.`, "", `Good for: ${fit.good}`, "", `Not good for: ${fit.bad}`, "", `Observed behavior and limits: ${fit.observed}`, "", `Vivid: ${fit.vivid}`, "");
  }
  lines.push("## Vivid patterns", "", "The Vivid lines above name application candidates. A candidate is not a verified behavior-preserving replacement. The inspected source snapshot is `" + sha + "`. For getters, guards, type helpers, and unsafe adapter variants, fit belongs to their owning capability. No independent hand-rolled replacement is claimed for each support API.", "", "The strongest candidates are the recursive reconnect in `packages/client/state/src/live.ts:171`, the timer plus state pair in `apps/mobile/src/screen/chat/Choices.tsx:189`, the elapsed-time store in `packages/client/state/src/stream.ts:70`, the renewal timer in `apps/mobile/src/screen/computer/Live.tsx:75`, and retained child fibers in `apps/server/src/code/process.ts:371`. The renewal is a machine invoke using Clock and an explicit retry policy. A provider without a completion event can still need scheduled observation. The custom bounded FIFO in `apps/server/src/code/pool.ts:47` and the platform-specific weak family in `packages/client/state/src/live.ts:283` have extra guarantees that the nearest named module does not automatically replace.", "", "## Verification limits", "", "This investigation ran in-process SDK probes on Node, not Vivid product integration. It did not drive a phone, browser, database workflow, provider, or production system. Runtime behavior of unlisted cases remains unverified. A source description is not a guarantee of cross-process visibility, SQL commit order, exact-once execution, or native cancellation. Fresh-child skill routing and an independent cross-family review remain unverified because the task prohibits starting other agents.", "");
  fs.writeFileSync(path.join(output, "..", "primitives.md"), lines.join("\n"));
}
renderFits();
