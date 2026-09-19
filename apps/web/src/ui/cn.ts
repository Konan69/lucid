type ClassNamePart = string | false | null

/** Joins class-name fragments while ignoring absent conditional fragments. */
export function cn(...parts: readonly (ClassNamePart | void)[]): string {
  return parts.filter(Boolean).join(' ')
}
