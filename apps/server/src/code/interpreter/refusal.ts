/** Ported from opencode `packages/codemode/src/tool-error.ts` at 3884062 (MIT). */
import { Schema } from "effect"

/** Safe operational refusal from a standard tool pack, reported as `ToolFailure`. */
export class ToolRefusal extends Schema.TaggedError<ToolRefusal>()("ToolRefusal", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Creates a tool refusal whose message is safe to include in an execution diagnostic. */
export const toolRefusal = (message: string, cause?: unknown): ToolRefusal =>
  new ToolRefusal({ message, ...(cause === undefined ? {} : { cause }) })
