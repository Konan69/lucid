import fs from "node:fs";
import path from "node:path";
import { effect, reactivity, log } from "./load.mjs";
const root = process.argv[2];
for (const name of ["Machine", "State", "Mailbox"]) log(`${name}.rootModuleExists`, fs.existsSync(path.join(root, "src", `${name}.ts`)));
for (const name of ["fork", "forkChild", "forkScoped", "forkIn", "timeout", "timeoutOption", "timeoutTo", "timeoutOrElse"]) log(`Effect.${name}.exists`, name in effect.Effect);
for (const name of ["callback", "async", "interruptWhen", "haltWhen", "share", "broadcast", "broadcastN"]) log(`Stream.${name}.exists`, name in effect.Stream);
for (const name of ["Atom", "AtomRegistry", "AtomRpc", "AtomHttpApi", "Reactivity"]) log(`reactivity.${name}.exists`, name in reactivity);
for (const group of ["workflow", "cluster", "unstable"]) log(`${group}.sourceDirectoryExists`, fs.existsSync(path.join(root, "src", group)));
