/** Ported from opencode `packages/codemode/src/stdlib/json.ts` at 3884062 (MIT). */
import { Result } from 'effect'
import {
  type AstNode,
  ProgramFunction,
  InterpreterRuntimeError,
  supportedSyntaxMessage,
} from '../model.ts'
import { copyIn, copyOut } from '../tools.ts'

export const jsonStatics = new Set(['stringify', 'parse'])

/** Preserve native JSON syntax errors while copyIn and copyOut enforce the confined data boundary. */
export const invokeJsonMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  if (!jsonStatics.has(name))
    throw new InterpreterRuntimeError(`JSON.${name} is not available in a program.`, node)
  switch (name) {
    case 'stringify': {
      const replacer = args[1]
      if (Array.isArray(replacer) || replacer instanceof ProgramFunction) {
        throw new InterpreterRuntimeError(
          'JSON.stringify replacers are not supported in a program.',
          node,
          'UnsupportedSyntax',
          [supportedSyntaxMessage],
        )
      }
      const space = args[2]
      const indent = typeof space === 'number' || typeof space === 'string' ? space : undefined
      return JSON.stringify(copyOut(copyIn(args[0], 'JSON.stringify value')), null, indent)
    }
    case 'parse': {
      const text = args[0]
      if (typeof text !== 'string')
        throw new InterpreterRuntimeError('JSON.parse expects a string.', node)
      return Result.match(
        Result.try(() => {
          return copyIn(JSON.parse(text), 'JSON.parse result')
        }),
        {
          onSuccess: (value) => value,
          onFailure: (error) => {
            throw new InterpreterRuntimeError(
              `JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              node,
            ).as('SyntaxError')
          },
        },
      )
    }
  }
  throw new InterpreterRuntimeError(`JSON.${name} is not available in a program.`, node)
}
