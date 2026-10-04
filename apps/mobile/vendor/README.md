# Vendored libraries

Third-party source kept in the tree because it is not published to a registry. It is copied
unchanged, so its file and symbol names are the library's own, as they would be under
`node_modules`. Vivid's code imports each through its `index.ts` and nothing deeper.

| Directory | Library                | Source                                                                                                            | Commit                                     |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `beam`    | `border-beam-native`   | `github.com/Jakubantalik/Libraries.dev`, `packages/border-beam/ports/react-native/border-beam-native/src`         | `d06640864eb4adc2fe240f899a44ee6210779782` |
| `orb`     | `thinking-orbs-native` | `github.com/Jakubantalik/Libraries.dev`, `packages/thinking-orbs/ports/react-native/thinking-orbs-native/src`     | `d06640864eb4adc2fe240f899a44ee6210779782` |

Both are MIT, copyright Jakub Antalik; the notice is in [LICENSE](./LICENSE). They are the React
Native ports of `border-beam` and `thinking-orbs`, the packages the web app installs, and draw
with `@shopify/react-native-skia`. `orb` takes its geometry from the published
`thinking-orbs/engine`, the same code the web runs.

To update one, copy the upstream `src` over the directory and record the new commit here. Do not
edit the copies; a change Vivid needs goes in the component that uses them.
