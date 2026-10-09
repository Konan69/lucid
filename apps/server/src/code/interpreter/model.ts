/** Ported from opencode `packages/codemode/src/interpreter/model.ts` at 3884062 (MIT). */
import type { DiagnosticKind } from './program.ts'
import type { ToolRefusal } from './refusal.ts'
import type { ToolRuntimeError } from './tools.ts'
import type { SafeObject } from './tools.ts'
import type { SandboxURL } from './values.ts'

/** Closed failure set raised while evaluating a program or settling a host call. */
export type Raised = InterpreterRuntimeError | ToolRuntimeError | ToolRefusal | ProgramThrow

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
  readonly maxSteps: number | undefined
  readonly maxGrowth: number | undefined
}

export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: 'Program'
  body: Array<AstNode>
}

export type Binding = {
  mutable: boolean
  value: unknown
  initialized?: boolean
}

export type StatementResult =
  | { kind: 'none' }
  | { kind: 'value'; value: unknown }
  | { kind: 'return'; value: unknown }
  | { kind: 'break' }
  | { kind: 'continue' }

export type MemberReference = {
  target: SafeObject | Array<unknown> | SandboxURL
  key: string | number
}

export class ProgramFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
  ) {}
}

export class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

export class ComputedValue {
  constructor(readonly value: unknown) {}
}

export class PromiseNamespace {
  readonly name = 'Promise'
}

export type PromiseMethodName = 'all' | 'allSettled' | 'race' | 'resolve' | 'reject'

export class PromiseMethodReference {
  constructor(readonly name: PromiseMethodName) {}
}

export type GlobalNamespaceName =
  | 'Object'
  | 'Math'
  | 'JSON'
  | 'Array'
  | 'console'
  | 'Date'
  | 'RegExp'
  | 'Map'
  | 'Set'
  | 'URL'
  | 'URLSearchParams'

export class GlobalNamespace {
  constructor(readonly name: GlobalNamespaceName) {}
}

export class GlobalMethodReference {
  constructor(
    readonly namespace: GlobalNamespaceName | 'Number' | 'String',
    readonly name: string,
  ) {}
}

export class CoercionFunction {
  constructor(readonly name: 'Number' | 'String' | 'Boolean' | 'parseInt' | 'parseFloat') {}
}

export class UriFunction {
  constructor(
    readonly name: 'encodeURI' | 'encodeURIComponent' | 'decodeURI' | 'decodeURIComponent',
  ) {}
}

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class ErrorConstructorReference {
  constructor(readonly name: string) {}
}

export const OptionalShortCircuit: unique symbol = Symbol('program.optional-short-circuit')

export const supportedSyntaxMessage =
  'Supported orchestration syntax: tools.* calls (they return promises - resolve them with await), data literals, destructuring, optional chaining, template literals, conditionals, switch, loops (incl. for...of and for...in over object/array/tools keys), arrow functions, spread, try/catch, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods (incl. match/matchAll/replace/split with regular expressions), Date/RegExp/Map/Set/URL/URLSearchParams, URI encoding helpers, Object/Math/JSON helpers, captured console.log/warn/error/dir/table, and Promise.all/allSettled/race/resolve/reject over arrays mixing promises and plain values for parallel tool calls (promise chaining with .then/.catch is not supported - use await with try/catch).'

export class InterpreterRuntimeError extends Error {
  readonly node?: AstNode
  errorName: string = 'Error'

  constructor(
    message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = 'ExecutionFailure',
    readonly suggestions?: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = 'InterpreterRuntimeError'
    if (node) this.node = node
  }

  /** Retain the catch-visible built-in error name separately from the internal diagnostic class. */
  as(errorName: string): this {
    this.errorName = errorName
    return this
  }
}

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported in a program. ${supportedSyntaxMessage}`,
    node,
    'UnsupportedSyntax',
    [supportedSyntaxMessage],
  )

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Validate parser-node shape at the syntax boundary before typed evaluator access. */
export const asNode = (value: unknown, context: string): AstNode => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`)
  }
  return value as AstNode
}

/** Reject a malformed syntax field before an evaluator iterates it. */
export const getArray = (node: AstNode, key: string): Array<unknown> => {
  const value = node[key]
  if (!Array.isArray(value))
    throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node)
  return value
}

/** Reject a malformed syntax field before dispatch or binding resolution. */
export const getString = (node: AstNode, key: string): string => {
  const value = node[key]
  if (typeof value !== 'string')
    throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node)
  return value
}

/** Keep syntax flags boolean rather than accepting truthy malformed parser data. */
export const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key]
  if (typeof value !== 'boolean')
    throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node)
  return value
}

/** Preserve absent syntax children while validating every present child node. */
export const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  if (value === undefined || value === null) return undefined
  return asNode(value, key)
}

export const getNode = (node: AstNode, key: string): AstNode => asNode(node[key], key)

export const sourceLocation = (node: AstNode) => ({
  // acorn counts lines from 1 and columns from 0; the program text is parsed as written, so
  // only the column needs moving to the 1-based form a Person reads.
  line: node.loc?.start.line ?? 1,
  column: (node.loc?.start.column ?? 0) + 1,
})

/** Append human-readable positions only when the parser supplied a source location. */
export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return ''
  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}
