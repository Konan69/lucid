import { type AstNode, InterpreterRuntimeError } from "./model.ts"
import { SandboxMap, SandboxSet } from "./values.ts"

/**
 * The most one built-in may make in a single step (characters of a string, elements of an
 * array). A built-in allocates before the interpreter can count what it made, so the ones whose
 * size comes from a number the program chose (`repeat`, `padStart`, `padEnd`, `Array.from` of an
 * array-like) are checked against this first.
 */
export const MAX_BUILT = 4_194_304

/** Refuses a single built-in whose result would be larger than `MAX_BUILT`. */
export const assertBuildable = (size: number, what: string, node: AstNode): void => {
  if (size > MAX_BUILT)
    throw new InterpreterRuntimeError(
      `${what} would make a value of ${size} items; the most one step may make is ${MAX_BUILT}.`,
      node,
      "WorkLimitExceeded",
    )
}

/** How much one execution may compute. Absent means unlimited, as for opencode's own limits. */
export type WorkLimits = {
  /** Statements and expressions evaluated. */
  readonly maxSteps: number | undefined
  /** Characters of strings and elements of arrays, objects, Maps and Sets the program made. */
  readonly maxGrowth: number | undefined
}

/**
 * The work one program has done. This is Vivid's addition to opencode's interpreter
 * (`packages/codemode`), which bounds a program only by wall-clock time: it was written to run
 * for one person inside their own process. Vivid's server is one process for every Person, and
 * the interpreter runs in it. Measured 9 October 2026: a loop that appends a 1,000 character
 * string to an array grew the heap by 155 MB in three seconds, and a busy loop holds the
 * server's only thread for as long as its timeout allows. So a program is also bounded by what
 * it computes: the number of steps, and how much data it makes.
 *
 * The limit is a latch. Once passed, every later step fails again, so a `catch` or a `finally`
 * in the program cannot carry it on: the first thing the handler evaluates fails the same way.
 */
export class Work {
  private steps = 0
  private growth = 0
  private exceeded: string | undefined = undefined

  constructor(private readonly limits: WorkLimits) {}

  private fail(node: AstNode): never {
    throw new InterpreterRuntimeError(this.exceeded ?? "", node, "WorkLimitExceeded")
  }

  /** One statement or expression is about to be evaluated. */
  step(node: AstNode): void {
    if (this.exceeded !== undefined) this.fail(node)
    this.steps += 1
    if (this.limits.maxSteps !== undefined && this.steps > this.limits.maxSteps) {
      this.exceeded = `The program ran more than ${this.limits.maxSteps} steps. Do less in one program, or let a tool do the heavy work.`
      this.fail(node)
    }
  }

  /**
   * An expression made `value`. Only the value's own size is counted (a string's characters, a
   * container's direct members): what a container holds was counted when it was made.
   */
  grew(value: unknown, node: AstNode): void {
    const size =
      typeof value === "string"
        ? value.length
        : Array.isArray(value)
          ? value.length
          : value instanceof SandboxMap
            ? value.map.size
            : value instanceof SandboxSet
              ? value.set.size
              : 0
    if (size === 0) return
    this.growth += size
    if (this.limits.maxGrowth !== undefined && this.growth > this.limits.maxGrowth) {
      this.exceeded = `The program made more than ${this.limits.maxGrowth} characters and items of data. Keep less in memory: filter early and return only what is needed.`
      this.fail(node)
    }
  }
}
