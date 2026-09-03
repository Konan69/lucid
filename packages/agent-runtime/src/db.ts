import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sqlite } from "@flue/runtime/node";

export const databasePath = resolve(
  process.env.KONAN_RUNTIME_DB ?? "./.state/flue.sqlite",
);

mkdirSync(dirname(databasePath), { recursive: true });

export default sqlite(databasePath);
