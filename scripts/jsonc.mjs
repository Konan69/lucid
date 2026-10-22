import { parse, printParseErrorCode } from 'jsonc-parser'

export function parseJsonc(source, file) {
  const errors = []
  const value = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0)
    throw new Error(
      `${file}: invalid TypeScript config at offset ${errors[0].offset}: ${printParseErrorCode(errors[0].error)}`,
    )
  return value
}
