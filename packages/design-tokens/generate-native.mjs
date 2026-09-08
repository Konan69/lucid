import { readFileSync, writeFileSync } from "node:fs";
const css = readFileSync(new URL("./src/tokens.css", import.meta.url), "utf8");
function declarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [
      key,
      value.trim(),
    ]),
  );
}
const base = declarations(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
const light = {
  ...base,
  ...declarations(
    css.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1],
  ),
};
function resolve(key, vars) {
  return vars[key].replace(/var\((--[\w-]+)\)/g, (_, name) =>
    resolve(name, vars),
  );
}
function native(vars) {
  const result = {};
  for (const key of Object.keys(vars)) {
    if (
      !/^--(surface-|ink$|ink-|line-|wash-|accent|status-|face-|scrim)/.test(
        key,
      ) ||
      key === "--ink-base"
    )
      continue;
    const value = resolve(key, vars).replace(
      /rgb\(([\d.]+) ([\d.]+) ([\d.]+)(?:\s*\/\s*([\d.]+))?\)/g,
      (_, r, g, b, a) =>
        a ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`,
    );
    result[key.slice(2)] = value;
  }
  return result;
}
const metrics = {};
for (const [key, value] of Object.entries(base)) {
  if (/^--(type-|weight-|leading-|dur-|.*-h$|.*-w$)/.test(key) && /^[\d.]+(?:px|ms)?$/.test(value))
    metrics[key.slice(2)] = Number.parseFloat(value);
  const radius = value.match(/^calc\(([\d.]+)px \* var\(--rf\)\)$/);
  if (key.startsWith("--radius-") && radius) metrics[key.slice(2)] = Number(radius[1]);
}
metrics["phone-radius-factor"] = Number(css.match(/:root\s*\{\s*--rf:\s*([\d.]+);/)[1]);
const output =
  "// Generated from tokens.css by generate-native.mjs. Do not hand edit.\nexport const nativeTokens = " +
  JSON.stringify({ dark: native(base), light: native(light) }, null, 2) +
  " as const;\n\nexport const nativeMetrics = " + JSON.stringify(metrics, null, 2) + " as const;\n";
const target = new URL("./src/native.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output)
    throw new Error(
      "Native tokens are stale. Run pnpm --filter @vivid/design-tokens generate:native",
    );
} else writeFileSync(target, output);
