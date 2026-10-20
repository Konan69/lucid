// @flue/vite/dist/index.mjs:flue uses getUserExternals from
// dist/markdown-import-plugin-D-fQ3auE.mjs to externalize direct workspace dependencies.
// Their TypeScript exports contain .js specifiers that plain Node cannot resolve to .ts files.
// vite/dist/node/index.d.ts:Plugin.config permits this public post-config mutation; bundle only
// Vivid workspace sources for the image, retaining Flue's external third-party dependencies.
import { build } from 'vite'

await build({
  plugins: [
    {
      name: 'vivid-workspace',
      enforce: 'post',
      config(config) {
        const options = config.build.rolldownOptions
        // Flue lists the runtime's dependencies by exact name, so `effect` stays external while a
        // subpath such as `effect/Schema` (used by the bundled workspace sources) was inlined. That
        // put two copies of Effect in one process: a schema built by one copy and checked by the
        // other crashed at startup (`s.trim is not a function`). Keep every Effect subpath external.
        options.external = [
          ...options.external.filter((name) => !name.startsWith('@vivid/')),
          /^effect\//u,
        ]
        return { ssr: { noExternal: [/^@vivid\//] } }
      },
      // Rollup-compatible generateBundle sees the actual output imports, including dynamic ones.
      // Fail the build instead of shipping another image that asks bare Node to load workspace TS.
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue
          for (const name of [...output.imports, ...output.dynamicImports]) {
            if (name.startsWith('@vivid/') || /\.(?:[cm]?ts|tsx)$/u.test(name))
              this.error(`Production dependency was not compiled: ${name}`)
          }
          // A second, inlined copy of Effect is the failure the external rule above prevents.
          for (const id of output.moduleIds) {
            if (/node_modules\/effect\//u.test(id))
              this.error(`Effect was bundled beside its external copy: ${id}`)
          }
        }
        console.log('Vivid workspace bundle verified for bare Node')
      },
    },
  ],
})
