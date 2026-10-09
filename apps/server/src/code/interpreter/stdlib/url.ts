/** Ported from opencode `packages/codemode/src/stdlib/url.ts` at 3884062 (MIT). */
import { Result } from 'effect'
export const urlProperties = new Set([
  'href',
  'origin',
  'protocol',
  'username',
  'password',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
])

export const urlWritableProperties = new Set([
  'href',
  'protocol',
  'username',
  'password',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
])

export const urlMethods = new Set(['toString', 'toJSON'])
export const urlStatics = new Set(['canParse', 'parse'])
export const urlSearchParamsMethods = new Set([
  'append',
  'delete',
  'get',
  'getAll',
  'has',
  'set',
  'sort',
  'forEach',
  'keys',
  'values',
  'entries',
  'toString',
])

export const uriArgument = (value: unknown, label: string): string =>
  coerceToString(boundedData(value, label))

/** The host's own conversion for each URI function a program may call. */
const uriFunctions: Record<UriFunction['name'], (value: string) => string> = {
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
}

/** Preserve native URI conversion while translating malformed input into a catchable URIError. */
export const invokeUriFunction = (
  ref: UriFunction,
  args: Array<unknown>,
  node: AstNode,
): string => {
  const value = uriArgument(args[0], `${ref.name} input`)
  return Result.match(
    Result.try(() => uriFunctions[ref.name](value)),
    {
      onSuccess: (result) => result,
      onFailure: (error) => {
        throw new InterpreterRuntimeError(
          `${ref.name} received malformed URI data: ${error instanceof Error ? error.message : String(error)}`,
          node,
        ).as('URIError')
      },
    },
  )
}

export const urlArgument = (value: unknown, label: string): string =>
  value instanceof SandboxURL ? value.url.href : uriArgument(value, label)

/** Use native URL validity rules and preserve canParse versus parse failure results. */
export const invokeURLStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  if (!urlStatics.has(name))
    throw new InterpreterRuntimeError(`URL.${name} is not available in a program.`, node)
  if (args.length === 0)
    throw new InterpreterRuntimeError(`URL.${name} requires a URL argument.`, node).as('TypeError')
  const input = urlArgument(args[0], `URL.${name} input`)
  const base = args[1] === undefined ? undefined : urlArgument(args[1], `URL.${name} base`)
  return Result.match(
    Result.try(() => {
      const url = new URL(input, base)
      return name === 'canParse' ? true : new SandboxURL(url)
    }),
    {
      onSuccess: (result) => result,
      onFailure: () => {
        return name === 'canParse' ? false : null
      },
    },
  )
}

/** Expose only supported string serialization of a confined URL. */
export const invokeURLMethod = (value: SandboxURL, name: string, node: AstNode): string => {
  if (name === 'toString' || name === 'toJSON') return value.url.href
  throw new InterpreterRuntimeError(`URL method '${name}' is not available in a program.`, node)
}
import { type AstNode, InterpreterRuntimeError, UriFunction } from '../model.ts'
import { SandboxURL } from '../values.ts'
import { boundedData, coerceToString } from './value.ts'
