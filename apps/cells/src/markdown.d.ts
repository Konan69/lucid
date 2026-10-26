/** A `.md` import is its text: `wrangler.jsonc` gives `**/*.md` the esbuild `Text` loader. */
declare module '*.md' {
  const text: string
  export default text
}
