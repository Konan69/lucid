/** celld's Text module rule bundles the authored Markdown without filesystem access. */
declare module '*.md' {
  const source: string
  export default source
}

declare module '*.sql' {
  const source: string
  export default source
}
